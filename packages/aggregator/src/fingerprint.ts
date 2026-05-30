import { createHash } from 'node:crypto';

import type { Finding } from '@clawreview/types';

/**
 * Stable content fingerprint for a finding.
 *
 * The fingerprint is intentionally insensitive to line movement (we round
 * the line number to the nearest 10) and prose differences in rationale
 * (we use a normalized title plus a coarse rationale hash). It IS sensitive
 * to: producing agent, category, severity, file path, and the rough region
 * of the file the finding lives in.
 *
 * This is what lets the server:
 *   - Recognize "the same finding" across re-runs of a PR after a force push.
 *   - Auto-suppress findings that a reviewer dismissed in a prior review.
 *   - Compute "new vs known" delta counts against a baseline.
 */
export function fingerprint(f: Finding): string {
  const region = Math.floor(Math.max(1, f.startLine) / 10);
  const titleNorm = normalize(f.title);
  const rationaleHash = sha1(normalize(f.rationale)).slice(0, 8);
  const parts = [
    f.agent,
    f.category,
    f.severity,
    f.file,
    `r${region}`,
    titleNorm,
    rationaleHash,
  ].join('\u0001');
  return sha1(parts).slice(0, 16);
}

/**
 * Index a set of findings by fingerprint. Later entries overwrite earlier
 * ones, so callers passing both "open" and "dismissed" lists should pass
 * the canonical/winning state last.
 */
export function indexByFingerprint<T extends Finding>(findings: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const f of findings) {
    map.set(fingerprint(f), f);
  }
  return map;
}

export interface BaselineDelta {
  /** Findings present in current that were not in baseline. */
  added: Finding[];
  /** Findings present in baseline that are no longer in current. */
  removed: Finding[];
  /** Findings present in both (matched by fingerprint). */
  unchanged: Finding[];
}

/**
 * Compute the add/remove/unchanged delta between a baseline set of
 * findings and the current run's findings.
 */
export function diffAgainstBaseline(current: Finding[], baseline: Finding[]): BaselineDelta {
  const currentMap = indexByFingerprint(current);
  const baselineMap = indexByFingerprint(baseline);

  const added: Finding[] = [];
  const unchanged: Finding[] = [];
  for (const [fp, f] of currentMap) {
    if (baselineMap.has(fp)) unchanged.push(f);
    else added.push(f);
  }
  const removed: Finding[] = [];
  for (const [fp, f] of baselineMap) {
    if (!currentMap.has(fp)) removed.push(f);
  }
  return { added, removed, unchanged };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
