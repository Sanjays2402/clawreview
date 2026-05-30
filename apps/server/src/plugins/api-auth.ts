import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { audit } from '@clawreview/db';

import { env } from '../env.js';

/**
 * Roles available to API tokens. Higher tiers strictly include lower tiers:
 *
 *   readonly  GET on any /api/* endpoint
 *   operator  readonly + day-to-day mutations (budget edits, rerun, pause/resume,
 *             finding acknowledgement, config validation)
 *   admin     operator + privileged operations (audit log read, GDPR export
 *             and account deletion)
 *
 * Tokens without an explicit role default to `admin` to preserve the
 * pre-RBAC contract for upgraded deployments. Operators should re-issue
 * tokens with explicit roles after upgrading.
 */
export type Role = 'readonly' | 'operator' | 'admin';

const ROLE_RANK: Record<Role, number> = { readonly: 1, operator: 2, admin: 3 };

export function roleSatisfies(have: Role, need: Role): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}

/**
 * Loaded API tokens. The map is name -> raw token bytes so we can do a
 * constant-time compare and still log which credential was used (by name)
 * without ever logging the secret itself.
 *
 * Format of API_AUTH_TOKENS:
 *   "name:role:token,..."   role one of readonly|operator|admin (recommended)
 *   "name:token,..."        role defaults to admin (legacy)
 *   "token,..."             anonymous, role defaults to admin (legacy)
 */
interface LoadedToken {
  name: string;
  role: Role;
  buf: Buffer;
}

function isRole(s: string): s is Role {
  return s === 'readonly' || s === 'operator' || s === 'admin';
}

function loadTokens(raw: string): LoadedToken[] {
  const out: LoadedToken[] = [];
  let idx = 0;
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    idx += 1;
    const parts = trimmed.split(':').map((p) => p.trim());
    if (parts.length >= 3 && parts[0] && isRole(parts[1]) && parts.slice(2).join(':')) {
      // name:role:token (token may itself contain colons, hence join)
      out.push({ name: parts[0], role: parts[1], buf: Buffer.from(parts.slice(2).join(':'), 'utf8') });
    } else if (parts.length === 2 && parts[0] && parts[1] && !isRole(parts[1])) {
      // name:token legacy
      out.push({ name: parts[0], role: 'admin', buf: Buffer.from(parts[1], 'utf8') });
    } else {
      // bare token
      out.push({ name: `token-${idx}`, role: 'admin', buf: Buffer.from(trimmed, 'utf8') });
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
    apiAuth?: { tokenName: string; role: Role };
  }
  interface FastifyInstance {
    requireRole: (role: Role) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
  const enforce = tokens.length > 0;

  if (!enforce) {
    if (opts.nodeEnv === 'production') {
      // Fail closed at startup rather than silently exposing the API.
      throw new Error(
        'API_AUTH_TOKENS is empty in production. Set at least one token (e.g. "dashboard:admin:<random-hex>") or run behind another authenticating gateway.',
      );
    }
    app.log.warn(
      { nodeEnv: opts.nodeEnv },
      'api auth disabled: API_AUTH_TOKENS is empty (allowed outside production)',
    );
  } else {
    const byRole = tokens.reduce<Record<Role, number>>(
      (acc, t) => ({ ...acc, [t.role]: acc[t.role] + 1 }),
      { readonly: 0, operator: 0, admin: 0 },
    );
    app.log.info({ tokenCount: tokens.length, byRole }, 'api auth enabled');
  }

  // Decorate first so routes can call app.requireRole() even when auth is
  // disabled for local dev. In disabled mode the guard is a no-op so
  // existing tests keep passing without setting tokens.
  app.decorate('requireRole', (need: Role) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!enforce) return;
      const have = req.apiAuth?.role;
      if (!have) {
        // No bearer reached us. The onRequest hook below should already
        // have rejected, but stay defensive.
        reply.code(401);
        return reply.send({ error: 'Unauthorized', message: 'missing bearer token', requestId: req.id });
      }
      if (!roleSatisfies(have, need)) {
        // Persist a forbidden attempt so abuse is visible in the audit
        // trail. Failures inside audit() are swallowed by its own contract.
        await audit(
          {
            actorLogin: `token:${req.apiAuth?.tokenName ?? 'unknown'}`,
            action: 'api.forbidden',
            subject: `${req.method} ${req.url.split('?', 1)[0]}`,
            meta: { have, need, requestId: req.id },
          },
          { logger: req.log },
        );
        reply.code(403);
        return reply.send({
          error: 'Forbidden',
          message: `role '${have}' cannot access this route (requires '${need}')`,
          requestId: req.id,
        });
      }
    };
  });

  if (!enforce) return;

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
    req.apiAuth = { tokenName: match.name, role: match.role };
  });
}

// Exported for tests.
export const _internals = { loadTokens, constantTimeMatch, isPublicPath, roleSatisfies };
