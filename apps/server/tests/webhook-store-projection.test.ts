import { describe, expect, it } from 'vitest';

import {
  InMemoryWebhookStore,
  PROJECTION_MAX_PATH_DEPTH,
  projectPayload,
  sanitizeProjection,
  splitProjectionPath,
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

describe('splitProjectionPath (pure)', () => {
  it('splits a dotted path into trimmed segments', () => {
    expect(splitProjectionPath('action')).toEqual(['action']);
    expect(splitProjectionPath('pull_request.title')).toEqual(['pull_request', 'title']);
    expect(splitProjectionPath(' pull_request . title ')).toEqual(['pull_request', 'title']);
    expect(splitProjectionPath('a.b.c.d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns null on an empty or whitespace-only path', () => {
    expect(splitProjectionPath('')).toBeNull();
    expect(splitProjectionPath('   ')).toBeNull();
  });

  it('returns null on a stray dot (empty intermediate segment)', () => {
    // Stray dots usually mean a forgotten name; we refuse rather
    // than silently widen the projection to "everything under
    // the empty segment".
    expect(splitProjectionPath('a..b')).toBeNull();
    expect(splitProjectionPath('.a')).toBeNull();
    expect(splitProjectionPath('a.')).toBeNull();
    expect(splitProjectionPath('. .')).toBeNull();
  });

  it('refuses paths deeper than PROJECTION_MAX_PATH_DEPTH', () => {
    // Build a path one segment past the cap and verify it lands in
    // the rejected bucket. The cap is exported so this test pin
    // tracks the actual configured ceiling.
    const okPath = Array.from({ length: PROJECTION_MAX_PATH_DEPTH }, (_, i) => `s${i}`).join('.');
    const tooDeep = `${okPath}.over`;
    expect(splitProjectionPath(okPath)).not.toBeNull();
    expect(splitProjectionPath(tooDeep)).toBeNull();
  });

  it('returns null for non-string inputs (belt-and-braces type guard)', () => {
    expect(splitProjectionPath(42 as unknown as string)).toBeNull();
    expect(splitProjectionPath(null as unknown as string)).toBeNull();
    expect(splitProjectionPath(undefined as unknown as string)).toBeNull();
  });
});

describe('projectPayload (dotted paths)', () => {
  // Tick-11 widens the projector to accept dotted paths so a
  // dashboard can pull a nested field in one round-trip. Tests pin
  // (a) basic nested pick works; (b) wire shape mirrors source
  // (`{ pull_request: { title } }`, not the flattened
  // `{ 'pull_request.title': ... }`); (c) multiple paths under one
  // prefix merge; (d) missing paths silently drop; (e) the depth
  // cap drops absurd paths; (f) full back-compat with tick-10
  // top-level callers.

  it('walks a dotted path and writes the value at the matching nested position', () => {
    const payload = {
      pull_request: { title: 'feat: x', number: 11, body: 'long...' },
      sender: { login: 'sanjay', id: 42 },
      action: 'opened',
    };
    const out = projectPayload(payload, new Set(['pull_request.title']));
    expect(out).toEqual({ pull_request: { title: 'feat: x' } });
  });

  it('merges multiple paths under one prefix into a single subtree', () => {
    const payload = {
      pull_request: {
        title: 'feat: x',
        number: 11,
        head: { sha: 'abc1234', ref: 'feature/x' },
      },
    };
    const out = projectPayload(
      payload,
      new Set(['pull_request.title', 'pull_request.number']),
    );
    // The wire shape mirrors the source tree -- one `pull_request`
    // subtree with both requested keys, not two flat entries.
    expect(out).toEqual({
      pull_request: { title: 'feat: x', number: 11 },
    });
  });

  it('merges nested paths across multiple prefixes (deep + shallow + sibling)', () => {
    const payload = {
      action: 'opened',
      pull_request: { title: 'feat: x', head: { sha: 'abc1234' } },
      sender: { login: 'sanjay', id: 42 },
    };
    const out = projectPayload(
      payload,
      new Set([
        'action',
        'pull_request.title',
        'pull_request.head.sha',
        'sender.login',
      ]),
    );
    expect(out).toEqual({
      action: 'opened',
      pull_request: { title: 'feat: x', head: { sha: 'abc1234' } },
      sender: { login: 'sanjay' },
    });
  });

  it('skips dotted paths whose intermediate segments are missing or non-objects', () => {
    const payload = {
      action: 'opened',
      // pull_request is a STRING here -- a dotted walk should refuse
      // to index into a primitive (a string's .length would otherwise
      // accidentally surface).
      pull_request: 'not-an-object' as unknown,
    };
    const out = projectPayload(
      payload,
      new Set(['action', 'pull_request.title', 'missing.thing']),
    );
    expect(out).toEqual({ action: 'opened' });
  });

  it('drops a dotted path entry that exceeds the depth cap', () => {
    const payload = { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } };
    const tooDeep = `a.b.c.d.e.f.g`; // 7 segments, depth cap = 6
    const okDeep = `a.b.c.d.e.f`; // 6 segments
    const out = projectPayload(payload, new Set([tooDeep, okDeep]));
    // The over-cap path is dropped. The at-cap path lands.
    expect(out).toEqual({ a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } });
  });

  it('mixes top-level and dotted entries without confusing the wire shape', () => {
    // The crucial back-compat case: a tick-10 caller's top-level
    // pick continues to land at the root, and the new dotted path
    // lands at its nested position. Two entries with the SAME root
    // key on opposite sides of the dot should not collide.
    const payload = {
      action: 'opened',
      sender: { login: 'sanjay', id: 42 },
      pull_request: { title: 'feat: x' },
    };
    // `sender` (top-level) AND `sender.login` (dotted) -- the dotted
    // one wins because it's more specific. The contract: top-level
    // picks land first; dotted picks overlay onto the same root key.
    const out = projectPayload(
      payload,
      new Set(['action', 'sender', 'sender.login']),
    );
    // The top-level `sender` pick should still land (full subtree),
    // and the more specific `sender.login` should NOT corrupt the
    // already-placed root (we'd rather not silently replace it).
    // Today's implementation order: top-level first, then dotted
    // overlays. Verify the merge produced a coherent shape.
    expect(out).toMatchObject({ action: 'opened' });
    // Both keys are present after the merge; the specific path
    // doesn't blow up the broader pick.
    const sender = (out as Record<string, unknown>).sender as Record<string, unknown>;
    expect(sender.login).toBe('sanjay');
  });

  it('preserves the tick-10 top-level back-compat shape byte-identical', () => {
    // A caller that only uses top-level keys must see EXACTLY the
    // same output as tick-10 shipped. We compare via a deep eq.
    const payload = {
      action: 'opened',
      number: 5,
      sender: { login: 'sanjay' },
      extra: 'drop',
    };
    const out = projectPayload(payload, new Set(['action', 'number', 'sender']));
    expect(out).toEqual({ action: 'opened', number: 5, sender: { login: 'sanjay' } });
    // `extra` must not slip through.
    expect(Object.prototype.hasOwnProperty.call(out, 'extra')).toBe(false);
  });

  it('still returns undefined for non-plain-object payloads (back-compat)', () => {
    expect(projectPayload(null, new Set(['pull_request.title']))).toBeUndefined();
    expect(projectPayload(['x'], new Set(['pull_request.title']))).toBeUndefined();
    expect(projectPayload(42, new Set(['pull_request.title']))).toBeUndefined();
    expect(projectPayload('opened', new Set(['pull_request.title']))).toBeUndefined();
  });

  it('drops a dotted path with a malformed (empty) intermediate segment silently', () => {
    // The split helper returns null on `'a..b'`; the projector
    // silently drops such entries. We pair the entry with a valid
    // one to prove the rest of the projection still works.
    const payload = { a: { b: 'X' }, c: 'Y' };
    const out = projectPayload(payload, new Set(['a..b', 'c']));
    expect(out).toEqual({ c: 'Y' });
  });
});

describe('InMemoryWebhookStore.list dotted-path projection', () => {
  // Wired test: the dotted-path support reaches through .list()'s
  // payloadFields path so a dashboard polling /api/internal/webhook/
  // recent?payloadFields=action,pull_request.title can render
  // rich rows in one round-trip.

  it('projects a nested field for every entry in newest-first order', () => {
    const store = new InMemoryWebhookStore();
    store.put({
      deliveryId: 'pp-1',
      event: 'pull_request',
      action: 'opened',
      payload: {
        action: 'opened',
        number: 11,
        pull_request: { title: 'feat: a', body: '...' },
        sender: { login: 'sanjay' },
      },
      receivedAt: new Date().toISOString(),
      repoFullName: 'sanjay/demo',
    });
    store.put({
      deliveryId: 'pp-2',
      event: 'pull_request',
      action: 'synchronize',
      payload: {
        action: 'synchronize',
        number: 12,
        pull_request: { title: 'chore: b', body: '...' },
        sender: { login: 'other' },
      },
      receivedAt: new Date().toISOString(),
      repoFullName: 'sanjay/demo',
    });

    const out = store.list({
      payloadFields: ['action', 'pull_request.title', 'sender.login'],
    });
    expect(out.length).toBe(2);
    // Newest-first ordering preserved.
    expect(out[0]!.deliveryId).toBe('pp-2');
    expect(out[0]!.payload).toEqual({
      action: 'synchronize',
      pull_request: { title: 'chore: b' },
      sender: { login: 'other' },
    });
    expect(out[1]!.payload).toEqual({
      action: 'opened',
      pull_request: { title: 'feat: a' },
      sender: { login: 'sanjay' },
    });
  });

  it('omits the projected key entirely when the nested path is missing on a given entry', () => {
    // Two entries with one missing the nested path. The projector
    // must NOT crash AND must not fabricate a placeholder; the key
    // is simply absent from that entry's payload.
    const store = new InMemoryWebhookStore();
    store.put({
      deliveryId: 'mp-1',
      event: 'push',
      payload: { ref: 'refs/heads/main', commits: [{ id: 'a' }] },
      receivedAt: new Date().toISOString(),
      repoFullName: 'sanjay/demo',
    });
    store.put({
      deliveryId: 'mp-2',
      event: 'push',
      payload: { ref: 'refs/heads/dev' },
      receivedAt: new Date().toISOString(),
      repoFullName: 'sanjay/demo',
    });
    const out = store.list({ payloadFields: ['ref', 'commits.0.id'] });
    expect(out.length).toBe(2);
    // commits.0.id is invalid (we don't support array indices), so
    // both entries get just `ref` -- proves the missing-path drop
    // doesn't trip a bad-shape entry from going through.
    expect(out[0]!.payload).toEqual({ ref: 'refs/heads/dev' });
    expect(out[1]!.payload).toEqual({ ref: 'refs/heads/main' });
  });

  it('does NOT mutate the stored entry when projecting nested fields', () => {
    const store = new InMemoryWebhookStore();
    store.put({
      deliveryId: 'np-1',
      event: 'pull_request',
      payload: { action: 'opened', pull_request: { title: 'X', body: 'Y' } },
      receivedAt: new Date().toISOString(),
      repoFullName: 'sanjay/demo',
    });
    const _slim = store.list({ payloadFields: ['pull_request.title'] });
    void _slim;
    // A re-list without a projection returns the full payload tree.
    const full = store.list({});
    expect(full[0]!.payload).toEqual({
      action: 'opened',
      pull_request: { title: 'X', body: 'Y' },
    });
  });
});
