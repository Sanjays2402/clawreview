import { minimatch } from '@clawreview/diff';
import {
  SEVERITY_ORDER,
  type ClawReviewConfig,
  type Finding,
  type Severity,
} from '@clawreview/types';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'nit'];

export interface SeverityRuleApplied {
  finding: Finding;
  /** Severity before the rule fired. Equal to finding.severity if no change. */
  from: Severity;
  /** Severity after the rule fired. */
  to: Severity;
  /** Index of the matched rule in config.severity_rules. */
  ruleIndex: number;
  /** Human-readable reason if the rule supplied one. */
  reason?: string;
}

export interface ApplyRulesResult {
  /** Findings with severity (and tags) rewritten where rules matched. */
  findings: Finding[];
  /** Audit log of every rule application; useful for the dashboard and
   *  for explaining "why did this nit become a high" in PR comments. */
  applied: SeverityRuleApplied[];
}

/**
 * Apply config-driven severity escalation/de-escalation rules to a batch
 * of findings.
 *
 * Rules are evaluated in declaration order; the first matching rule per
 * finding wins (last-match-wins is rarely what people want when the rules
 * encode policy). A rule may either set an absolute severity or bump the
 * current one up/down N steps (negative bump = more severe, matching the
 * SEVERITY_ORDER convention where critical = 0).
 *
 * Typical use: escalate any finding under auth/, billing/, or migrations/
 * by one step, downgrade style nits in vendored code, etc.
 */
export function applySeverityRules(
  findings: Finding[],
  config: Pick<ClawReviewConfig, 'severity_rules'>,
): ApplyRulesResult {
  const rules = config.severity_rules ?? [];
  if (rules.length === 0) {
    return { findings, applied: [] };
  }

  const applied: SeverityRuleApplied[] = [];
  const out: Finding[] = findings.map((finding) => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule || !matches(finding, rule)) continue;
      const from = finding.severity;
      const to = rule.set ?? bumpSeverity(from, rule.bump ?? 0);
      if (to === from) {
        // Rule matched but produced no change; still record the match so
        // operators can debug accidental no-ops.
        applied.push({ finding, from, to, ruleIndex: i, reason: rule.reason });
        return finding;
      }
      const tag = `severity-rule:${i}${rule.reason ? `:${slug(rule.reason)}` : ''}`;
      const updated: Finding = {
        ...finding,
        severity: to,
        tags: dedupe([...(finding.tags ?? []), tag]),
      };
      applied.push({ finding: updated, from, to, ruleIndex: i, reason: rule.reason });
      return updated;
    }
    return finding;
  });
  return { findings: out, applied };
}

function matches(
  f: Finding,
  rule: ClawReviewConfig['severity_rules'][number],
): boolean {
  if (rule.agent && rule.agent !== f.agent) return false;
  if (rule.category && rule.category !== f.category) return false;
  return minimatch(f.file, rule.path);
}

export function bumpSeverity(s: Severity, delta: number): Severity {
  // Lower index = more severe. `bump: -1` escalates one step.
  const idx = SEVERITY_ORDER[s];
  const next = Math.max(0, Math.min(SEVERITIES.length - 1, idx + delta));
  return SEVERITIES[next] ?? s;
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
