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

/**
 * Audit record for a rule that DROPPED a finding entirely (rule had
 * `drop: true`). Kept separate from `SeverityRuleApplied` so dashboards
 * and metrics can distinguish "we rewrote N findings" from "we dropped
 * N findings" without re-walking the array.
 */
export interface SeverityRuleDropped {
  finding: Finding;
  ruleIndex: number;
  reason?: string;
}

export interface ApplyRulesResult {
  /** Findings with severity (and tags) rewritten where rules matched. */
  findings: Finding[];
  /** Audit log of every rule application; useful for the dashboard and
   *  for explaining "why did this nit become a high" in PR comments. */
  applied: SeverityRuleApplied[];
  /**
   * Findings that a rule with `drop: true` removed from the output.
   * Always disjoint from `findings`. Order matches the input order so
   * downstream callers can correlate with the original sequence.
   */
  dropped: SeverityRuleDropped[];
}

/**
 * Apply config-driven severity escalation/de-escalation rules to a batch
 * of findings.
 *
 * Rules are evaluated in declaration order; the first matching rule per
 * finding wins (last-match-wins is rarely what people want when the rules
 * encode policy). A rule may either set an absolute severity, bump the
 * current one up/down N steps, or drop the finding entirely. Negative
 * bump = more severe, matching the SEVERITY_ORDER convention where
 * critical = 0.
 *
 * Matchers compose: a rule with `path` + `category` + `min_confidence`
 * + `max_confidence` only fires when ALL of them match the finding.
 *
 * Typical use: escalate any finding under auth/, billing/, or migrations/
 * by one step, downgrade style nits in vendored code, drop anything
 * below 0.3 confidence in third-party generated files, etc.
 */
export function applySeverityRules(
  findings: Finding[],
  config: Pick<ClawReviewConfig, 'severity_rules'>,
): ApplyRulesResult {
  const rules = config.severity_rules ?? [];
  if (rules.length === 0) {
    return { findings, applied: [], dropped: [] };
  }

  const applied: SeverityRuleApplied[] = [];
  const dropped: SeverityRuleDropped[] = [];
  const out: Finding[] = [];
  for (const finding of findings) {
    let resolved: Finding | null = finding;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (!rule || !matches(finding, rule)) continue;
      // `drop: true` always wins over `set`/`bump` even if both are
      // present (the schema only requires one; the runtime honors
      // drop first because removing a finding is the most aggressive
      // outcome and operators set it deliberately).
      if (rule.drop === true) {
        dropped.push({ finding, ruleIndex: i, reason: rule.reason });
        resolved = null;
        break;
      }
      const from = finding.severity;
      const to = rule.set ?? bumpSeverity(from, rule.bump ?? 0);
      if (to === from) {
        // Rule matched but produced no change; still record the match so
        // operators can debug accidental no-ops.
        applied.push({ finding, from, to, ruleIndex: i, reason: rule.reason });
        resolved = finding;
        break;
      }
      const tag = `severity-rule:${i}${rule.reason ? `:${slug(rule.reason)}` : ''}`;
      const updated: Finding = {
        ...finding,
        severity: to,
        tags: dedupe([...(finding.tags ?? []), tag]),
      };
      applied.push({ finding: updated, from, to, ruleIndex: i, reason: rule.reason });
      resolved = updated;
      break;
    }
    if (resolved !== null) out.push(resolved);
  }
  return { findings: out, applied, dropped };
}

function matches(
  f: Finding,
  rule: ClawReviewConfig['severity_rules'][number],
): boolean {
  if (rule.agent && rule.agent !== f.agent) return false;
  if (rule.category && rule.category !== f.category) return false;
  if (rule.min_confidence !== undefined && f.confidence < rule.min_confidence) return false;
  if (rule.max_confidence !== undefined && f.confidence > rule.max_confidence) return false;
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
