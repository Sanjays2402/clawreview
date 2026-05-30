import { describe, it, expect, beforeEach } from 'vitest';

import { RepoHealthTracker } from '../src/services/repo-health.js';

describe('RepoHealthTracker', () => {
  let now = 1_700_000_000_000;
  let t: RepoHealthTracker;
  beforeEach(() => {
    now = 1_700_000_000_000;
    t = new RepoHealthTracker({
      failureThreshold: 3,
      cooldownMs: 60_000,
      now: () => now,
    });
  });

  it('does not pause healthy repos', () => {
    t.recordSuccess('o', 'r');
    expect(t.isPaused('o', 'r')).toBe(false);
    expect(t.get('o', 'r')?.totalSuccesses).toBe(1);
  });

  it('trips an auto-pause after the configured failure threshold', () => {
    for (let i = 0; i < 3; i += 1) t.recordFailure('o', 'r', 'boom');
    expect(t.isPaused('o', 'r')).toBe(true);
    const s = t.get('o', 'r')!;
    expect(s.consecutiveFailures).toBe(3);
    expect(s.pausedReason).toContain('boom');
  });

  it('does not double-extend an existing auto-pause on each failure', () => {
    for (let i = 0; i < 3; i += 1) t.recordFailure('o', 'r');
    const first = t.get('o', 'r')!.pausedUntil!;
    now += 5_000;
    t.recordFailure('o', 'r');
    expect(t.get('o', 'r')!.pausedUntil).toBe(first);
  });

  it('auto-resumes once the cooldown elapses', () => {
    for (let i = 0; i < 3; i += 1) t.recordFailure('o', 'r');
    expect(t.isPaused('o', 'r')).toBe(true);
    now += 61_000;
    expect(t.isPaused('o', 'r')).toBe(false);
    expect(t.get('o', 'r')?.pausedUntil).toBeUndefined();
  });

  it('a success clears a tripped auto-pause', () => {
    for (let i = 0; i < 3; i += 1) t.recordFailure('o', 'r');
    t.recordSuccess('o', 'r');
    expect(t.isPaused('o', 'r')).toBe(false);
    expect(t.get('o', 'r')?.consecutiveFailures).toBe(0);
  });

  it('manual pause is sticky across success', () => {
    t.pause('o', 'r', 'maintenance');
    expect(t.isPaused('o', 'r')).toBe(true);
    t.recordSuccess('o', 'r');
    expect(t.isPaused('o', 'r')).toBe(true);
  });

  it('manual pause respects an explicit duration', () => {
    t.pause('o', 'r', 'short', 5_000);
    expect(t.isPaused('o', 'r')).toBe(true);
    now += 6_000;
    // Manually paused repos do not auto-expire.
    expect(t.isPaused('o', 'r')).toBe(true);
  });

  it('resume clears both manual and auto state', () => {
    for (let i = 0; i < 3; i += 1) t.recordFailure('o', 'r');
    t.pause('o', 'r', 'manual');
    const out = t.resume('o', 'r');
    expect(out?.manuallyPaused).toBe(false);
    expect(out?.consecutiveFailures).toBe(0);
    expect(t.isPaused('o', 'r')).toBe(false);
  });

  it('lists all tracked repos', () => {
    t.recordSuccess('o', 'a');
    t.recordFailure('o', 'b');
    const items = t.list();
    expect(items).toHaveLength(2);
    const repos = items.map((i) => i.repo).sort();
    expect(repos).toEqual(['o/a', 'o/b']);
  });

  it('returns null from resume for unknown repos', () => {
    expect(t.resume('o', 'missing')).toBeNull();
  });
});
