import type { DiffFile } from './types.js';

export type SkipReason =
  | 'binary'
  | 'no-hunks'
  | 'oversize-lines'
  | 'oversize-bytes'
  | 'generated-path'
  | 'generated-extension';

export interface SelectOptions {
  /**
   * Skip a file when the number of changed (added or removed) lines in its
   * patch exceeds this cap. Defaults to 1500. Large machine-generated diffs
   * (lockfiles, dist bundles, fixtures) overwhelm the model and rarely yield
   * useful findings.
   */
  maxChangedLines?: number;
  /**
   * Skip a file when its raw patch text exceeds this many bytes. Defaults
   * to 256 KiB. Acts as a backstop for files with very long lines that
   * pass the line-count cap.
   */
  maxPatchBytes?: number;
  /**
   * Disable the built-in generated-file detector. Useful when the caller
   * wants their own classification rules.
   */
  includeGenerated?: boolean;
}

export interface SkippedFile {
  path: string;
  reason: SkipReason;
  /** Human-readable detail (line count, byte size, matching rule). */
  detail?: string;
}

export interface SelectResult {
  files: DiffFile[];
  skipped: SkippedFile[];
}

const DEFAULTS: Required<Pick<SelectOptions, 'maxChangedLines' | 'maxPatchBytes'>> = {
  maxChangedLines: 1500,
  maxPatchBytes: 256 * 1024,
};

const GENERATED_PATH_RULES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /(^|\/)package-lock\.json$/, label: 'npm lockfile' },
  { re: /(^|\/)pnpm-lock\.yaml$/, label: 'pnpm lockfile' },
  { re: /(^|\/)yarn\.lock$/, label: 'yarn lockfile' },
  { re: /(^|\/)Cargo\.lock$/, label: 'cargo lockfile' },
  { re: /(^|\/)poetry\.lock$/, label: 'poetry lockfile' },
  { re: /(^|\/)Gemfile\.lock$/, label: 'bundler lockfile' },
  { re: /(^|\/)composer\.lock$/, label: 'composer lockfile' },
  { re: /(^|\/)go\.sum$/, label: 'go modules sum' },
  { re: /(^|\/)(dist|build|out|coverage)\//, label: 'build output directory' },
  { re: /(^|\/)node_modules\//, label: 'node_modules' },
  { re: /(^|\/)vendor\//, label: 'vendored dependencies' },
  { re: /(^|\/)__generated__\//, label: 'generated directory' },
];

const GENERATED_EXT_RULES: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\.min\.(js|css)$/, label: 'minified bundle' },
  { re: /\.map$/, label: 'source map' },
  { re: /\.snap$/, label: 'jest snapshot' },
  { re: /\.lock$/, label: 'lockfile' },
  { re: /\.pb\.(go|ts|js)$/, label: 'protobuf-generated' },
];

function countChangedLines(file: DiffFile): number {
  let n = 0;
  for (const h of file.hunks) {
    for (const line of h.body.split('\n')) {
      if (line.length === 0) continue;
      const c = line.charCodeAt(0);
      // 0x2B '+', 0x2D '-'. Ignore '+++' / '---' headers (shouldn't appear
      // inside hunk bodies, but be defensive).
      if ((c === 0x2b || c === 0x2d) && !line.startsWith('+++') && !line.startsWith('---')) {
        n += 1;
      }
    }
  }
  return n;
}

function classifyGenerated(path: string):
  | { reason: 'generated-path' | 'generated-extension'; detail: string }
  | null {
  for (const rule of GENERATED_PATH_RULES) {
    if (rule.re.test(path)) return { reason: 'generated-path', detail: rule.label };
  }
  for (const rule of GENERATED_EXT_RULES) {
    if (rule.re.test(path)) return { reason: 'generated-extension', detail: rule.label };
  }
  return null;
}

/**
 * Filter a parsed diff down to the set of files worth reviewing. Skipped
 * files come back in `skipped` with a reason and short detail string so the
 * worker can log them or surface them in the PR comment footer.
 */
export function selectReviewableFiles(files: DiffFile[], opts: SelectOptions = {}): SelectResult {
  const maxLines = opts.maxChangedLines ?? DEFAULTS.maxChangedLines;
  const maxBytes = opts.maxPatchBytes ?? DEFAULTS.maxPatchBytes;
  const checkGenerated = opts.includeGenerated !== true;

  const kept: DiffFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const f of files) {
    if (f.isBinary) {
      skipped.push({ path: f.path, reason: 'binary' });
      continue;
    }
    if (f.hunks.length === 0) {
      skipped.push({ path: f.path, reason: 'no-hunks' });
      continue;
    }
    if (checkGenerated) {
      const g = classifyGenerated(f.path);
      if (g) {
        skipped.push({ path: f.path, reason: g.reason, detail: g.detail });
        continue;
      }
    }
    const bytes = f.raw.length;
    if (bytes > maxBytes) {
      skipped.push({
        path: f.path,
        reason: 'oversize-bytes',
        detail: `${bytes} bytes > ${maxBytes}`,
      });
      continue;
    }
    const changed = countChangedLines(f);
    if (changed > maxLines) {
      skipped.push({
        path: f.path,
        reason: 'oversize-lines',
        detail: `${changed} changed lines > ${maxLines}`,
      });
      continue;
    }
    kept.push(f);
  }

  return { files: kept, skipped };
}
