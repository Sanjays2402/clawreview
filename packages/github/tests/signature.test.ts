import { describe, expect, it } from 'vitest';

import { computeSignature, verifyWebhookSignature } from '../src/signature.js';

describe('verifyWebhookSignature', () => {
  const body = JSON.stringify({ action: 'opened' });
  const secret = 'super-secret';

  it('accepts a correctly computed signature', () => {
    const sig = computeSignature(body, secret);
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const sig = computeSignature(body, secret);
    expect(verifyWebhookSignature(body + 'x', sig, secret)).toBe(false);
  });

  it('rejects missing header', () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it('rejects empty secret', () => {
    const sig = computeSignature(body, 'other');
    expect(verifyWebhookSignature(body, sig, '')).toBe(false);
  });

  it('rejects wrong prefix', () => {
    expect(verifyWebhookSignature(body, 'sha1=abc', secret)).toBe(false);
  });
});
