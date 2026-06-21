import { describe, expect, it } from 'vitest';
import type { Finding } from '@clawreview/types';

import { atLeast, calibrateConfidence } from '../src/calibrate.js';

function f(over: Partial<Finding> = {}): Finding {
  return {
    agent: 'security',
    category: 'security',
    severity: 'medium',
    title: 'Issue',
    rationale: 'r',
    file: 'src/x.ts',
    startLine: 10,
    confidence: 0.7,
    tags: [],
    ...over,
  } as Finding;
}

describe('atLeast', () => {
  it('returns the more severe of current vs floor', () => {
    expect(atLeast('low', 'medium')).toBe('medium');
    expect(atLeast('high', 'medium')).toBe('high');
    expect(atLeast('critical', 'medium')).toBe('critical');
    expect(atLeast('nit', 'high')).toBe('high');
  });
});

describe('calibrateConfidence', () => {
  it('is a no-op when disabled', () => {
    const findings = [f({ severity: 'low', confidence: 0.1 })];
    const res = calibrateConfidence(findings, { disabled: true });
    expect(res.applied).toEqual([]);
    expect(res.findings).toBe(findings);
  });

  it('floors low-confidence nits/lows to nit and tags them', () => {
    const low = f({ severity: 'low', confidence: 0.2, category: 'style', agent: 'style' });
    const nit = f({ severity: 'nit', confidence: 0.1, category: 'style', agent: 'style' });
    const safe = f({ severity: 'low', confidence: 0.5, category: 'style', agent: 'style' });
    const res = calibrateConfidence([low, nit, safe]);
    expect(res.findings[0]!.severity).toBe('nit');
    expect(res.findings[0]!.tags).toContain('calibrated:nit-floor');
    expect(res.findings[1]!.severity).toBe('nit');
    expect(res.findings[1]!.tags).toContain('calibrated:nit-floor');
    expect(res.findings[2]).toBe(safe); // confidence above floor → unchanged
    expect(res.applied.map((a) => a.rule)).toEqual(['nit-floor', 'nit-floor']);
  });

  it('never demotes a medium or higher even at very low confidence', () => {
    const med = f({ severity: 'medium', confidence: 0.01, category: 'style', agent: 'style' });
    const high = f({ severity: 'high', confidence: 0.0, category: 'style', agent: 'style' });
    const res = calibrateConfidence([med, high]);
    expect(res.findings[0]).toBe(med);
    expect(res.findings[1]).toBe(high);
    expect(res.applied).toEqual([]);
  });

  it('bumps high-confidence security findings up to at least medium', () => {
    const lowSec = f({ severity: 'low', confidence: 0.9, category: 'security' });
    const res = calibrateConfidence([lowSec]);
    expect(res.findings[0]!.severity).toBe('medium');
    expect(res.findings[0]!.tags).toContain('calibrated:security-bump');
    expect(res.applied[0]!.rule).toBe('security-bump');
    expect(res.applied[0]!.from).toBe('low');
  });

  it('bumps near-certain security findings up to at least high', () => {
    const nitSec = f({ severity: 'nit', confidence: 0.97, category: 'sql-injection' });
    const res = calibrateConfidence([nitSec]);
    expect(res.findings[0]!.severity).toBe('high');
    expect(res.findings[0]!.tags).toContain('calibrated:security-high');
    expect(res.applied[0]!.rule).toBe('security-high');
  });

  it('respects an existing severity when it is already at or above the floor', () => {
    const critSec = f({ severity: 'critical', confidence: 0.99, category: 'security' });
    const res = calibrateConfidence([critSec]);
    expect(res.findings[0]).toBe(critSec);
    expect(res.applied).toEqual([]);
  });

  it('does not bump non-security categories even at high confidence', () => {
    const perf = f({ severity: 'low', confidence: 0.99, category: 'performance', agent: 'performance' });
    const res = calibrateConfidence([perf]);
    expect(res.findings[0]).toBe(perf);
    expect(res.applied).toEqual([]);
  });

  it('honors overridden securityCategories', () => {
    const perf = f({ severity: 'low', confidence: 0.9, category: 'performance', agent: 'performance' });
    const res = calibrateConfidence([perf], { securityCategories: ['performance'] });
    expect(res.findings[0]!.severity).toBe('medium');
    expect(res.findings[0]!.tags).toContain('calibrated:security-bump');
  });

  it('clamps out-of-range thresholds and treats NaN as 0', () => {
    const lowSec = f({ severity: 'low', confidence: 0.05, category: 'security' });
    // securityBumpAt clamps to 0 → any confidence bumps the finding.
    const res = calibrateConfidence([lowSec], { securityBumpAt: -10 });
    expect(res.findings[0]!.severity).toBe('medium');

    const nitStyle = f({ severity: 'nit', confidence: 0.99, category: 'style', agent: 'style' });
    // nitFloorBelow clamped to 1 → every nit gets re-tagged.
    const res2 = calibrateConfidence([nitStyle], { nitFloorBelow: 5 });
    expect(res2.findings[0]!.tags).toContain('calibrated:nit-floor');
  });

  it('does not re-add a calibration tag that is already present (idempotent)', () => {
    const lowSec = f({
      severity: 'low',
      confidence: 0.9,
      category: 'security',
      tags: ['calibrated:security-bump'],
    });
    const res = calibrateConfidence([lowSec]);
    const tags = res.findings[0]!.tags;
    // The severity bump still applies; the tag is already there so the
    // count of that tag stays at 1 (no duplicate). Note: since the tag
    // was already present, the function detects no rule firing.
    expect(tags?.filter((t) => t === 'calibrated:security-bump').length).toBe(1);
    expect(res.findings[0]!.severity).toBe('medium');
  });

  it('does not mutate the input findings', () => {
    const lowSec = f({ severity: 'low', confidence: 0.9, category: 'security' });
    const snapshot = JSON.stringify(lowSec);
    calibrateConfidence([lowSec]);
    expect(JSON.stringify(lowSec)).toBe(snapshot);
  });
});
