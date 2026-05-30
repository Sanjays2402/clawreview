import type { Logger } from 'pino';
import YAML from 'yaml';
import {
  AppAuth,
  COMMENT_MARKER,
  GitHubClient,
} from '@clawreview/github';
import { ProviderRegistry } from '@clawreview/llm';
import { aggregate, deriveCheckRun, renderPrComment } from '@clawreview/aggregator';
import { runPipeline } from '@clawreview/agents';
import { ClawReviewConfigSchema, DEFAULT_CONFIG } from '@clawreview/types';

import { env } from './env.js';
import { REVIEW_JOB, getQueue, type ReviewJobData } from './queue.js';
import { getReviewStore } from './services/review-store.js';

export async function startWorker(logger: Logger): Promise<void> {
  const queue = getQueue();
  const providerRegistry = new ProviderRegistry({
    hermesBaseUrl: env.LLM_HERMES_BASE_URL,
    copilotBaseUrl: env.LLM_COPILOT_BASE_URL,
    copilotApiKey: env.LLM_COPILOT_API_KEY || undefined,
    openaiBaseUrl: env.LLM_OPENAI_BASE_URL,
    openaiApiKey: env.LLM_OPENAI_API_KEY || undefined,
  });

  await queue.process(REVIEW_JOB, async (raw) => {
    const data = raw as ReviewJobData;
    const log = logger.child({ job: REVIEW_JOB, owner: data.owner, repo: data.repo, pr: data.prNumber, reviewId: data.reviewId });
    log.info({ headSha: data.headSha, reason: data.reason }, 'review job started');
    const store = getReviewStore();
    try {
      await store.markRunning(data.reviewId);
    } catch (err) {
      log.warn({ err }, 'markRunning failed');
    }

    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
      log.warn('GitHub App credentials missing, cannot post results');
      await store.fail(data.reviewId, new Error('GitHub App credentials not configured'));
      return;
    }

    try {

    const auth = new AppAuth({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    });
    const token = await auth.installationToken(data.installationId);
    const gh = new GitHubClient(token);

    const cfgRaw = await gh.fetchRawFile({
      owner: data.owner,
      repo: data.repo,
      path: '.clawreview.yml',
      ref: data.headSha,
    });
    const cfg = parseConfig(cfgRaw, log);

    const diff = await gh.fetchPrDiff({ owner: data.owner, repo: data.repo, number: data.prNumber });

    const { summary, findings } = await runPipeline({
      diffText: diff,
      config: cfg,
      providerRegistry,
      concurrency: env.REVIEW_CONCURRENCY,
      pullRequest: {
        owner: data.owner,
        repo: data.repo,
        number: data.prNumber,
        headSha: data.headSha,
        baseSha: data.baseSha,
      },
    });

    const aggregated = aggregate(findings, {
      threshold: cfg.severity_threshold,
      maxPerFile: cfg.max_findings_per_file,
    });

    const body = `${COMMENT_MARKER}\n${renderPrComment(aggregated, {
      prNumber: data.prNumber,
      headSha: data.headSha,
      dashboardUrl: `${env.DASHBOARD_URL}/r/${encodeURIComponent(`${data.owner}/${data.repo}`)}/${data.prNumber}`,
    })}`;

    const commentResult = await gh.upsertReviewComment(
      { owner: data.owner, repo: data.repo, number: data.prNumber },
      { marker: COMMENT_MARKER, body },
    );

    const check = deriveCheckRun(aggregated, data.headSha);
    const checkRun = await gh.createCheckRun(
      { owner: data.owner, repo: data.repo },
      {
        ...check,
        head_sha: data.headSha,
      },
    );

    await store.complete(data.reviewId, summary, aggregated.findings, {
      commentId: (commentResult as { id?: number } | undefined)?.id,
      checkRunId: (checkRun as { id?: number } | undefined)?.id,
    });

    log.info(
      {
        findings: aggregated.findings.length,
        agents: summary.agentExecutions.map((a) => ({ name: a.agent, status: a.status, ms: a.durationMs })),
      },
      'review job completed',
    );
    } catch (err) {
      log.error({ err }, 'review job failed');
      await store.fail(data.reviewId, err as Error);
      throw err;
    }
  });
}

function parseConfig(raw: string | null, log: Logger) {
  if (!raw) return DEFAULT_CONFIG;
  try {
    const parsed = YAML.parse(raw);
    return ClawReviewConfigSchema.parse(parsed);
  } catch (err) {
    log.warn({ err }, 'invalid .clawreview.yml, falling back to defaults');
    return DEFAULT_CONFIG;
  }
}
