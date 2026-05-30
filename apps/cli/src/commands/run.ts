import { cwd as getCwd } from 'node:process';

import kleur from 'kleur';
import { ProviderRegistry } from '@clawreview/llm';
import { runPipeline } from '@clawreview/agents';
import { aggregate, applySuppressions, buildSuppressionMap } from '@clawreview/aggregator';
import type { Severity } from '@clawreview/types';

import type { ParsedArgs } from '../args.js';
import { loadConfig } from '../config.js';
import { detectBase, gitDiff, revParse } from '../git.js';
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
  const format = String(args.flags.format ?? 'text') as 'text' | 'json' | 'sarif';
  const noColor = Boolean(args.flags['no-color']) || !process.stdout.isTTY;

  const cfg = await loadConfig(args.flags.config ? String(args.flags.config) : undefined, cwd);
  if (args.flags.threshold) {
    cfg.severity_threshold = String(args.flags.threshold) as Severity;
  }
  const concurrency = args.flags.concurrency ? Number(args.flags.concurrency) : 6;

  const [headSha, baseSha] = await Promise.all([revParse(head, cwd), revParse(base, cwd)]);
  process.stderr.write(kleur.gray(`Diffing ${base} (${baseSha.slice(0, 7)}) -> ${head} (${headSha.slice(0, 7)})\n`));

  const diff = await gitDiff(base, head, cwd);
  if (!diff.trim()) {
    console.log('No changes between refs.');
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

  const result = aggregate(findings, {
    threshold: cfg.severity_threshold,
    maxPerFile: cfg.max_findings_per_file,
  });

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
    console.log(JSON.stringify(toSarif(result), null, 2));
    return;
  }
  console.log(renderTextReport(result, { noColor }));
  if (result.totals.critical > 0) process.exitCode = 2;
  else if (result.totals.high > 0) process.exitCode = 1;
}

function toSarif(result: ReturnType<typeof aggregate>) {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'clawreview', version: '0.1.0' } },
        results: result.findings.map((f) => ({
          ruleId: `${f.agent}.${f.category}`,
          level: levelFor(f.severity),
          message: { text: `${f.title}\n${f.rationale}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file },
                region: { startLine: f.startLine, endLine: f.endLine ?? f.startLine },
              },
            },
          ],
        })),
      },
    ],
  };
}

function levelFor(severity: Severity): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium' || severity === 'low') return 'warning';
  return 'note';
}
