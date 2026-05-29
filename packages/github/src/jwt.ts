import { createSign } from 'node:crypto';

export interface AppJwtOptions {
  appId: string | number;
  privateKey: string;
  /** Seconds to live, capped at 600 by GitHub. */
  ttlSeconds?: number;
  now?: () => number;
}

/**
 * Builds a JWT signed with the GitHub App private key. Tiny, dependency-free
 * implementation that produces a token suitable for the `Bearer` header on
 * `/app/installations` endpoints.
 */
export function buildAppJwt(opts: AppJwtOptions): string {
  const now = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const ttl = Math.min(opts.ttlSeconds ?? 540, 600);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 30,
    exp: now + ttl,
    iss: String(opts.appId),
  };
  const encHeader = base64Url(JSON.stringify(header));
  const encPayload = base64Url(JSON.stringify(payload));
  const data = `${encHeader}.${encPayload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  const sig = signer.sign(opts.privateKey).toString('base64');
  return `${data}.${base64UrlFromB64(sig)}`;
}

function base64Url(input: string): string {
  return base64UrlFromB64(Buffer.from(input, 'utf8').toString('base64'));
}

function base64UrlFromB64(b64: string): string {
  return b64.replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
