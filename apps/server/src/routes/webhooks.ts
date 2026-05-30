import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyWebhookSignature } from '@clawreview/github';
import { InstallationPayloadSchema, PullRequestPayloadSchema } from '@clawreview/types';

import { env } from '../env.js';
import { REVIEW_JOB, getQueue } from '../queue.js';
import { getDeliveryCache } from '../services/delivery-cache.js';
import { getReviewStore } from '../services/review-store.js';
import { getRepoHealth } from '../services/repo-health.js';

const SUPPORTED_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

function parseLoginList(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function shouldSkipAuthor(
  login: string | undefined,
  opts: { allowBots: boolean; skipAuthors: Set<string> },
): { skip: true; reason: 'bot' | 'author' } | { skip: false } {
  if (!login) return { skip: false };
  const lower = login.toLowerCase();
  if (opts.skipAuthors.has(lower)) return { skip: true, reason: 'author' };
  if (!opts.allowBots && lower.endsWith('[bot]')) return { skip: true, reason: 'bot' };
  return { skip: false };
}

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        done(null, body.length === 0 ? {} : JSON.parse((body as Buffer).toString('utf8')));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.post('/webhooks/github', async (req, reply) => {
    const headerSchema = z.object({
      'x-github-event': z.string(),
      'x-github-delivery': z.string(),
      'x-hub-signature-256': z.string().optional(),
    });
    const headers = headerSchema.safeParse(req.headers);
    if (!headers.success) {
      reply.code(400);
      return { error: 'BadHeaders' };
    }

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      reply.code(400);
      return { error: 'MissingBody' };
    }

    if (env.GITHUB_WEBHOOK_SECRET) {
      const ok = verifyWebhookSignature(rawBody, headers.data['x-hub-signature-256'], env.GITHUB_WEBHOOK_SECRET);
      if (!ok) {
        req.log.warn({ delivery: headers.data['x-github-delivery'] }, 'webhook signature failed');
        reply.code(401);
        return { error: 'BadSignature' };
      }
    } else if (env.NODE_ENV === 'production') {
      reply.code(503);
      return { error: 'WebhookSecretNotConfigured' };
    }

    const event = headers.data['x-github-event'];
    const delivery = headers.data['x-github-delivery'];

    // Idempotency: GitHub will redeliver the exact same payload on retry,
    // and operators sometimes manually replay from the dashboard. Accept
    // the first delivery; ack later ones without enqueueing again.
    const fresh = getDeliveryCache().reserve(delivery);
    if (!fresh) {
      req.log.info({ event, delivery }, 'duplicate webhook delivery ignored');
      return { ok: true, duplicate: true, delivery };
    }

    try {
      if (event === 'pull_request') {
        const payload = PullRequestPayloadSchema.parse(req.body);
        if (!SUPPORTED_PR_ACTIONS.has(payload.action)) {
          return { ok: true, ignored: true };
        }
        if (!payload.installation) {
          reply.code(400);
          return { error: 'MissingInstallation' };
        }
        if (payload.pull_request.draft && payload.action !== 'ready_for_review') {
          return { ok: true, ignored: true, reason: 'draft' };
        }
        const authorSkip = shouldSkipAuthor(payload.pull_request.user?.login, {
          allowBots: env.REVIEW_BOT_PRS,
          skipAuthors: parseLoginList(env.REVIEW_SKIP_AUTHORS),
        });
        if (authorSkip.skip) {
          req.log.info(
            { author: payload.pull_request.user?.login, reason: authorSkip.reason },
            'webhook ignored: author filter',
          );
          return { ok: true, ignored: true, reason: authorSkip.reason };
        }
        const health = getRepoHealth();
        if (health.isPaused(payload.repository.owner.login, payload.repository.name)) {
          const state = health.get(payload.repository.owner.login, payload.repository.name);
          req.log.warn(
            { repo: payload.repository.full_name, reason: state?.pausedReason },
            'webhook ignored: repo paused',
          );
          return {
            ok: true,
            ignored: true,
            reason: 'repo_paused',
            pausedUntil: state?.pausedUntil,
          };
        }
        const queue = getQueue();
        const store = getReviewStore();
        const started = await store.start({
          installationId: payload.installation.id,
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          prNumber: payload.number,
          headSha: payload.pull_request.head.sha,
          baseSha: payload.pull_request.base.sha,
        });
        const jobId = `pr-${payload.repository.full_name}-${payload.number}-${payload.pull_request.head.sha}`;
        await queue.enqueue(REVIEW_JOB, {
          reviewId: started.id,
          installationId: payload.installation.id,
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          prNumber: payload.number,
          headSha: payload.pull_request.head.sha,
          baseSha: payload.pull_request.base.sha,
          reason: payload.action,
        }, { jobId });
        return { ok: true, queued: jobId, reviewId: started.id };
      }

      if (event === 'installation' || event === 'installation_repositories') {
        const payload = InstallationPayloadSchema.safeParse(req.body);
        if (!payload.success) return { ok: true };
        req.log.info({ event, action: payload.data.action, installation: payload.data.installation.id }, 'installation event');
        return { ok: true };
      }

      if (event === 'ping') return { ok: true, pong: true };
      return { ok: true, ignored: true, event };
    } catch (err) {
      req.log.error({ err, event, delivery }, 'webhook handling failed');
      reply.code(400);
      return { error: 'BadPayload', message: (err as Error).message };
    }
  });
}
