import { describe, expect, it } from 'vitest';

import { ClawReviewConfigSchema } from '../src/config.js';
import {
  PRESETS,
  getPreset,
  listPresets,
  mergePresets,
  resolveExtendsChain,
} from '../src/presets.js';

describe('built-in presets', () => {
  it('exposes a stable, alphabetised name list', () => {
    expect(listPresets()).toEqual(
      [
        'accessibility-first',
        'nit-friendly',
        'permissive',
        'security-focused',
        'strict',
      ],
    );
  });

  it('every preset is a valid partial ClawReviewConfig', () => {
    // Apply each preset on top of the schema defaults and verify the
    // composed object still satisfies the strict schema. This catches
    // drift if someone adds a typoed field to a preset.
    for (const [name, preset] of Object.entries(PRESETS)) {
      const composed = ClawReviewConfigSchema.parse(preset);
      expect(composed, `preset ${name}`).toBeDefined();
      // Sanity: at least one of severity_threshold/agents was overridden.
      const baseline = ClawReviewConfigSchema.parse({});
      const overridden =
        composed.severity_threshold !== baseline.severity_threshold ||
        composed.agents.join(',') !== baseline.agents.join(',') ||
        composed.max_findings_per_file !== baseline.max_findings_per_file;
      expect(overridden, `preset ${name} should change at least one default`).toBe(true);
    }
  });
});

describe('mergePresets', () => {
  it('right-side primitives win', () => {
    const out = mergePresets({ severity_threshold: 'low' }, { severity_threshold: 'high' });
    expect(out.severity_threshold).toBe('high');
  });

  it('arrays REPLACE rather than concat', () => {
    const out = mergePresets(
      { agents: ['security'] },
      { agents: ['performance', 'style'] },
    );
    expect(out.agents).toEqual(['performance', 'style']);
  });

  it('plain objects merge recursively', () => {
    const out = mergePresets(
      { inline_comments: { enabled: true, min_severity: 'medium', max: 5 } },
      { inline_comments: { max: 20 } as never },
    );
    expect(out.inline_comments).toMatchObject({
      enabled: true,
      min_severity: 'medium',
      max: 20,
    });
  });

  it('omits keys with undefined values from the right side', () => {
    const out = mergePresets(
      { severity_threshold: 'medium' },
      { severity_threshold: undefined } as never,
    );
    expect(out.severity_threshold).toBe('medium');
  });
});

describe('resolveExtendsChain', () => {
  it('returns the named preset unchanged when only one name is given', () => {
    const out = resolveExtendsChain(['strict']);
    expect(out).toEqual(getPreset('strict'));
  });

  it('merges multiple presets left-to-right, last writer wins', () => {
    const out = resolveExtendsChain(['security-focused', 'permissive']);
    // permissive overrides severity_threshold to 'high'
    expect(out.severity_threshold).toBe('high');
    // permissive replaces the agents array
    expect(out.agents).toEqual(['security', 'performance', 'secrets']);
  });

  it('throws on unknown preset names with a helpful suggestion list', () => {
    expect(() => resolveExtendsChain(['nope'])).toThrow(
      /unknown preset 'nope'\. Available: /,
    );
  });

  it('throws when a name is referenced twice (cycle protection)', () => {
    expect(() => resolveExtendsChain(['strict', 'strict'])).toThrow(
      /preset cycle detected at 'strict'/,
    );
  });

  it('accepts a custom resolver so future preset sources can plug in', () => {
    const custom = { severity_threshold: 'critical' as const };
    const out = resolveExtendsChain(['custom-one'], (name) =>
      name === 'custom-one' ? custom : undefined,
    );
    expect(out.severity_threshold).toBe('critical');
  });
});
