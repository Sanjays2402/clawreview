import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

import { env } from '../env.js';

/**
 * Loaded API tokens. The map is name -> raw token bytes so we can do a
 * constant-time compare and still log which credential was used (by name)
 * without ever logging the secret itself.
 *
 * Format of API_AUTH_TOKENS:
 *   "name1:token1,name2:token2"   (named tokens, recommended)
 *   "token1,token2"               (anonymous, name defaults to "token-N")
 */
interface LoadedToken {
  name: string;
  buf: Buffer;
}

function loadTokens(raw: string): LoadedToken[] {
  const out: LoadedToken[] = [];
  let idx = 0;
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    idx += 1;
    const colon = trimmed.indexOf(':');
    if (colon > 0 && colon < trimmed.length - 1) {
      const name = trimmed.slice(0, colon).trim();
      const tok = trimmed.slice(colon + 1).trim();
      if (name && tok) out.push({ name, buf: Buffer.from(tok, 'utf8') });
    } else {
      out.push({ name: `token-${idx}`, buf: Buffer.from(trimmed, 'utf8') });
    }
  }
  return out;
}

function constantTimeMatch(tokens: LoadedToken[], presented: string): LoadedToken | null {
  const presentedBuf = Buffer.from(presented, 'utf8');
  let match: LoadedToken | null = null;
  for (const t of tokens) {
    // timingSafeEqual requires equal length. Pad the shorter side against
    // itself so every comparison takes the same path regardless of input
    // length and we still return null for mismatches.
    const a = presentedBuf.length === t.buf.length ? presentedBuf : t.buf;
    const b = t.buf;
    const eq = timingSafeEqual(a, b) && presentedBuf.length === t.buf.length;
    if (eq && !match) match = t;
  }
  return match;
}

function extractCredential(req: FastifyRequest): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const xkey = req.headers['x-api-key'];
  if (typeof xkey === 'string' && xkey.trim()) return xkey.trim();
  return null;
}

/**
 * Returns true when the request URL is for a public surface that must stay
 * reachable without a token: liveness/readiness probes, Prometheus scraping,
 * and inbound GitHub webhooks (which are independently authenticated by
 * HMAC signature verification in the webhook handler).
 */
function isPublicPath(url: string): boolean {
  // Strip query string
  const path = url.split('?', 1)[0];
  if (path === '/healthz' || path === '/readyz' || path === '/metrics') return true;
  if (path.startsWith('/webhooks/')) return true;
  return false;
}

declare module 'fastify' {
  interface FastifyRequest {
    apiAuth?: { tokenName: string };
  }
}

export interface ApiAuthOptions {
  rawTokens: string;
  nodeEnv: 'development' | 'test' | 'production';
}

export async function registerApiAuth(
  app: FastifyInstance,
  opts: ApiAuthOptions = { rawTokens: env.API_AUTH_TOKENS, nodeEnv: env.NODE_ENV as ApiAuthOptions['nodeEnv'] },
): Promise<void> {
  const tokens = loadTokens(opts.rawTokens);

  if (tokens.length === 0) {
    if (opts.nodeEnv === 'production') {
      // Fail closed at startup rather than silently exposing the API.
      throw new Error(
        'API_AUTH_TOKENS is empty in production. Set at least one token (e.g. "dashboard:<random-hex>") or run behind another authenticating gateway.',
      );
    }
    app.log.warn(
      { nodeEnv: opts.nodeEnv },
      'api auth disabled: API_AUTH_TOKENS is empty (allowed outside production)',
    );
    return;
  }

  app.log.info({ tokenCount: tokens.length }, 'api auth enabled');

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url;
    if (!url.startsWith('/api/')) return;
    if (isPublicPath(url)) return;

    const presented = extractCredential(req);
    if (!presented) {
      reply.header('www-authenticate', 'Bearer realm="clawreview-api"');
      reply.code(401);
      return reply.send({ error: 'Unauthorized', message: 'missing bearer token', requestId: req.id });
    }
    const match = constantTimeMatch(tokens, presented);
    if (!match) {
      reply.code(401);
      return reply.send({ error: 'Unauthorized', message: 'invalid token', requestId: req.id });
    }
    req.apiAuth = { tokenName: match.name };
  });
}

// Exported for tests.
export const _internals = { loadTokens, constantTimeMatch, isPublicPath };
