import type { Finding, Severity } from '@clawreview/types';

import type { AggregateResult } from './aggregate.js';

export interface JUnitOptions {
  /** Suite name shown in CI dashboards. Defaults to "clawreview". */
  suiteName?: string;
  /** Severities that should produce <failure> elements (vs <skipped>). */
  failOn?: Severity[];
  /** Optional timestamp (ISO) recorded on the suite. */
  timestamp?: string;
  /** Optional hostname recorded on the suite. */
  hostname?: string;
}

const DEFAULT_FAIL_ON: Severity[] = ['critical', 'high'];

/**
 * Render an AggregateResult (or a bare findings list) as JUnit XML.
 *
 * Most CI systems (Jenkins, GitLab, CircleCI, Buildkite, Azure Pipelines,
 * GitHub Actions via reporters) consume JUnit XML to display test failures
 * inline. This export lets clawreview surface findings as "test cases" so
 * they show up natively in those UIs without needing a SARIF integration.
 *
 * Findings whose severity is in `failOn` become <failure>; everything else
 * becomes <skipped>, which keeps low-severity noise out of the red counters
 * while still preserving the full record.
 */
export function toJUnitXml(
  input: AggregateResult | Finding[],
  opts: JUnitOptions = {},
): string {
  const findings = Array.isArray(input) ? input : input.findings;
  const suiteName = opts.suiteName ?? 'clawreview';
  const failOn = new Set(opts.failOn ?? DEFAULT_FAIL_ON);
  const timestamp = opts.timestamp ?? new Date().toISOString();

  const cases = findings.map((f) => {
    const isFail = failOn.has(f.severity);
    const classname = `${f.agent}.${f.category}`;
    const name = `${f.file}:${f.startLine} ${f.title}`;
    if (isFail) {
      const msg = `${f.severity.toUpperCase()}: ${f.title}`;
      return [
        `    <testcase classname="${esc(classname)}" name="${esc(name)}" time="0">`,
        `      <failure message="${esc(msg)}" type="${esc(f.severity)}"><![CDATA[${cdata(
          f.rationale,
        )}]]></failure>`,
        `    </testcase>`,
      ].join('\n');
    }
    return [
      `    <testcase classname="${esc(classname)}" name="${esc(name)}" time="0">`,
      `      <skipped message="${esc(f.severity)}"/>`,
      `    </testcase>`,
    ].join('\n');
  });

  const failures = findings.filter((f) => failOn.has(f.severity)).length;
  const skipped = findings.length - failures;

  const header = '<?xml version="1.0" encoding="UTF-8"?>';
  const hostAttr = opts.hostname ? ` hostname="${esc(opts.hostname)}"` : '';
  const suiteOpen = [
    `<testsuites name="${esc(suiteName)}" tests="${findings.length}" failures="${failures}" skipped="${skipped}" errors="0" time="0">`,
    `  <testsuite name="${esc(suiteName)}" tests="${findings.length}" failures="${failures}" skipped="${skipped}" errors="0" time="0" timestamp="${esc(timestamp)}"${hostAttr}>`,
  ].join('\n');

  const body = cases.length > 0 ? `\n${cases.join('\n')}\n  ` : '';
  return `${header}\n${suiteOpen}${body}</testsuite>\n</testsuites>\n`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(s: string): string {
  // CDATA cannot contain "]]>"; split it across two sections.
  return s.replace(/]]>/g, ']]]]><![CDATA[>');
}
