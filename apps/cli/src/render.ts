import kleur from 'kleur';
import type { Finding, Severity } from '@clawreview/types';
import { SEVERITY_LABELS } from '@clawreview/types';

import type { AggregateResult } from '@clawreview/aggregator';

const COLOR_BY_SEV: Record<Severity, (s: string) => string> = {
  critical: (s) => kleur.bgRed().white().bold(s),
  high: (s) => kleur.red().bold(s),
  medium: (s) => kleur.yellow().bold(s),
  low: (s) => kleur.cyan(s),
  nit: (s) => kleur.gray(s),
};

export function renderTextReport(result: AggregateResult, opts: { noColor?: boolean } = {}): string {
  if (opts.noColor) kleur.enabled = false;
  const lines: string[] = [];
  const total = Object.values(result.totals).reduce((a, b) => a + b, 0);

  lines.push(kleur.bold('ClawReview'));
  if (total === 0) {
    lines.push(kleur.green('  No findings above the configured threshold.'));
    return lines.join('\n');
  }

  const summary = (Object.keys(result.totals) as Severity[])
    .filter((s) => result.totals[s] > 0)
    .map((s) => `${COLOR_BY_SEV[s](` ${SEVERITY_LABELS[s]} `)} ${result.totals[s]}`)
    .join('  ');
  lines.push(`  ${summary}`);
  lines.push('');

  for (const group of result.groupedByFile) {
    lines.push(kleur.bold().underline(group.file));
    for (const f of group.findings) lines.push(renderFinding(f));
    lines.push('');
  }
  return lines.join('\n');
}

function renderFinding(f: Finding): string {
  const sev = COLOR_BY_SEV[f.severity](` ${SEVERITY_LABELS[f.severity]} `);
  const head = `  ${sev} ${kleur.gray(`${f.category} · ${f.agent}`)} ${kleur.bold(f.title)}`;
  const loc = kleur.gray(`  ${f.file}:${f.startLine}${f.endLine ? `-${f.endLine}` : ''}`);
  const why = `  ${f.rationale}`;
  const lines = [head, loc, why];
  if (f.cwe) lines.push(kleur.gray(`  ref: ${f.cwe}`));
  if (f.suggested) {
    lines.push(kleur.gray(`  suggested: ${f.suggested.description}`));
    lines.push(kleur.gray(indent(f.suggested.diff, 4)));
  }
  return lines.join('\n');
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n);
  return s.split('\n').map((l) => pad + l).join('\n');
}
