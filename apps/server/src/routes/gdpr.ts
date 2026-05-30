import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, deleteUserData, exportUserData } from '@clawreview/db';

/**
 * GDPR data lifecycle endpoints.
 *
 * Both routes are gated by the standard API auth plugin (any token under
 * /api/* must present a bearer credential). In practice these endpoints
 * should be called by the dashboard's DPO surface or by an operator on
 * behalf of a verified data subject. Every successful call writes an audit
 * row so the fulfilment is traceable.
 *
 * Endpoints
 *   GET    /api/users/:login/data-export   right-to-access dump
 *   DELETE /api/users/:login               right-to-erasure
 */

// GitHub logins are case-insensitive, 1-39 chars, alphanumerics and single
// hyphens. We accept the looser pattern and let the DB lookup be the
// source of truth on existence.
const LoginParam = z.object({
  login: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u, 'invalid login'),
});

function actorOf(req: { apiAuth?: { tokenName: string } }): string {
  return req.apiAuth?.tokenName ? `api-token:${req.apiAuth.tokenName}` : 'api-token:anonymous';
}

export async function registerGdprRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users/:login/data-export', { preHandler: app.requireRole('admin') }, async (req, reply) => {
    const parsed = LoginParam.safeParse(req.params);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadParam', issues: parsed.error.flatten() };
    }
    const { login } = parsed.data;

    let bundle;
    try {
      bundle = await exportUserData(login);
    } catch (err) {
      req.log.error({ err: (err as Error).message, login }, 'gdpr export failed');
      reply.code(503);
      return { error: 'ExportUnavailable', message: 'data store unavailable' };
    }

    if (!bundle) {
      reply.code(404);
      return { error: 'NotFound', message: `no user with login ${login}` };
    }

    await audit(
      {
        actorLogin: actorOf(req),
        action: 'gdpr.export',
        subject: `user:${login}`,
        meta: { records: bundle.auditEntries.length + bundle.sessions.length + bundle.memberships.length + 1 },
      },
      { logger: req.log },
    );

    reply.header('content-disposition', `attachment; filename="user-${login}-export.json"`);
    return bundle;
  });

  app.delete('/api/users/:login', { preHandler: app.requireRole('admin') }, async (req, reply) => {
    const parsed = LoginParam.safeParse(req.params);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'BadParam', issues: parsed.error.flatten() };
    }
    const { login } = parsed.data;

    let receipt;
    try {
      receipt = await deleteUserData(login);
    } catch (err) {
      req.log.error({ err: (err as Error).message, login }, 'gdpr delete failed');
      reply.code(503);
      return { error: 'DeleteUnavailable', message: 'data store unavailable' };
    }

    if (!receipt) {
      reply.code(404);
      return { error: 'NotFound', message: `no user with login ${login}` };
    }

    await audit(
      {
        actorLogin: actorOf(req),
        action: 'gdpr.delete',
        subject: `user:${login}`,
        meta: {
          pseudonym: receipt.pseudonym,
          sessions: receipt.sessionsDeleted,
          memberships: receipt.membershipsDeleted,
          auditAnonymised: receipt.auditEntriesAnonymised,
        },
      },
      { logger: req.log },
    );

    return receipt;
  });
}
