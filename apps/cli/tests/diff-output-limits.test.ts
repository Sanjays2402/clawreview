import { describe, expect, it } from 'vitest';

import {
  DIFF_DEFAULT_MAX_OUTPUT_BYTES,
  DIFF_MAX_OUTPUT_BYTES_CEILING,
} from '../src/diff-output-limits.js';
import {
  PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES,
  PRESET_DIFF_MAX_OUTPUT_BYTES_CEILING,
} from '../src/commands/presets.js';
import {
  FILTER_REPORT_DIFF_DEFAULT_MAX_OUTPUT_BYTES,
  FILTER_REPORT_DIFF_MAX_OUTPUT_BYTES_CEILING,
} from '../src/commands/review.js';

/**
 * Tick 28: shared default + ceiling constants for `--output` size caps.
 *
 * Before tick 28 the `presets diff` and `review filter-report --diff`
 * commands each baked in their own literal copies of the default
 * (100 KiB) and ceiling (16 MiB). These tests pin the contract that:
 *
 *   1. the two pairs of literals have the SAME numeric values
 *      (an operator with `--max-output-bytes 200000` shouldn't see
 *      one command honor it and the other clamp it),
 *
 *   2. both pairs are now ALIASES of the same canonical exports
 *      from `apps/cli/src/diff-output-limits.ts` (so a bump to the
 *      canonical default in tick 29 flows through both commands
 *      automatically without a second commit),
 *
 *   3. the back-compat literal values are unchanged (a downstream
 *      tool reading `PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES` sees the
 *      same 102400 bytes it always did).
 *
 * If any of these tests fail after a refactor that splits the
 * constants apart, that's a real regression: the unified contract
 * is what makes "shared default" actually shared.
 */
describe('diff-output-limits (tick 28 shared constants)', () => {
  it('DIFF_DEFAULT_MAX_OUTPUT_BYTES is 100 KiB', () => {
    // Pinning the literal because a future tick that wants to change
    // the default should land in the constant + this test as a
    // deliberate edit (not a silent drift).
    expect(DIFF_DEFAULT_MAX_OUTPUT_BYTES).toBe(100 * 1024);
  });

  it('DIFF_MAX_OUTPUT_BYTES_CEILING is 16 MiB', () => {
    expect(DIFF_MAX_OUTPUT_BYTES_CEILING).toBe(16 * 1024 * 1024);
  });

  it('DIFF_MAX_OUTPUT_BYTES_CEILING is strictly greater than the default', () => {
    // Sanity: the ceiling must be a real ceiling. An accidental swap
    // (defaulting to a value higher than the ceiling) would silently
    // clamp every caller's default-mode write to the ceiling and the
    // operator would never see the "you exceeded the cap" hint.
    expect(DIFF_MAX_OUTPUT_BYTES_CEILING).toBeGreaterThan(DIFF_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES is the same instance/value as the canonical', () => {
    // `===` for numbers checks value equality which is what we want
    // here. The point is: the same literal is exported. A refactor
    // that swaps the constant for an unrelated number breaks this.
    expect(PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES).toBe(DIFF_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('PRESET_DIFF_MAX_OUTPUT_BYTES_CEILING is the same value as the canonical', () => {
    expect(PRESET_DIFF_MAX_OUTPUT_BYTES_CEILING).toBe(DIFF_MAX_OUTPUT_BYTES_CEILING);
  });

  it('FILTER_REPORT_DIFF_DEFAULT_MAX_OUTPUT_BYTES is the same value as the canonical', () => {
    expect(FILTER_REPORT_DIFF_DEFAULT_MAX_OUTPUT_BYTES).toBe(DIFF_DEFAULT_MAX_OUTPUT_BYTES);
  });

  it('FILTER_REPORT_DIFF_MAX_OUTPUT_BYTES_CEILING is the same value as the canonical', () => {
    expect(FILTER_REPORT_DIFF_MAX_OUTPUT_BYTES_CEILING).toBe(DIFF_MAX_OUTPUT_BYTES_CEILING);
  });

  it('the two command-scoped defaults agree byte-for-byte', () => {
    // This is the contract that pre-tick-28 couldn't guarantee: a
    // CI operator using the same --max-output-bytes-less invocation
    // against both commands sees the same default cap.
    expect(PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES).toBe(
      FILTER_REPORT_DIFF_DEFAULT_MAX_OUTPUT_BYTES,
    );
  });

  it('the two command-scoped ceilings agree byte-for-byte', () => {
    expect(PRESET_DIFF_MAX_OUTPUT_BYTES_CEILING).toBe(
      FILTER_REPORT_DIFF_MAX_OUTPUT_BYTES_CEILING,
    );
  });
});
