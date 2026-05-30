import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppAuth } from '@clawreview/github';
import { audit } from '@clawreview/db';

import { env } from '../env.js';

/**
 * GitHub App installation discovery endpoints.
 *
 *   GET /api/installations              every installation of this App
 *   GET /api/installations/:id/repos    repositories that installation grants
 *
 * Both routes require the readonly role at minimum. Each successful call
 * writes an audit row so operators can see who enumerated tenant data.
 *
 * When GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is unset (single-tenant
 * local dev, or a deployment that drives reviews through webhooks alone)
 * the routes return 503 with a clear message rather than the previous
 * silent empty list. That avoids the "looks healthy but lies" failure
 * mode where a dashboard renders zero installations and the operator
 * assumes it is just a fresh install.
 */

const IdParam = z.object({
  // GitHub installation IDs are 64-bit signed positive integers. We accept
  // a numeric string and coerce, rejecting anything else.
  id: z
    .string()
    .regex(/^[0-9]{1,19}$/u, 'installation id must be a positive integer')
    .transform((s) => Number.parseInt(s, 10))
    .refine((n) => Number.isSafeInteger(n) && n > 0, 'installation id out of range'),
});

const ReposQuery = z.object({
  per_page: z
    .string()
    .regex(/^[0-9]{1,3}$/u)
    .transform((s) => Number.parseInt(s, 10))
    .refine((n) => n >= 1 && n <= 100, 'per_page must be 1..100')
    .optional(),
  page: z
    .string()
    .regex(/^[0-9]{1,4}$/u)
    .transform((s) => Number.parseInt(s, 10))
    .refine((n) => n >= 1 && n <= 1000, 'page must be 1..1000')
    .optional(),
});

interface AppAuthLike {
  listInstallations: AppAuth['listInstallations'];
  listInstallationRepositories: AppAuth['listInstallationRepositories'];
}

export interface InstallationsRoutesOptions {
  /**
   * Override the AppAuth instance. Tests use this to inject a fetch
   * stub; production code leaves it undefined and the routes build the
   * real client from env at request time (lazily, so unconfigured
   * deployments do not crash at boot).
   */
  appAuth?: AppAuthLike | null;
}

function buildAppAuthFromEnv(): AppAuthLike | null {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return null;
  return new AppAuth({
    appId: env.GITHUB_APP_ID,
    // GitHub App keys are often pasted with literal "\n" sequences in
    // env vars; normalise so the JWT signer gets real newlines.
    privateKey: env.GITHUB_APP_PRIVATE_KEY.includes('\\n')
      ? env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n')
      : env.GITHUB_APP_PRIVATE_KEY,
  });
}

function actorOf(req: FastifyRequest): string {
  return req.apiAuth?.tokenName ? `api-token:${req.apiAuth.tokenName}` : 'api-token:anonymous';
}

export async function registerInstallationsRoutes(
  app: FastifyInstance,
  opts: InstallationsRoutesOptions = {},
): Promise<void> {
  // `opts.appAuth === null` means "explicitly disabled" (used in tests).
  // `undefined` means "build from env on demand".
  const explicit = opts.appAuth;

  function getAuth(): AppAuthLike | null {
    if (explicit !== undefined) return explicit;
    return buildAppAuthFromEnv();
  }

  app.get(
    '/api/installations',
    { preHandler: app.requireRole('readonly') },
    async (req, reply) => {
      const auth = getAuth();
      if (!auth) {
        reply.code(503);
        return {
          error: 'GitHubAppNotConfigured',
          message: 'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set to list installations',
          requestId: req.id,
        };
      }
      try {
        const items = await auth.listInstallations();
        await audit(
          {
            actorLogin: actorOf(req),
            action: 'installations.list',
            subject: 'github-app',
            meta: { count: items.length, requestId: req.id },
          },
          { logger: req.log },
        );
        return { items, count: items.length };
      } catch (err) {
        const status = (err as { status?: number }).status ?? 502;
        req.log.error({ err: (err as Error).message }, 'list installations failed');
        reply.code(status >= 400 && status < 600 ? status : 502);
        return {
          error: 'GitHubUpstreamError',
          message: (err as Error).message,
          requestId: req.id,
        };
      }
    },
  );

  app.get(
    '/api/installations/:id/repos',
    { preHandler: app.requireRole('readonly') },
    async (req, reply) => {
      const params = IdParam.safeParse(req.params);
      if (!params.success) {
        reply.code(400);
        return { error: 'BadParam', issues: params.error.flatten(), requestId: req.id };
      }
      const query = ReposQuery.safeParse(req.query);
      if (!query.success) {
        reply.code(400);
        return { error: 'BadQuery', issues: query.error.flatten(), requestId: req.id };
      }
      const auth = getAuth();
      if (!auth) {
        reply.code(503);
        return {
          error: 'GitHubAppNotConfigured',
          message: 'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set to list repositories',
          requestId: req.id,
        };
      }
      try {
        const page = await auth.listInstallationRepositories(params.data.id, {
          perPage: query.data.per_page,
          page: query.data.page,
        });
        await audit(
          {
            actorLogin: actorOf(req),
            action: 'installations.repos.list',
            subject: `installation:${params.data.id}`,
            meta: {
              count: page.repositories.length,
              totalCount: page.totalCount,
              page: query.data.page ?? 1,
              requestId: req.id,
            },
          },
          { logger: req.log },
        );
        return {
          installationId: params.data.id,
          items: page.repositories,
          totalCount: page.totalCount,
          page: query.data.page ?? 1,
          perPage: query.data.per_page ?? 30,
        };
      } catch (err) {
        const status = (err as { status?: number }).status ?? 502;
        req.log.error(
          { err: (err as Error).message, installationId: params.data.id },
          'list installation repos failed',
        );
        // 404 from GitHub means the installation does not exist (or the
        // App lost access). Propagate it verbatim so the dashboard can
        // distinguish "missing" from "upstream broken".
        reply.code(status === 404 ? 404 : status >= 400 && status < 600 ? status : 502);
        return {
          error: status === 404 ? 'NotFound' : 'GitHubUpstreamError',
          message: (err as Error).message,
          requestId: req.id,
        };
      }
    },
  );
}
