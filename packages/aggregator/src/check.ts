import type { Severity } from '@clawreview/types';

import type { AggregateResult } from './aggregate.js';

export type CheckConclusion =
  | 'success'
  | 'neutral'
  | 'action_required'
  | 'failure';

export interface CheckRunPayload {
  name: string;
  status: 'completed';
  conclusion: CheckConclusion;
  output: { title: string; summary: string };
}

const CONCLUSION_FOR: Record<Severity, CheckConclusion> = {
  critical: 'failure',
  high: 'action_required',
  medium: 'neutral',
  low: 'neutral',
  nit: 'success',
};

export function deriveCheckRun(result: AggregateResult, headSha: string): CheckRunPayload {
  const ordered: Severity[] = ['critical', 'high', 'medium', 'low', 'nit'];
  let conclusion: CheckConclusion = 'success';
  for (const sev of ordered) {
    if (result.totals[sev] > 0) {
      conclusion = CONCLUSION_FOR[sev];
      break;
    }
  }

  const total = Object.values(result.totals).reduce((a, b) => a + b, 0);
  const title = total === 0 ? 'No findings' : `${total} finding${total === 1 ? '' : 's'}`;
  const summary = ordered
    .filter((s) => result.totals[s] > 0)
    .map((s) => `- ${result.totals[s]} ${s}`)
    .join('\n') || 'Clean review.';

  return {
    name: `ClawReview / ${headSha.slice(0, 7)}`,
    status: 'completed',
    conclusion,
    output: { title, summary },
  };
}
