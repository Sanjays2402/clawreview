import type { Logger } from 'pino';
import YAML from 'yaml';
import {
  AppAuth,
  COMMENT_MARKER,
  GitHubClient,
} from '@clawreview/github';
import { ProviderRegistry } from '@clawreview/llm';
import { aggregate, applySuppressions, buildInlineComments, buildSuppressionMap, deriveCheckRun, renderPrComment } from '@clawreview/aggregator';
import { runPipeline } from '@clawreview/agents';
import { ClawReviewConfigSchema, DEFAULT_CONFIG } from '@clawreview/types';

import { env } from './env.js';
import { REVIEW_JOB, getQueue, type ReviewJobData } from './queue.js';
import { getReviewStore } from './services/review-store.js';
import { getBudgetGuard } from './budget.js';

const BUDGET_BLOCKED_BODY = (limitUsd: number, spentUsd: number, periodKey: string) =>
  [
    '### ClawReview',
    '',
    `Skipping this review. The installation has reached its monthly LLM budget for ${periodKey} ` +
      `($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)} spent).`,
    '',
    'Raise `budget.monthly_usd` in `.clawreview.yml`, or wait for the next billing month.',
  ].join('\n');

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

    let inProgressCheckRunId: number | undefined;
    let ghForCleanup: GitHubClient | undefined;
    try {

    const auth = new AppAuth({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    });
    const token = await auth.installationToken(data.installationId);
    const gh = new GitHubClient(token);
    ghForCleanup = gh;

    const cfgRaw = await gh.fetchRawFile({
      owner: data.owner,
      repo: data.repo,
      path: '.clawreview.yml',
      ref: data.headSha,
    });
    const cfg = parseConfig(cfgRaw, log);

    // Budget gate. Bail before spending any tokens if the installation is over
    // its monthly LLM budget; post a single comment so the PR author knows why.
    const budget = getBudgetGuard(env.DEFAULT_MONTHLY_BUDGET_USD);
    const limit = cfg.budget?.monthly_usd ?? env.DEFAULT_MONTHLY_BUDGET_USD;
    if (budget.wouldExceed(data.installationId, 0, limit)) {
      const snap = budget.snapshot(data.installationId, limit);
      log.warn({ snap }, 'installation over budget, skipping review');
      const skipBody = `${COMMENT_MARKER}\n${BUDGET_BLOCKED_BODY(snap.limitUsd, snap.spentUsd, snap.periodKey)}`;
      await gh.upsertReviewComment(
        { owner: data.owner, repo: data.repo, number: data.prNumber },
        { marker: COMMENT_MARKER, body: skipBody },
      );
      await store.fail(data.reviewId, new Error('budget_exhausted'));
      return;
    }

    const diff = await gh.fetchPrDiff({ owner: data.owner, repo: data.repo, number: data.prNumber });

    // Surface progress on the PR immediately so a long review run doesn't
    // look like silence. We create the check-run as `in_progress` here and
    // PATCH it to `completed` after aggregation. If creation fails (e.g.
    // missing checks: write permission on the App), we log and continue;
    // the final createCheckRun fallback below still runs.
    try {
      const startedCheck = await gh.createCheckRun(
        { owner: data.owner, repo: data.repo },
        {
          name: 'ClawReview',
          head_sha: data.headSha,
          status: 'in_progress',
          started_at: new Date().toISOString(),
          output: {
            title: 'ClawReview is analyzing this PR',
            summary:
              'Specialized agents are running over the diff. This check will update once review completes.',
          },
        },
      );
      inProgressCheckRunId = (startedCheck as { id?: number } | undefined)?.id;
    } catch (err) {
      log.warn({ err }, 'in_progress check-run creation failed, continuing');
    }

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

    // Honor inline `clawreview-ignore` / `clawreview-ignore-next-line`
    // markers in the diff. Suppressed findings are recorded for telemetry
    // but not posted.
    const suppressionMap = buildSuppressionMap(diff);
    const suppression = applySuppressions(aggregated.findings, suppressionMap);
    if (suppression.suppressed.length > 0) {
      log.info(
        { suppressed: suppression.suppressed.length, kept: suppression.kept.length },
        'inline suppression applied',
      );
    }
    aggregated.findings = suppression.kept;
    // Recompute totals and per-file groups from the surviving findings so
    // the rendered comment and the persisted summary agree with the body.
    for (const k of Object.keys(aggregated.totals) as Array<keyof typeof aggregated.totals>) {
      aggregated.totals[k] = 0;
    }
    const perFile = new Map<string, typeof aggregated.findings>();
    for (const f of aggregated.findings) {
      aggregated.totals[f.severity] += 1;
      const list = perFile.get(f.file) ?? [];
      list.push(f);
      perFile.set(f.file, list);
    }
    aggregated.groupedByFile = [...perFile.entries()].map(([file, list]) => ({ file, findings: list }));

    const body = `${COMMENT_MARKER}\n${renderPrComment(aggregated, {
      prNumber: data.prNumber,
      headSha: data.headSha,
      dashboardUrl: `${env.DASHBOARD_URL}/r/${encodeURIComponent(`${data.owner}/${data.repo}`)}/${data.prNumber}`,
    })}`;

    const commentResult = await gh.upsertReviewComment(
      { owner: data.owner, repo: data.repo, number: data.prNumber },
      { marker: COMMENT_MARKER, body },
    );

    // Optional: post inline review comments anchored on patched lines.
    if (cfg.inline_comments?.enabled) {
      try {
        const { anchored } = buildInlineComments(aggregated.findings, diff, {
          minSeverity: cfg.inline_comments.min_severity,
          max: cfg.inline_comments.max,
        });
        if (anchored.length > 0) {
          const review = await gh.createReview(
            { owner: data.owner, repo: data.repo, number: data.prNumber },
            {
              commitSha: data.headSha,
              body: `ClawReview posted ${anchored.length} inline ${anchored.length === 1 ? 'comment' : 'comments'}.`,
              comments: anchored,
            },
          );
          log.info({ reviewId: review.id, inlineCount: review.submittedInlineCount }, 'inline review posted');
        }
      } catch (err) {
        log.warn({ err }, 'inline review failed, continuing with summary comment only');
      }
    }

    const check = deriveCheckRun(aggregated, data.headSha);
    let checkRun: { id: number } | undefined;
    if (inProgressCheckRunId) {
      // Promote the existing in_progress run to completed so PR authors
      // see a single check entry transition, not two separate ones.
      try {
        checkRun = await gh.updateCheckRun(
          { owner: data.owner, repo: data.repo, checkRunId: inProgressCheckRunId },
          {
            ...check,
            status: 'completed',
            completed_at: new Date().toISOString(),
          },
        );
      } catch (err) {
        log.warn({ err, checkRunId: inProgressCheckRunId }, 'check-run update failed, recreating');
      }
    }
    if (!checkRun) {
      checkRun = await gh.createCheckRun(
        { owner: data.owner, repo: data.repo },
        {
          ...check,
          head_sha: data.headSha,
        },
      );
    }

    await store.complete(data.reviewId, summary, aggregated.findings, {
      commentId: (commentResult as { id?: number } | undefined)?.id,
      checkRunId: (checkRun as { id?: number } | undefined)?.id,
    });

    // Record cost after the run completes so the next job sees the new total.
    budget.spent(data.installationId, summary.totalCostUsd, limit);

    log.info(
      {
        findings: aggregated.findings.length,
        agents: summary.agentExecutions.map((a) => ({ name: a.agent, status: a.status, ms: a.durationMs })),
      },
      'review job completed',
    );
    } catch (err) {
      log.error({ err }, 'review job failed');
      // If we already posted an in_progress check-run, flip it to failure
      // so the PR doesn't show a stuck running check after a crash.
      if (ghForCleanup && inProgressCheckRunId) {
        try {
          await ghForCleanup.updateCheckRun(
            { owner: data.owner, repo: data.repo, checkRunId: inProgressCheckRunId },
            {
              status: 'completed',
              conclusion: 'failure',
              completed_at: new Date().toISOString(),
              output: {
                title: 'ClawReview failed',
                summary:
                  'The review pipeline raised an error before findings could be posted. Check the worker logs or rerun from the dashboard.',
              },
            },
          );
        } catch (cleanupErr) {
          log.warn({ err: cleanupErr }, 'failed to mark check-run as failure on cleanup');
        }
      }
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
