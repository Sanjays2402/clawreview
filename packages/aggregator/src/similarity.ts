/**
 * Cross-agent similarity merge.
 *
 * The primary `dedupFindings` pass collapses near-identical findings
 * within the same `(file, category)` cell. That works well when two
 * agents converge on the same issue inside the same category, but it
 * misses the common case where the security agent and the sql-injection
 * agent both flag the SAME line as a SQL injection — they emit it
 * under different `category` values (security vs sql-injection), so
 * the radius-based dedup leaves both.
 *
 * This second pass walks each `(file, line region)` cluster and merges
 * findings whose rationale text overlaps significantly. The winner is
 * picked the same way `dedupFindings` picks: higher severity, then
 * higher confidence. The loser's agent name is preserved on the
 * winner's `tags` so audit trails don't lose attribution.
 */
import { compareSeverity, type Finding } from '@clawreview/types';

export interface SimilarityMergeOptions {
  /** Lines distance to treat two findings as candidates for merging. */
  radius?: number;
  /**
   * Minimum lexical overlap (shared-words / shorter-word-count) of
   * normalised rationale text required to consider them duplicates.
   * Defaults to 0.55 — empirically high enough to avoid false merges
   * across categories like security/performance, low enough to catch
   * security/sql-injection paraphrases.
   */
  minOverlap?: number;
}

export interface SimilarityMergeResult {
  /** Surviving findings (one winner per merged cluster). */
  findings: Finding[];
  /**
   * Per-merge audit record. Empty when no merge fired. Surfacing this
   * lets the worker/CLI log "merged N cross-agent duplicates" the same
   * way severity-rules and calibration do.
   */
  merged: Array<{
    winner: string; // agent name
    losers: string[]; // agent names dropped
    file: string;
    startLine: number;
  }>;
}

export function similarityMerge(
  input: Finding[],
  opts: SimilarityMergeOptions = {},
): SimilarityMergeResult {
  const radius = opts.radius ?? 3;
  const minOverlap = opts.minOverlap ?? 0.55;

  const accepted: Finding[] = [];
  const merged: SimilarityMergeResult['merged'] = [];

  for (const f of input) {
    const idx = accepted.findIndex(
      (a) =>
        a.file === f.file &&
        Math.abs(a.startLine - f.startLine) <= radius &&
        overlap(a.rationale, f.rationale) >= minOverlap,
    );
    if (idx === -1) {
      accepted.push(f);
      continue;
    }
    const existing = accepted[idx]!;
    // Pick the winner: higher severity wins, ties broken by confidence.
    const winnerIsNew = preferOver(f, existing);
    const winner = winnerIsNew ? f : existing;
    const loser = winnerIsNew ? existing : f;
    // Carry attribution forward so the dashboard can show "found by
    // security + sql-injection" even though we kept one.
    const mergedAgents = uniq([
      ...(winner.tags ?? []),
      `merged-from:${loser.agent}`,
    ]);
    accepted[idx] = { ...winner, tags: mergedAgents };
    merged.push({
      winner: winner.agent,
      losers: [loser.agent],
      file: winner.file,
      startLine: winner.startLine,
    });
  }

  return { findings: accepted, merged };
}

function preferOver(a: Finding, b: Finding): boolean {
  const sev = compareSeverity(a.severity, b.severity);
  if (sev !== 0) return sev < 0;
  return a.confidence > b.confidence;
}

/**
 * Symmetric lexical overlap on rationale text. Normalises to lowercase
 * word tokens, returns shared-words / shorter-word-count. Empty strings
 * never overlap.
 *
 * The function is intentionally cheap so we can run it during every
 * aggregate() pass without dragging in an embedding library.
 */
export function overlap(a: string, b: string): number {
  const wa = normaliseWords(a);
  const wb = normaliseWords(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const setB = new Set(wb);
  let shared = 0;
  for (const w of wa) {
    if (setB.has(w)) shared += 1;
  }
  return shared / Math.min(wa.length, wb.length);
}

function normaliseWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length >= 3); // drop noise tokens like "a", "to", "of"
}

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
