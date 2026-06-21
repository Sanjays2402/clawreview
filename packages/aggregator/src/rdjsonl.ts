import type { Finding, Severity } from '@clawreview/types';

import type { AggregateResult } from './aggregate.js';
import { fingerprint } from './fingerprint.js';

/**
 * Reviewdog "rdjsonl" diagnostic, as documented in
 * https://github.com/reviewdog/reviewdog/blob/master/proto/rdf/jsonschema/Diagnostic.jsonschema.
 *
 * Each diagnostic is a single JSON object on its own line. Reviewdog accepts
 * the stream over stdin via `reviewdog -f rdjsonl`.
 *
 * The schema is intentionally narrow: a message, a source name, a location
 * with file + range, a severity enum, and an optional suggestion. We map
 * ClawReview's richer Finding shape down to this so reviewdog can attach the
 * results as PR comments, GitHub check annotations, or local terminal output
 * depending on the reporter the user picks.
 */
export interface RdjsonlDiagnostic {
  message: string;
  /** Tool-defined short identifier; we use `<agent>.<category>`. */
  code?: { value: string; url?: string };
  /** Reviewdog requires this to be one of its 4 levels (uppercase). */
  severity?: RdjsonlSeverity;
  /** Stable fingerprint to let reviewdog dedupe across re-runs. */
  source?: { name: string; url?: string };
  location: {
    path: string;
    range: {
      start: { line: number; column?: number };
      end?: { line: number; column?: number };
    };
  };
  /**
   * Optional code suggestions. Reviewdog renders these as GitHub
   * suggested-change blocks in PR review comments.
   */
  suggestions?: Array<{
    range: {
      start: { line: number; column?: number };
      end?: { line: number; column?: number };
    };
    text: string;
  }>;
  /**
   * Extra metadata reviewdog passes through verbatim. Useful for
   * downstream filters (e.g. `reviewdog -filter-mode=added`) to scope
   * by agent or confidence without re-parsing rationale text.
   */
  original_output?: string;
}

export type RdjsonlSeverity = 'UNKNOWN_SEVERITY' | 'ERROR' | 'WARNING' | 'INFO';

export interface RdjsonlOptions {
  /** Name surfaced in reviewdog's `source.name`. Defaults to `clawreview`. */
  sourceName?: string;
  /** URL surfaced in `source.url`. Defaults to the public repo. */
  sourceUrl?: string;
  /**
   * Optional URL template per rule. Same shape as the SARIF `helpUriFor`
   * hook, so callers can share a single resolver between exports.
   */
  codeUrlFor?: (info: { ruleId: string; agent: string; category: string }) => string | undefined;
}

const DEFAULT_SOURCE_NAME = 'clawreview';
const DEFAULT_SOURCE_URL = 'https://github.com/Sanjays2402/clawreview';

const SEVERITY_MAP: Record<Severity, RdjsonlSeverity> = {
  critical: 'ERROR',
  high: 'ERROR',
  medium: 'WARNING',
  low: 'WARNING',
  nit: 'INFO',
};

/**
 * Render an AggregateResult (or a bare findings array) as a reviewdog
 * `rdjsonl` payload. Returns a single string with one JSON diagnostic per
 * line and a trailing newline, so the result can be written directly to
 * `reviewdog -f rdjsonl`'s stdin.
 */
export function toRdjsonl(
  input: AggregateResult | Finding[],
  opts: RdjsonlOptions = {},
): string {
  const diagnostics = toRdjsonlDiagnostics(input, opts);
  if (diagnostics.length === 0) return '';
  return diagnostics.map((d) => JSON.stringify(d)).join('\n') + '\n';
}

/**
 * Same as `toRdjsonl` but returns the diagnostic objects directly. Useful
 * when a caller wants to filter or transform before serialising.
 */
export function toRdjsonlDiagnostics(
  input: AggregateResult | Finding[],
  opts: RdjsonlOptions = {},
): RdjsonlDiagnostic[] {
  const findings = Array.isArray(input) ? input : input.findings;
  const sourceName = opts.sourceName ?? DEFAULT_SOURCE_NAME;
  const sourceUrl = opts.sourceUrl ?? DEFAULT_SOURCE_URL;

  return findings.map((f) => {
    const ruleId = `${f.agent}.${f.category}`;
    const endLine = f.endLine ?? f.startLine;
    const diag: RdjsonlDiagnostic = {
      message: messageText(f),
      severity: SEVERITY_MAP[f.severity],
      source: { name: sourceName, url: sourceUrl },
      location: {
        path: f.file,
        range: {
          start: { line: f.startLine },
          end: { line: endLine },
        },
      },
      // We always carry the fingerprint in `original_output` so reviewers
      // can dedupe without parsing the rendered message body.
      original_output: fingerprint(f),
    };
    const codeUrl = opts.codeUrlFor?.({ ruleId, agent: f.agent, category: f.category });
    diag.code = codeUrl ? { value: ruleId, url: codeUrl } : { value: ruleId };
    if (f.suggested) {
      diag.suggestions = [
        {
          range: {
            start: { line: f.startLine },
            end: { line: endLine },
          },
          text: f.suggested.diff,
        },
      ];
    }
    return diag;
  });
}

function messageText(f: Finding): string {
  // Reviewdog renders the message verbatim. Lead with the title so PR
  // comments scan cleanly; trail with the rationale and (optionally) a
  // CWE reference so the diagnostic stands on its own without clicking
  // through to the code-url.
  const parts: string[] = [f.title];
  if (f.rationale) parts.push(f.rationale);
  if (f.cwe) parts.push(`Reference: ${f.cwe}`);
  return parts.join('\n\n');
}
