import { describe, expect, it } from 'vitest';

import {
  InMemoryWebhookStore,
  projectPayload,
  sanitizeProjection,
} from '../src/services/webhook-store.js';

/**
 * Unit tests for the tick-10 payloadFields projection. The helpers
 * (`sanitizeProjection` / `projectPayload`) are exported so the
 * contract is testable independently of the store wiring; the
 * integration with `InMemoryWebhookStore.list` is exercised in a
 * separate block below to guard against future refactors collapsing
 * the helpers back into the class.
 */

describe('sanitizeProjection (pure)', () => {
  it('returns null when fields is undefined (existing back-compat shape)', () => {
    expect(sanitizeProjection(undefined)).toBeNull();
  });

  it('returns null for non-array input so the back-compat path stays the default', () => {
    // A caller that hands a malformed value gets the back-compat
    // shape rather than an empty projection. Empty-array opt-out is
    // its own distinct case.
    expect(sanitizeProjection('action,number' as unknown as readonly string[])).toBeNull();
    expect(sanitizeProjection(42 as unknown as readonly string[])).toBeNull();
    expect(sanitizeProjection({} as unknown as readonly string[])).toBeNull();
  });

  it('returns an empty Set for an explicit empty array (opt-out: ship without payload)', () => {
    const out = sanitizeProjection([]);
    expect(out).not.toBeNull();
    expect(out!.size).toBe(0);
  });

  it('de-dupes and trims names', () => {
    const out = sanitizeProjection(['action', ' action ', 'action', 'number']);
    expect(out).not.toBeNull();
    expect(out!.size).toBe(2);
    expect(out!.has('action')).toBe(true);
    expect(out!.has('number')).toBe(true);
  });

  it('drops empty / whitespace-only entries', () => {
    const out = sanitizeProjection(['action', '', '   ', 'sender']);
    expect(out).not.toBeNull();
    expect(out!.size).toBe(2);
    expect(out!.has('action')).toBe(true);
    expect(out!.has('sender')).toBe(true);
  });
});

describe('projectPayload (pure)', () => {
  it('returns a fresh object with only the requested top-level keys', () => {
    const payload = { action: 'opened', number: 5, sender: { login: 'sanjay' }, extra: 'drop' };
    const fields = new Set(['action', 'number', 'sender']);
    const out = projectPayload(payload, fields);
    expect(out).toEqual({ action: 'opened', number: 5, sender: { login: 'sanjay' } });
    // Source object must be unchanged.
    expect(Object.keys(payload).sort()).toEqual(['action', 'extra', 'number', 'sender']);
  });

  it('skips missing keys silently rather than erroring', () => {
    const payload = { action: 'opened' };
    const out = projectPayload(payload, new Set(['action', 'sender', 'number']));
    // Only `action` was present; the other two are silently absent.
    expect(out).toEqual({ action: 'opened' });
  });

  it('returns undefined when payload is not a plain object', () => {
    expect(projectPayload(null, new Set(['action']))).toBeUndefined();
    expect(projectPayload(undefined, new Set(['action']))).toBeUndefined();
    expect(projectPayload([1, 2, 3], new Set(['action']))).toBeUndefined();
    expect(projectPayload('opened', new Set(['action']))).toBeUndefined();
    expect(projectPayload(42, new Set(['action']))).toBeUndefined();
  });

  it('returns an empty object when the allowlist is empty', () => {
    // Empty allowlist + non-empty payload -> empty projection. The
    // store layer handles "no allowlist at all" differently (returns
    // entry unchanged); this helper is only called when there IS one.
    expect(projectPayload({ action: 'opened' }, new Set())).toEqual({});
  });

  it('handles prototype-chain keys by checking own-property only', () => {
    // A payload that happens to share a name with `Object.prototype`
    // (e.g. `toString`) must still survive projection because it's an
    // own property. Conversely, requesting a key that exists only on
    // the prototype must NOT be lifted onto the projection.
    const payload = { toString: 'override', action: 'opened' };
    const out = projectPayload(payload, new Set(['toString', 'valueOf', 'action']));
    // toString is an own property here -> kept. valueOf is prototype-only
    // -> skipped.
    expect(out).toEqual({ toString: 'override', action: 'opened' });
  });
});

describe('InMemoryWebhookStore.list payloadFields projection', () => {
  function seedStore(): InMemoryWebhookStore {
    const store = new InMemoryWebhookStore();
    store.put({
      deliveryId: 'pf-1',
      event: 'pull_request',
      action: 'opened',
      payload: {
        action: 'opened',
        number: 11,
        sender: { login: 'sanjay' },
        pull_request: { title: 'feat: x', body: 'a long markdown body...' },
      },
      receivedAt: new Date().toISOString(),
      repoFullName: 'sanjay/demo',
    });
    store.put({
      deliveryId: 'pf-2',
      event: 'pull_request',
      action: 'synchronize',
      payload: {
        action: 'synchronize',
        number: 12,
        sender: { login: 'other' },
        pull_request: { title: 'chore: y', body: '...' },
      },
      receivedAt: new Date().toISOString(),
      repoFullName: 'sanjay/demo',
    });
    return store;
  }

  it('default (no payloadFields) returns the entry payload unchanged', () => {
    const store = seedStore();
    const out = store.list({ limit: 5 });
    expect(out.length).toBe(2);
    // Newest-first: pf-2 comes first.
    expect(out[0]!.deliveryId).toBe('pf-2');
    // Payload is the full object the receiver originally stored.
    expect(out[0]!.payload).toEqual({
      action: 'synchronize',
      number: 12,
      sender: { login: 'other' },
      pull_request: { title: 'chore: y', body: '...' },
    });
  });

  it('non-empty allowlist projects every entry to the requested top-level keys', () => {
    const store = seedStore();
    const out = store.list({ payloadFields: ['action', 'number', 'sender'] });
    expect(out.length).toBe(2);
    for (const e of out) {
      expect(e.payload).toEqual({
        action: (e.payload as { action: string }).action,
        number: (e.payload as { number: number }).number,
        sender: (e.payload as { sender: unknown }).sender,
      });
      // The unrequested `pull_request` subtree is gone.
      expect((e.payload as Record<string, unknown>).pull_request).toBeUndefined();
    }
  });

  it('empty allowlist drops payload entirely (explicit opt-out)', () => {
    const store = seedStore();
    const out = store.list({ payloadFields: [] });
    expect(out.length).toBe(2);
    for (const e of out) {
      // Empty-allowlist semantics: payload is set to undefined.
      expect(e.payload).toBeUndefined();
    }
  });

  it('does NOT mutate the stored entry when projecting', () => {
    const store = seedStore();
    const _slim = store.list({ payloadFields: ['action'] });
    void _slim;
    // The stored entry is unchanged: a re-list with no projection
    // returns the full payload again.
    const fullAgain = store.list({});
    expect(fullAgain[0]!.payload).toMatchObject({
      pull_request: { title: 'chore: y' },
    });
  });

  it('composes with the existing filter / pagination / cursor knobs', () => {
    const store = seedStore();
    // Add a third entry for a different event so the filter has work.
    store.put({
      deliveryId: 'pf-push',
      event: 'push',
      payload: { ref: 'refs/heads/main', commits: [{ id: 'a' }, { id: 'b' }] },
      receivedAt: new Date().toISOString(),
      repoFullName: 'sanjay/demo',
    });
    const out = store.list({ event: 'push', payloadFields: ['ref'] });
    expect(out.length).toBe(1);
    expect(out[0]!.deliveryId).toBe('pf-push');
    expect(out[0]!.payload).toEqual({ ref: 'refs/heads/main' });
  });
});
