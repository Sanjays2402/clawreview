import type { Finding } from '@clawreview/types';

import { fingerprint } from './fingerprint.js';
import type { AggregateResult } from './aggregate.js';

export interface CsvOptions {
  /** Include a header row. Default true. */
  header?: boolean;
  /** Optional list of columns; defaults to DEFAULT_COLUMNS in order. */
  columns?: CsvColumn[];
}

export const DEFAULT_COLUMNS = [
  'fingerprint',
  'agent',
  'category',
  'severity',
  'confidence',
  'file',
  'startLine',
  'endLine',
  'title',
  'rationale',
  'cwe',
  'tags',
] as const;

export type CsvColumn = (typeof DEFAULT_COLUMNS)[number];

/**
 * Render findings as RFC 4180 CSV.
 *
 * Spreadsheet tools and BI pipelines consume CSV natively, so this gives
 * teams a quick way to slice findings outside the dashboard (pivot tables
 * by file, severity histograms, ownership joins). The fingerprint column
 * lets two CSV exports be diffed for delta reporting without re-running
 * the aggregator.
 */
export function toCsv(
  input: AggregateResult | Finding[],
  opts: CsvOptions = {},
): string {
  const findings = Array.isArray(input) ? input : input.findings;
  const columns = opts.columns ?? [...DEFAULT_COLUMNS];
  const includeHeader = opts.header !== false;

  const rows: string[] = [];
  if (includeHeader) rows.push(columns.join(','));

  for (const f of findings) {
    rows.push(columns.map((c) => cell(c, f)).join(','));
  }
  // RFC 4180 specifies CRLF line endings.
  return rows.join('\r\n') + (rows.length ? '\r\n' : '');
}

function cell(col: CsvColumn, f: Finding): string {
  switch (col) {
    case 'fingerprint':
      return esc(fingerprint(f));
    case 'tags':
      return esc((f.tags ?? []).join('|'));
    case 'endLine':
      return esc(String(f.endLine ?? f.startLine));
    case 'cwe':
      return esc(f.cwe ?? '');
    case 'confidence':
      return esc(String(f.confidence ?? ''));
    case 'startLine':
      return esc(String(f.startLine));
    default:
      return esc(String(f[col] ?? ''));
  }
}

function esc(v: string): string {
  if (v === '') return '';
  // Quote if value contains quote, comma, CR, or LF; double internal quotes.
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
