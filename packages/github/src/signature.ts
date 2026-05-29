import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a GitHub webhook signature. Returns true if the provided header
 * is valid for the given payload. Constant-time comparison protects against
 * timing oracles.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  if (!secret) return false;
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
  const expected = createHmac('sha256', secret).update(body).digest();
  const provided = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function computeSignature(rawBody: string | Buffer, secret: string): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}
