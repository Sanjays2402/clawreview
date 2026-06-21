import {
  SEVERITY_ORDER,
  type Finding,
  type FindingCategory,
  type Severity,
} from '@clawreview/types';

/**
 * Calibration thresholds. Tuned so the defaults reflect what we have
 * empirically seen with the current prompt set:
 *
 *   - Low-confidence nits are noise. Anything with confidence < 0.35 that
 *     was emitted as `nit` or `low` gets floored to `nit` and tagged so
 *     downstream consumers (the PR comment, SARIF, etc.) can hide them
 *     behind a "show suspect findings" toggle.
 *   - High-confidence security findings are worth caller attention even
 *     if the agent was cautious about severity. Anything with category
 *     `security` or `sql-injection` (or `secrets`) at confidence >= 0.85
 *     gets promoted up to at least `medium`.
 *   - Critical-confidence security findings (>= 0.95) get promoted to
 *     `high` minimum because a near-certain security claim deserves
 *     reviewer eyes even when the model self-rated as low.
 *
 * All thresholds can be overridden via `CalibrationOptions`; pass an
 * empty object to use defaults, or set `disabled: true` to bypass.
 */
export interface CalibrationOptions {
  /** Disable the pass entirely (no-op). */
  disabled?: boolean;
  /** Confidence below which a low-priority finding is floored to nit. */
  nitFloorBelow?: number;
  /** Confidence at/above which a security finding is bumped to medium+. */
  securityBumpAt?: number;
  /** Confidence at/above which a security finding is bumped to high+. */
  securityHighAt?: number;
  /** Categories considered "security-sensitive" for the bump rules. */
  securityCategories?: FindingCategory[];
}

export interface CalibrationApplied {
  /** The finding AFTER calibration. */
  finding: Finding;
  /** Severity before calibration. */
  from: Severity;
  /** Severity after calibration. */
  to: Severity;
  /** Which rule fired: 'nit-floor' or 'security-bump' or 'security-high'. */
  rule: 'nit-floor' | 'security-bump' | 'security-high';
}

export interface CalibrationResult {
  /** Findings array with severities adjusted; original input is not mutated. */
  findings: Finding[];
  /** Audit log of every adjustment, in input order. Empty when no rule fired. */
  applied: CalibrationApplied[];
}

const DEFAULT_NIT_FLOOR_BELOW = 0.35;
const DEFAULT_SECURITY_BUMP_AT = 0.85;
const DEFAULT_SECURITY_HIGH_AT = 0.95;
const DEFAULT_SECURITY_CATEGORIES: FindingCategory[] = [
  'security',
  'sql-injection',
  'secrets',
];

const TAG_NIT_FLOOR = 'calibrated:nit-floor';
const TAG_SECURITY_BUMP = 'calibrated:security-bump';
const TAG_SECURITY_HIGH = 'calibrated:security-high';

/**
 * Apply confidence calibration to a batch of findings. Runs after dedup
 * but before the maxPerFile truncation; that way the bumped findings
 * still compete on severity in the per-file cap and the floored nits
 * don't crowd out genuine low-severity issues.
 *
 * The function is pure: it never mutates input findings and always
 * returns fresh objects when a rule fires (input findings pass through
 * by reference when no rule applies). Tag annotations are deduped so
 * a finding that already had `calibrated:*` tags won't grow them on
 * repeat calls.
 */
export function calibrateConfidence(
  findings: Finding[],
  opts: CalibrationOptions = {},
): CalibrationResult {
  if (opts.disabled) {
    return { findings, applied: [] };
  }

  const nitFloorBelow = clampConfidence(opts.nitFloorBelow ?? DEFAULT_NIT_FLOOR_BELOW);
  const securityBumpAt = clampConfidence(opts.securityBumpAt ?? DEFAULT_SECURITY_BUMP_AT);
  const securityHighAt = clampConfidence(opts.securityHighAt ?? DEFAULT_SECURITY_HIGH_AT);
  const securityCategories = new Set<FindingCategory>(
    opts.securityCategories ?? DEFAULT_SECURITY_CATEGORIES,
  );

  const applied: CalibrationApplied[] = [];
  const out = findings.map((finding) => {
    const isSecurity = securityCategories.has(finding.category);

    // Security high-confidence promotion runs first because it can lift
    // a finding above the nit-floor bracket entirely.
    if (isSecurity && finding.confidence >= securityHighAt) {
      const promoted = atLeast(finding.severity, 'high');
      if (promoted !== finding.severity) {
        const next = withTag({ ...finding, severity: promoted }, TAG_SECURITY_HIGH);
        applied.push({ finding: next, from: finding.severity, to: promoted, rule: 'security-high' });
        return next;
      }
    } else if (isSecurity && finding.confidence >= securityBumpAt) {
      const promoted = atLeast(finding.severity, 'medium');
      if (promoted !== finding.severity) {
        const next = withTag({ ...finding, severity: promoted }, TAG_SECURITY_BUMP);
        applied.push({ finding: next, from: finding.severity, to: promoted, rule: 'security-bump' });
        return next;
      }
    }

    // Nit floor. Only demotes findings that were already in the bottom
    // bracket; we never floor a `medium` or above, because demoting a
    // real issue based on confidence is risky.
    if (
      finding.confidence < nitFloorBelow &&
      (finding.severity === 'low' || finding.severity === 'nit')
    ) {
      if (finding.severity === 'nit') {
        // Already at the floor; still tag so consumers can hide it.
        const next = withTag({ ...finding }, TAG_NIT_FLOOR);
        if (next === finding) return finding;
        applied.push({ finding: next, from: 'nit', to: 'nit', rule: 'nit-floor' });
        return next;
      }
      const next = withTag({ ...finding, severity: 'nit' as Severity }, TAG_NIT_FLOOR);
      applied.push({ finding: next, from: finding.severity, to: 'nit', rule: 'nit-floor' });
      return next;
    }

    return finding;
  });

  return { findings: out, applied };
}

/** Returns whichever severity is more severe (lower SEVERITY_ORDER index). */
export function atLeast(current: Severity, floor: Severity): Severity {
  return SEVERITY_ORDER[current] <= SEVERITY_ORDER[floor] ? current : floor;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Append `tag` to the finding's tags array if not already present.
 * Returns the same object reference when nothing changed so callers
 * (and the audit log) can detect no-ops cheaply.
 */
function withTag(finding: Finding, tag: string): Finding {
  const tags = finding.tags ?? [];
  if (tags.includes(tag)) return finding;
  return { ...finding, tags: [...tags, tag] };
}
