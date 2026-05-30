import type { Finding } from '@clawreview/types';
import { SEVERITY_LABELS } from '@clawreview/types';
import { parseUnifiedDiff } from '@clawreview/diff';

const SEV_EMOJI: Record<Finding['severity'], string> = {
  critical: '🛑',
  high: '🔺',
  medium: '🟠',
  low: '🟡',
  nit: '🔹',
};

export interface InlineComment {
  path: string;
  line: number;
  body: string;
  startLine?: number;
}

export interface BuildInlineCommentsOptions {
  /** Skip findings below this severity. Default: 'low'. */
  minSeverity?: Finding['severity'];
  /** Maximum number of inline comments to return. Default: 30. */
  max?: number;
}

const SEV_ORDER: Record<Finding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
};

/**
 * Returns the set of (file, line) pairs that GitHub will accept for an inline
 * review comment, derived from the patch added/context lines in the head diff.
 *
 * Inline comments can only anchor on a line that appears as an added (+) or
 * context ( ) line in one of the hunks. Removed lines (-) belong to the base
 * commit and are addressed via startLine + side='LEFT' which we don't support
 * here.
 */
export function commentableLines(diffText: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const parsed = parseUnifiedDiff(diffText);
  for (const file of parsed.files) {
    if (file.isBinary || file.status === 'deleted' || !file.path) continue;
    const set: Set<number> = out.get(file.path) ?? new Set<number>();
    for (const hunk of file.hunks) {
      let lineNo = hunk.newStart;
      const body = hunk.body.split('\n');
      for (const bl of body) {
        if (bl.startsWith('+')) {
          set.add(lineNo);
          lineNo += 1;
        } else if (bl.startsWith(' ')) {
          set.add(lineNo);
          lineNo += 1;
        } else if (bl.startsWith('-')) {
          // Removed lines don't advance the new-side line counter.
        } else {
          // metadata like "\ No newline at end of file" — ignore.
        }
      }
    }
    if (set.size > 0) out.set(file.path, set);
  }
  return out;
}

/**
 * Filters findings down to ones whose start line lands inside the diff patch
 * and renders each as an inline review comment body. Findings without a valid
 * anchor are dropped (the caller should still include them in the summary
 * comment).
 */
export function buildInlineComments(
  findings: Finding[],
  diffText: string,
  opts: BuildInlineCommentsOptions = {},
): { anchored: InlineComment[]; unanchored: Finding[] } {
  const min = opts.minSeverity ?? 'low';
  const max = opts.max ?? 30;
  const cutoff = SEV_ORDER[min];
  const commentable = commentableLines(diffText);
  const anchored: InlineComment[] = [];
  const unanchored: Finding[] = [];

  for (const f of findings) {
    if (SEV_ORDER[f.severity] > cutoff) continue;
    const set = commentable.get(f.file);
    if (!set || !set.has(f.startLine)) {
      unanchored.push(f);
      continue;
    }
    anchored.push({
      path: f.file,
      line: f.startLine,
      body: renderInlineBody(f),
    });
    if (anchored.length >= max) break;
  }
  return { anchored, unanchored };
}

function renderInlineBody(f: Finding): string {
  const head = `**${SEV_EMOJI[f.severity]} ${SEVERITY_LABELS[f.severity]} · ${f.category}** (${f.agent})`;
  const parts = [head, '', f.title, '', f.rationale];
  if (f.cwe) parts.push('', `Reference: ${f.cwe}`);
  if (f.suggested) {
    parts.push('', `_Suggested change: ${f.suggested.description}_`);
    parts.push('```suggestion', f.suggested.diff, '```');
  }
  return parts.join('\n');
}
