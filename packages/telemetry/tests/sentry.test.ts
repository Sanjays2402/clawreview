import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetSentryForTests,
  captureException,
  flushSentry,
  initSentry,
  isSentryEnabled,
} from '../src/sentry.js';

describe('sentry wrapper', () => {
  afterEach(() => {
    _resetSentryForTests();
  });

  it('is a no-op when DSN is empty', async () => {
    const enabled = await initSentry({ dsn: '' });
    expect(enabled).toBe(false);
    expect(isSentryEnabled()).toBe(false);
    expect(captureException(new Error('boom'))).toBeNull();
    await expect(flushSentry(10)).resolves.toBeUndefined();
  });

  it('initSentry is idempotent', async () => {
    const first = await initSentry({ dsn: '' });
    const second = await initSentry({ dsn: 'https://public@sentry.example/1' });
    // Second call returns the cached result of the first, even with a DSN.
    expect(first).toBe(false);
    expect(second).toBe(false);
  });
});
