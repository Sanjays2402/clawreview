/**
 * Per-author finding attribution.
 *
 * Many "who owns this PR's noise" conversations end in someone running
 * `git blame` by hand. This module wires the same answer into the
 * aggregator: given a set of findings AND a blame map keyed by
 * `<file>:<line>`, group the findings by the author who last touched
 * the line.
 *
 * The blame map is supplied externally so this module stays pure (no
 * git subprocess, no filesystem). The CLI ships a `buildBlameMap`
 * adapter that walks affected files and shells out once per file;
 * other callers (the server worker, dashboards) can swap in a cached
 * source. When a finding's line has no blame entry — common for
 * brand-new files or generated code — it is attributed to a sentinel
 * `'(unknown)'` bucket so callers can render it explicitly rather than
 * silently dropping it.
 */
import type { Finding, Severity } from '@clawreview/types';
import { SEVERITY_ORDER } from '@clawreview/types';

export interface BlameEntry {
  /** e.g. `Sanjay Singh` */
  authorName: string;
  /** e.g. `sanjay@example.com` */
  authorEmail: string;
}

export type BlameMap = Map<string, BlameEntry>;

export interface AuthorAttribution {
  authorName: string;
  authorEmail: string;
  /** Findings attributed to this author, in input order. */
  findings: Finding[];
  /** Total findings count = sum of severity buckets below. */
  total: number;
  /** Per-severity breakdown so dashboards can render a stacked bar. */
  bySeverity: Record<Severity, number>;
  /** Highest severity authored by this person, for ranking. */
  worstSeverity: Severity;
}

/** Sentinel used when a finding's line is not present in the blame map. */
export const UNKNOWN_AUTHOR_KEY = '(unknown)';
export const UNKNOWN_AUTHOR_EMAIL = '';

export interface AuthorBreakdownResult {
  /** Newest-first sorted attribution list: worst severity first, then count, then name. */
  authors: AuthorAttribution[];
  /** Findings with no blame entry, surfaced explicitly. */
  unknown: Finding[];
  /** Convenience total across all authors (excludes the unknown bucket). */
  attributed: number;
}

/**
 * Compose `<file>:<line>` keys exactly the same way `buildBlameMap`
 * does, so call sites can stay in sync.
 */
export function blameKey(file: string, line: number): string {
  return `${file}:${line}`;
}

/**
 * Group findings by the author who last touched the line. See module
 * docs for the contract and the unknown-author sentinel.
 */
export function attributeFindingsToAuthors(
  findings: Finding[],
  blame: BlameMap,
): AuthorBreakdownResult {
  const buckets = new Map<string, AuthorAttribution>();
  const unknown: Finding[] = [];

  for (const f of findings) {
    const key = blameKey(f.file, f.startLine);
    const entry = blame.get(key);
    if (!entry) {
      unknown.push(f);
      continue;
    }
    const bucketKey = `${entry.authorEmail.toLowerCase()}|${entry.authorName}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        authorName: entry.authorName,
        authorEmail: entry.authorEmail,
        findings: [],
        total: 0,
        bySeverity: { critical: 0, high: 0, medium: 0, low: 0, nit: 0 },
        worstSeverity: 'nit',
      };
      buckets.set(bucketKey, bucket);
    }
    bucket.findings.push(f);
    bucket.bySeverity[f.severity] += 1;
    bucket.total += 1;
    if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[bucket.worstSeverity]) {
      bucket.worstSeverity = f.severity;
    }
  }

  const authors = [...buckets.values()].sort((a, b) => {
    const sev = SEVERITY_ORDER[a.worstSeverity] - SEVERITY_ORDER[b.worstSeverity];
    if (sev !== 0) return sev;
    if (b.total !== a.total) return b.total - a.total;
    return a.authorName.localeCompare(b.authorName);
  });

  return {
    authors,
    unknown,
    attributed: authors.reduce((n, a) => n + a.total, 0),
  };
}

/**
 * Parse a single `git blame --line-porcelain <file>` body into a map of
 * line number -> BlameEntry. Exported as a pure function so unit tests
 * can drive it without spawning git.
 *
 * `git blame --line-porcelain` shape (per line of output):
 *
 *   <sha> <orig-line> <final-line> <group-size>?
 *   author <name>
 *   author-mail <<email>>
 *   author-time <unix>
 *   ...
 *   committer <name>
 *   ...
 *   \t<line content>
 *
 * The final-line field is the 1-based new-file line we care about; the
 * group header repeats whenever blame switches commits. We only care
 * about `author` + `author-mail` for attribution.
 */
export function parsePorcelainBlame(porcelain: string): Map<number, BlameEntry> {
  const out = new Map<number, BlameEntry>();
  const lines = porcelain.split('\n');
  let currentLine: number | null = null;
  let currentAuthor: string | null = null;
  let currentEmail: string | null = null;

  for (const line of lines) {
    if (/^[0-9a-f]{7,40} \d+ \d+/.test(line)) {
      // New header. Flush previous if it was complete.
      if (currentLine !== null && currentAuthor !== null) {
        out.set(currentLine, {
          authorName: currentAuthor,
          authorEmail: currentEmail ?? '',
        });
      }
      const parts = line.split(' ');
      // parts[0]=sha, parts[1]=orig-line, parts[2]=final-line, parts[3]?=group-size
      const finalLine = Number(parts[2]);
      currentLine = Number.isFinite(finalLine) ? finalLine : null;
      currentAuthor = null;
      currentEmail = null;
      continue;
    }
    if (line.startsWith('author ')) {
      currentAuthor = line.slice('author '.length);
    } else if (line.startsWith('author-mail ')) {
      const raw = line.slice('author-mail '.length).trim();
      // Strip surrounding angle brackets.
      currentEmail = raw.replace(/^<|>$/g, '');
    } else if (line.startsWith('\t')) {
      // Body line — flush the current header with what we have.
      if (currentLine !== null && currentAuthor !== null) {
        out.set(currentLine, {
          authorName: currentAuthor,
          authorEmail: currentEmail ?? '',
        });
      }
      currentLine = null;
      currentAuthor = null;
      currentEmail = null;
    }
  }
  return out;
}
