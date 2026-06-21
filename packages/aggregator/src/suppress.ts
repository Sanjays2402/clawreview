import type { Finding } from '@clawreview/types';
import { parseUnifiedDiff } from '@clawreview/diff';

/**
 * Inline suppression markers, looked for on added (`+`) lines in the diff.
 *
 * - `clawreview-ignore`                  suppresses findings on the same line
 * - `clawreview-ignore-next-line`        suppresses findings on the next added line
 * - `clawreview-ignore-line`             alias of same-line
 * - `clawreview-disable-file`            suppresses every finding in the entire
 *                                        new-file path the marker appears in
 *
 * Optional rule scoping:
 *
 *   // clawreview-ignore                   suppress any finding on this line
 *   // clawreview-ignore: security         suppress only the security agent
 *   // clawreview-ignore: security,sql-injection
 *   // clawreview-ignore-next-line: secrets
 *   // clawreview-disable-file: style      suppress all style findings in this file
 *
 * Rules are matched case-insensitively against either the finding's `agent`
 * or its `category`. File-level suppressions are useful for whole-file
 * exclusions (vendored copies, generated stubs, large data fixtures) without
 * touching .clawreviewignore.
 */
const SAME_LINE_RE = /clawreview-ignore(?:-line)?(?:\s*:\s*([A-Za-z0-9_,\-\s]+))?\b/;
const NEXT_LINE_RE = /clawreview-ignore-next-line(?:\s*:\s*([A-Za-z0-9_,\-\s]+))?\b/;
const FILE_LEVEL_RE = /clawreview-disable-file(?:\s*:\s*([A-Za-z0-9_,\-\s]+))?\b/;

export interface Suppression {
  /** Rule names to suppress; empty set means "all rules on this line". */
  rules: Set<string>;
}

export interface SuppressionMap {
  /** Map<file, Map<lineNumber, Suppression>> using new-file line numbers. */
  byFile: Map<string, Map<number, Suppression>>;
  /**
   * Files whose entire contents are suppressed by a `clawreview-disable-file`
   * marker. Value is the rule scope (empty set = "all rules"). When a file
   * has multiple markers their scopes merge; an unscoped marker widens to
   * "all rules" the same way line-level merges do.
   */
  fileLevel: Map<string, Suppression>;
}

function parseRules(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Walk every hunk in the diff. For each added line, record:
 *   - a file-level suppression if the line matches FILE_LEVEL_RE
 *   - a same-line suppression if the line itself matches SAME_LINE_RE
 *   - a next-line suppression for the *next added line* if NEXT_LINE_RE matches
 *
 * File-level matches take precedence over per-line matches at evaluation
 * time but recording them here is independent — the same diff might contain
 * both a `clawreview-disable-file` header comment and per-line markers, and
 * an exporter may want to surface that detail.
 *
 * Context lines (` `) and deleted lines (`-`) are skipped for next-line accounting,
 * which matches how developers actually annotate code in PRs.
 */
export function buildSuppressionMap(diffText: string): SuppressionMap {
  const parsed = parseUnifiedDiff(diffText);
  const byFile = new Map<string, Map<number, Suppression>>();
  const fileLevel = new Map<string, Suppression>();

  for (const file of parsed.files) {
    if (file.isBinary || file.hunks.length === 0) continue;
    const path = file.newPath ?? file.path;
    if (!path) continue;
    const fileMap = byFile.get(path) ?? new Map<number, Suppression>();

    for (const hunk of file.hunks) {
      let newLine = hunk.newStart;
      let pendingNext: Set<string> | null = null;
      const lines = hunk.body.split('\n');

      for (const raw of lines) {
        if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
        const marker = raw[0];
        const content = raw.slice(1);

        if (marker === '+') {
          // File-level marker has the widest scope; record it first so a
          // single line carrying both a file-level and a line-level marker
          // still sets up the file-level entry. The line-level marker can
          // then still apply (useful for layered allowlists).
          const fileMatch = FILE_LEVEL_RE.exec(content);
          if (fileMatch) {
            mergeFileLevel(fileLevel, path, parseRules(fileMatch[1]));
          }

          // First, consume any pending next-line suppression for this added line.
          if (pendingNext) {
            mergeSuppression(fileMap, newLine, pendingNext);
            pendingNext = null;
          }

          const nextMatch = NEXT_LINE_RE.exec(content);
          if (nextMatch) {
            pendingNext = parseRules(nextMatch[1]);
          } else if (!fileMatch) {
            // Avoid double-counting a file-level marker as a same-line
            // suppression: every "disable-file" line also matches the
            // "ignore" prefix, and that would silently widen the per-line
            // map without intent.
            const sameMatch = SAME_LINE_RE.exec(content);
            if (sameMatch) {
              mergeSuppression(fileMap, newLine, parseRules(sameMatch[1]));
            }
          }
          newLine += 1;
        } else if (marker === ' ') {
          // Context line. A pending next-line suppression should still apply
          // to the next *added* line, not to context, so do not consume it.
          newLine += 1;
        }
        // marker === '-' : deleted line, no new-file line number advance.
      }
    }

    if (fileMap.size > 0) byFile.set(path, fileMap);
  }

  return { byFile, fileLevel };
}

function mergeSuppression(
  fileMap: Map<number, Suppression>,
  line: number,
  rules: Set<string>,
): void {
  const existing = fileMap.get(line);
  if (!existing) {
    fileMap.set(line, { rules: new Set(rules) });
    return;
  }
  // If either side is "all rules" (empty set), the merged result is also "all".
  if (existing.rules.size === 0 || rules.size === 0) {
    existing.rules = new Set();
    return;
  }
  for (const r of rules) existing.rules.add(r);
}

function mergeFileLevel(
  fileLevel: Map<string, Suppression>,
  path: string,
  rules: Set<string>,
): void {
  const existing = fileLevel.get(path);
  if (!existing) {
    fileLevel.set(path, { rules: new Set(rules) });
    return;
  }
  if (existing.rules.size === 0 || rules.size === 0) {
    existing.rules = new Set();
    return;
  }
  for (const r of rules) existing.rules.add(r);
}

export interface SuppressionResult {
  kept: Finding[];
  suppressed: Finding[];
}

/**
 * Drop findings whose new-file line is covered by an inline suppression for
 * the matching agent or category (or "all rules" when no scope was given).
 *
 * A finding that spans multiple lines is considered suppressed only if its
 * entire [startLine, endLine] range is covered, so a marker on one line does
 * not silently hide a multi-line issue. File-level markers shortcut this
 * check: any finding in a file with a matching file-level marker is dropped
 * regardless of its lines.
 */
export function applySuppressions(
  findings: Finding[],
  map: SuppressionMap,
): SuppressionResult {
  const kept: Finding[] = [];
  const suppressed: Finding[] = [];

  for (const f of findings) {
    const fileSup = map.fileLevel.get(f.file);
    if (fileSup && matchesScope(f, fileSup.rules)) {
      suppressed.push(f);
      continue;
    }
    const fileMap = map.byFile.get(f.file);
    if (!fileMap) {
      kept.push(f);
      continue;
    }
    const start = f.startLine;
    const end = f.endLine ?? f.startLine;
    let coveredAll = true;
    for (let ln = start; ln <= end; ln += 1) {
      const sup = fileMap.get(ln);
      if (!sup) {
        coveredAll = false;
        break;
      }
      if (!matchesScope(f, sup.rules)) {
        coveredAll = false;
        break;
      }
    }
    if (coveredAll) suppressed.push(f);
    else kept.push(f);
  }

  return { kept, suppressed };
}

function matchesScope(f: Finding, rules: Set<string>): boolean {
  if (rules.size === 0) return true; // "all rules"
  const agent = f.agent.toLowerCase();
  const category = String(f.category).toLowerCase();
  return rules.has(agent) || rules.has(category);
}
