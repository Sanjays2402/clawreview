import { cwd as getCwd } from 'node:process';

import kleur from 'kleur';
import { ProviderRegistry } from '@clawreview/llm';
import { preflightBudget, runPipeline } from '@clawreview/agents';
import {
  aggregate,
  applySeverityRules,
  applySuppressions,
  buildSuppressionMap,
  calibrateConfidence,
  renderReviewReport,
  similarityMerge,
  toCsv,
  toGitlabCodeQuality,
  toJUnitXml,
  toRdjsonl,
  toSarif,
  type ReportMetadata,
} from '@clawreview/aggregator';
import type { Severity } from '@clawreview/types';

import type { ParsedArgs } from '../args.js';
import { loadConfig } from '../config.js';
import { detectBase, gitDiff, revParse } from '../git.js';
import { loadClawreviewIgnore, mergeIgnorePatterns } from '../ignorefile.js';
import { renderTextReport } from '../render.js';

const ENV = {
  base: process.env.LLM_BASE_URL ?? 'http://127.0.0.1:8642/v1',
  apiKey: process.env.LLM_API_KEY ?? '',
  defaultModel: process.env.LLM_DEFAULT_MODEL ?? 'hermes/claude-opus-4',
};

export async function runReview(args: ParsedArgs): Promise<void> {
  const cwd = getCwd();
  const base = String(args.flags.base ?? (await detectBase(cwd)));
  const head = String(args.flags.head ?? 'HEAD');
  const format = String(args.flags.format ?? 'text') as
    | 'text'
    | 'json'
    | 'sarif'
    | 'junit'
    | 'csv'
    | 'gitlab'
    | 'markdown'
    | 'rdjsonl';
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;

  const cfg = await loadConfig(args.flags.config ? String(args.flags.config) : undefined, cwd);
  // Layer .clawreviewignore on top of cfg.ignore so reviewers can keep
  // generated-code or vendored paths out of LLM context without editing
  // the YAML config. Honored before the pipeline so ignored files never
  // reach an agent.
  const ignoreFile = await loadClawreviewIgnore(cwd);
  if (ignoreFile.patterns.length > 0) {
    cfg.ignore = mergeIgnorePatterns(cfg.ignore, ignoreFile.patterns);
    process.stderr.write(
      kleur.gray(
        `  loaded ${ignoreFile.patterns.length} pattern(s) from ${ignoreFile.source}\n`,
      ),
    );
  }
  if (args.flags.threshold) {
    cfg.severity_threshold = String(args.flags.threshold) as Severity;
  }
  // `--min-confidence <n>` lets a one-off run override the configured
  // floor without editing .clawreview.yml. Clamped to [0, 1] on the
  // CLI side too so a bad input fails loudly here rather than silently
  // disabling the floor in aggregate().
  if (args.flags['min-confidence'] !== undefined) {
    const raw = Number(args.flags['min-confidence']);
    if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
      process.stderr.write(
        kleur.red(
          `clawreview: --min-confidence must be a number in [0, 1] (got '${String(args.flags['min-confidence'])}')\n`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    cfg.min_confidence = raw;
  }
  const concurrency = args.flags.concurrency ? Number(args.flags.concurrency) : 6;

  const [headSha, baseSha] = await Promise.all([revParse(head, cwd), revParse(base, cwd)]);
  process.stderr.write(kleur.gray(`Diffing ${base} (${baseSha.slice(0, 7)}) -> ${head} (${headSha.slice(0, 7)})\n`));

  const diff = await gitDiff(base, head, cwd);
  if (!diff.trim()) {
    console.log('No changes between refs.');
    return;
  }

  // Cost pre-flight: estimate spend and either bail (when --fail-on-budget
  // is set) or just print the estimate for visibility. Defaults to print-only
  // so CI runs don't suddenly fail after upgrading clawreview.
  const failOnBudget = Boolean(args.flags['fail-on-budget']);
  const preflight = preflightBudget({ diffText: diff, config: cfg, spentUsd: 0 });
  process.stderr.write(
    kleur.gray(
      `  estimated cost: $${preflight.estimate.totalUsd.toFixed(4)}  ` +
        `(${preflight.estimate.chunks} chunks across ${preflight.estimate.byAgent.length} agent(s))\n`,
    ),
  );
  if (failOnBudget && !preflight.ok) {
    process.stderr.write(kleur.red(`  preflight blocked: ${preflight.reason}\n`));
    process.exitCode = 3;
    return;
  }

  const provider = new ProviderRegistry({
    hermesBaseUrl: ENV.base,
    copilotBaseUrl: ENV.base,
    openaiBaseUrl: ENV.base,
    openaiApiKey: ENV.apiKey || undefined,
    copilotApiKey: ENV.apiKey || undefined,
  });

  const { summary, findings } = await runPipeline({
    diffText: diff,
    config: cfg,
    cwd,
    providerRegistry: provider,
    concurrency,
    pullRequest: {
      owner: 'local',
      repo: cwd.split('/').pop() ?? 'repo',
      number: 0,
      headSha,
      baseSha,
    },
    onAgentEnd: ({ agent, chunk, durationMs, findings, error }) => {
      const status = error ? kleur.red('FAIL') : kleur.green('OK');
      process.stderr.write(
        kleur.gray(`  ${status} ${agent.padEnd(14)} ${chunk}  ${durationMs}ms  ${findings} findings\n`),
      );
    },
  });

  const ruled = applySeverityRules(findings, cfg);
  if (ruled.applied.length > 0) {
    process.stderr.write(
      kleur.gray(`  applied ${ruled.applied.length} severity rule match(es)\n`),
    );
  }
  if (ruled.dropped.length > 0) {
    process.stderr.write(
      kleur.gray(`  dropped ${ruled.dropped.length} finding(s) via severity_rules drop\n`),
    );
  }

  // Confidence calibration mirrors the worker's behaviour so local runs
  // produce identical severity calls. Floors low-confidence nits and
  // promotes high-confidence security findings before aggregation.
  const calibrated = calibrateConfidence(ruled.findings);
  if (calibrated.applied.length > 0) {
    process.stderr.write(
      kleur.gray(`  calibrated ${calibrated.applied.length} finding(s) by confidence\n`),
    );
  }

  // Cross-agent similarity merge: collapses findings that two different
  // agents report on the same line with overlapping rationale (e.g.
  // security + sql-injection both flagging the same query). Runs AFTER
  // calibration so the winner is chosen against post-calibration
  // severity, and BEFORE aggregate so the per-file cap doesn't waste
  // a slot on a merged-away duplicate.
  const sim = similarityMerge(calibrated.findings);
  if (sim.merged.length > 0) {
    process.stderr.write(
      kleur.gray(`  merged ${sim.merged.length} cross-agent duplicate(s)\n`),
    );
  }

  const result = aggregate(sim.findings, {
    threshold: cfg.severity_threshold,
    maxPerFile: cfg.max_findings_per_file,
    minConfidence: cfg.min_confidence,
  });

  if (cfg.min_confidence > 0) {
    // Count findings the floor dropped (independent of dedup/truncation
    // counts so the number a user sees here is the one tied to the
    // knob they tuned).
    const dropped = sim.findings.filter((f) => f.confidence < cfg.min_confidence).length;
    if (dropped > 0) {
      process.stderr.write(
        kleur.gray(`  dropped ${dropped} finding(s) below min_confidence=${cfg.min_confidence}\n`),
      );
    }
  }

  // Honor inline clawreview-ignore markers in the diff so local runs match
  // what the server-side worker would post on a real PR.
  const suppressionMap = buildSuppressionMap(diff);
  const suppression = applySuppressions(result.findings, suppressionMap);
  if (suppression.suppressed.length > 0) {
    process.stderr.write(
      kleur.gray(`  suppressed ${suppression.suppressed.length} finding(s) via inline markers\n`),
    );
  }
  result.findings = suppression.kept;
  // Recompute severity totals to reflect suppressions, so exit codes and
  // rendered counts match what the user actually sees.
  for (const k of Object.keys(result.totals) as Array<keyof typeof result.totals>) {
    result.totals[k] = 0;
  }
  for (const f of result.findings) result.totals[f.severity] += 1;

  if (format === 'json') {
    console.log(JSON.stringify({ summary, aggregated: result }, null, 2));
    return;
  }
  if (format === 'sarif') {
    console.log(JSON.stringify(toSarif(result, { commitSha: await safeRevParse(cwd, head) }), null, 2));
    return;
  }
  if (format === 'junit') {
    process.stdout.write(toJUnitXml(result));
    return;
  }
  if (format === 'csv') {
    process.stdout.write(toCsv(result));
    return;
  }
  if (format === 'gitlab') {
    // GitLab Code Quality expects a JSON array; emit with indentation so
    // the artifact is human-readable when diffed across runs.
    console.log(JSON.stringify(toGitlabCodeQuality(result), null, 2));
    return;
  }
  if (format === 'rdjsonl') {
    // Reviewdog rdjsonl is one JSON diagnostic per line, no trailing
    // wrapper; pipe with `clawreview run --format rdjsonl | reviewdog -f rdjsonl`.
    process.stdout.write(toRdjsonl(result));
    return;
  }
  if (format === 'markdown') {
    // Standalone Markdown report. Useful for pasting into Notion, attaching
    // to a chat, or producing a CI artifact. We derive ReviewMetadata from
    // the pipeline summary so the heading, agent table, and totals reflect
    // the exact run that produced the findings.
    const meta = toReportMetadata(summary, cwd);
    process.stdout.write(renderReviewReport(meta, result.findings));
    return;
  }
  console.log(renderTextReport(result, { noColor }));
  if (result.totals.critical > 0) process.exitCode = 2;
  else if (result.totals.high > 0) process.exitCode = 1;
}

function toReportMetadata(
  summary: Awaited<ReturnType<typeof runPipeline>>['summary'],
  cwd: string,
): ReportMetadata {
  const completed = summary.completedAt ? new Date(summary.completedAt) : undefined;
  const started = new Date(summary.startedAt);
  const durationMs = completed ? completed.getTime() - started.getTime() : undefined;
  return {
    reviewId: `local-${started.getTime().toString(36)}`,
    owner: summary.pullRequest.owner,
    repo: summary.pullRequest.repo || (cwd.split('/').pop() ?? 'repo'),
    prNumber: summary.pullRequest.number,
    headSha: summary.pullRequest.headSha,
    baseSha: summary.pullRequest.baseSha,
    status: summary.status,
    createdAt: summary.startedAt,
    completedAt: summary.completedAt,
    durationMs,
    totalCostUsd: summary.totalCostUsd,
    agentExecutions: summary.agentExecutions.map((e) => ({
      agent: e.agent,
      status: e.status,
      durationMs: e.durationMs,
      findings: e.findings.length,
      error: e.error,
    })),
  };
}

async function safeRevParse(cwd: string, ref: string): Promise<string | undefined> {
  try {
    return await revParse(ref, cwd);
  } catch {
    return undefined;
  }
}
