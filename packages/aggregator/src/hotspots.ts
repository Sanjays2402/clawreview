import {
  compareSeverity,
  SEVERITY_ORDER,
  type Finding,
  type Severity,
} from '@clawreview/types';

/**
 * A hotspot is a cluster of findings packed into a small line window in a
 * single file. The UI surfaces them above the per-file detail in the PR
 * comment so reviewers immediately see where the change is densest.
 */
export interface Hotspot {
  file: string;
  /** First line covered by the cluster (inclusive, new-file line numbers). */
  startLine: number;
  /** Last line covered by the cluster (inclusive). */
  endLine: number;
  /** Findings in the cluster, ordered by severity then startLine. */
  findings: Finding[];
  /** Highest severity in the cluster, useful for sorting. */
  topSeverity: Severity;
  /** Convenience count == findings.length. */
  count: number;
}

export interface HotspotOptions {
  /**
   * Maximum vertical distance (in new-file lines) between a finding and the
   * current cluster's end before the finding starts a new cluster.
   * Defaults to 10 — wide enough to merge a small helper function's
   * adjacent issues, narrow enough to keep unrelated regions apart.
   */
  windowLines?: number;
  /**
   * Minimum number of findings required to surface a cluster as a
   * hotspot. Defaults to 2 — a single finding is never a "hot spot".
   */
  minFindings?: number;
  /**
   * Optional cap on the number of returned hotspots, applied AFTER
   * sorting by importance. Defaults to no cap.
   */
  limit?: number;
}

/**
 * Group findings into (file, line-window) clusters.
 *
 * Algorithm:
 *   1. Bucket findings by file.
 *   2. Sort each bucket by startLine.
 *   3. Walk linearly, appending a finding to the current cluster when its
 *      startLine is within `windowLines` of the cluster's running endLine.
 *      Otherwise start a new cluster.
 *   4. Drop clusters with fewer than `minFindings`.
 *   5. Within each surviving cluster, sort findings by severity then
 *      startLine so the rendered output leads with the worst issue.
 *   6. Sort clusters globally by (count desc, top-severity asc, file asc,
 *      startLine asc) so reviewers see the densest, most severe blocks first.
 *
 * The algorithm is stable, O(n log n) overall, and never mutates the
 * input array.
 */
export function detectHotspots(findings: Finding[], opts: HotspotOptions = {}): Hotspot[] {
  const windowLines = Math.max(0, opts.windowLines ?? 10);
  const minFindings = Math.max(1, opts.minFindings ?? 2);

  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }

  const hotspots: Hotspot[] = [];
  for (const [file, list] of byFile) {
    const sorted = [...list].sort((a, b) => a.startLine - b.startLine);
    let current: Hotspot | null = null;
    for (const f of sorted) {
      const fEnd = f.endLine ?? f.startLine;
      if (current && f.startLine - current.endLine <= windowLines) {
        current.findings.push(f);
        if (fEnd > current.endLine) current.endLine = fEnd;
        if (compareSeverity(f.severity, current.topSeverity) < 0) {
          current.topSeverity = f.severity;
        }
        current.count += 1;
      } else {
        if (current && current.count >= minFindings) hotspots.push(current);
        current = {
          file,
          startLine: f.startLine,
          endLine: fEnd,
          findings: [f],
          topSeverity: f.severity,
          count: 1,
        };
      }
    }
    if (current && current.count >= minFindings) hotspots.push(current);
  }

  for (const h of hotspots) {
    h.findings.sort((a, b) => {
      const sev = compareSeverity(a.severity, b.severity);
      if (sev !== 0) return sev;
      return a.startLine - b.startLine;
    });
  }

  hotspots.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const sev = SEVERITY_ORDER[a.topSeverity] - SEVERITY_ORDER[b.topSeverity];
    if (sev !== 0) return sev;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.startLine - b.startLine;
  });

  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    return hotspots.slice(0, opts.limit);
  }
  return hotspots;
}

/**
 * Render a compact Markdown line for a single hotspot. Designed to live
 * inside the PR comment header so reviewers can jump straight to the
 * densest cluster.
 */
export function renderHotspotLine(h: Hotspot): string {
  const range = h.startLine === h.endLine ? `L${h.startLine}` : `L${h.startLine}-${h.endLine}`;
  return `\`${h.file}\` ${range} — ${h.count} finding${h.count === 1 ? '' : 's'} (top: ${h.topSeverity})`;
}
