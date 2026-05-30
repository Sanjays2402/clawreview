import { compareSeverity, type Finding, type Severity, SEVERITY_ORDER } from '@clawreview/types';

export interface AggregateOptions {
  threshold?: Severity;
  maxPerFile?: number;
  /** Lines distance to treat two findings as duplicates. */
  dedupRadius?: number;
}

export interface AggregateResult {
  findings: Finding[];
  groupedByFile: Array<{ file: string; findings: Finding[] }>;
  totals: Record<Severity, number>;
}

export function dedupFindings(input: Finding[], radius = 2): Finding[] {
  const seen: Finding[] = [];
  const accepted: Finding[] = [];
  for (const f of input) {
    const dupIdx = seen.findIndex(
      (s) =>
        s.file === f.file &&
        s.category === f.category &&
        Math.abs(s.startLine - f.startLine) <= radius &&
        similar(s.title, f.title),
    );
    if (dupIdx === -1) {
      seen.push(f);
      accepted.push(f);
      continue;
    }
    const existing = seen[dupIdx]!;
    if (preferOver(f, existing)) {
      seen[dupIdx] = f;
      const acceptedIdx = accepted.indexOf(existing);
      if (acceptedIdx >= 0) accepted[acceptedIdx] = f;
    }
  }
  return accepted;
}

function preferOver(a: Finding, b: Finding): boolean {
  const sev = compareSeverity(a.severity, b.severity);
  if (sev !== 0) return sev < 0;
  return a.confidence > b.confidence;
}

function similar(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;
  const wa = na.split(' ').filter(Boolean);
  const wb = nb.split(' ').filter(Boolean);
  const minWords = Math.min(wa.length, wb.length);
  if (minWords === 0) return false;
  const overlap = sharedWords(wa, wb);
  return overlap / minWords >= 0.6;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sharedWords(wa: string[], wb: string[]): number {
  const setB = new Set(wb);
  let hits = 0;
  for (const w of wa) if (setB.has(w)) hits += 1;
  return hits;
}

export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sev = compareSeverity(a.severity, b.severity);
    if (sev !== 0) return sev;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.startLine - b.startLine;
  });
}

export function aggregate(findings: Finding[], opts: AggregateOptions = {}): AggregateResult {
  const threshold = opts.threshold ?? 'low';
  const maxPerFile = opts.maxPerFile ?? 8;
  const radius = opts.dedupRadius ?? 2;

  const filtered = findings.filter(
    (f) => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[threshold],
  );
  const deduped = dedupFindings(filtered, radius);
  const ranked = rankFindings(deduped);

  const perFile = new Map<string, Finding[]>();
  for (const f of ranked) {
    const list = perFile.get(f.file) ?? [];
    if (list.length < maxPerFile) list.push(f);
    perFile.set(f.file, list);
  }

  const truncated = ranked.filter((f) => perFile.get(f.file)?.includes(f));

  const groupedByFile = [...perFile.entries()].map(([file, list]) => ({
    file,
    findings: list,
  }));

  const totals: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    nit: 0,
  };
  for (const f of truncated) totals[f.severity] += 1;

  return { findings: truncated, groupedByFile, totals };
}
