import type { Finding, Severity } from '@clawreview/types';

import { fingerprint } from './fingerprint.js';
import type { AggregateResult } from './aggregate.js';

/**
 * GitLab "Code Quality" report entry shape, as consumed by the GitLab CI
 * Code Quality widget. The spec is loosely defined by GitLab as a JSON array
 * of objects with: description, check_name, fingerprint, severity, and
 * location. Optional `categories` and `content` carry useful detail when
 * present.
 *
 * Reference: https://docs.gitlab.com/ee/ci/testing/code_quality.html#implement-a-custom-tool
 */
export interface GitlabCodeQualityIssue {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: GitlabSeverity;
  location: {
    path: string;
    lines: { begin: number; end?: number };
  };
  categories?: string[];
  content?: { body: string };
}

export type GitlabSeverity = 'info' | 'minor' | 'major' | 'critical' | 'blocker';

export interface GitlabCodeQualityOptions {
  /**
   * Override the severity mapping. Defaults to the conventional mapping
   * used by GitLab's reference tools (codeclimate, eslint).
   */
  severityMap?: Record<Severity, GitlabSeverity>;
}

const DEFAULT_SEVERITY_MAP: Record<Severity, GitlabSeverity> = {
  critical: 'blocker',
  high: 'critical',
  medium: 'major',
  low: 'minor',
  nit: 'info',
};

/**
 * Render an AggregateResult (or a bare findings list) as a GitLab Code
 * Quality report. The output is an array; GitLab expects to receive it as
 * the body of a JSON artifact named e.g. `gl-code-quality-report.json`.
 *
 * Why this lives next to toSarif/toJUnitXml: GitLab teams typically want a
 * single export step in CI, and standardising on a single canonical
 * implementation here means the CLI and the server (when we wire a future
 * /api/reviews/:id/gitlab endpoint) cannot drift.
 */
export function toGitlabCodeQuality(
  input: AggregateResult | Finding[],
  opts: GitlabCodeQualityOptions = {},
): GitlabCodeQualityIssue[] {
  const findings = Array.isArray(input) ? input : input.findings;
  const sevMap = { ...DEFAULT_SEVERITY_MAP, ...(opts.severityMap ?? {}) };
  return findings.map((f) => {
    const issue: GitlabCodeQualityIssue = {
      description: f.title,
      check_name: `${f.agent}.${f.category}`,
      fingerprint: fingerprint(f),
      severity: sevMap[f.severity],
      location: {
        path: f.file,
        lines: { begin: f.startLine, ...(f.endLine ? { end: f.endLine } : {}) },
      },
    };
    const categories = collectCategories(f);
    if (categories.length > 0) issue.categories = categories;
    if (f.rationale || f.cwe || f.suggested) {
      issue.content = { body: contentBody(f) };
    }
    return issue;
  });
}

function collectCategories(f: Finding): string[] {
  // GitLab's code-quality widget recognises a small set of canonical
  // categories; we conservatively forward only ones that map cleanly so
  // unknown categories do not pollute the widget's filter UI.
  const out: string[] = [];
  switch (f.category) {
    case 'security':
    case 'sql-injection':
    case 'secrets':
      out.push('Security');
      break;
    case 'performance':
      out.push('Performance');
      break;
    case 'accessibility':
      // GitLab has no first-class a11y category; fall back to Style.
      out.push('Style');
      break;
    case 'style':
    case 'maintainability':
      out.push('Style');
      break;
    case 'bug':
      out.push('Bug Risk');
      break;
    case 'other':
    default:
      // Leave categories absent rather than emit a meaningless label.
      break;
  }
  return out;
}

function contentBody(f: Finding): string {
  const parts: string[] = [];
  if (f.rationale) parts.push(f.rationale);
  if (f.cwe) parts.push(`Reference: ${f.cwe}`);
  if (f.suggested) {
    parts.push('');
    parts.push(`Suggested change: ${f.suggested.description}`);
    parts.push('```diff');
    parts.push(f.suggested.diff);
    parts.push('```');
  }
  return parts.join('\n');
}
