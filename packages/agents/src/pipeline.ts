import type { ClawReviewConfig, Finding, ReviewSummary } from '@clawreview/types';
import { ProviderRegistry } from '@clawreview/llm';
import { chunkFile, FileContextLoader, filterIgnored, parseUnifiedDiff, selectReviewableFiles } from '@clawreview/diff';

import type { Agent } from './agent.js';
import { AGENT_REGISTRY } from './registry.js';

export interface PipelineInput {
  diffText: string;
  config: ClawReviewConfig;
  cwd?: string;
  providerRegistry: ProviderRegistry;
  /** Override the default registry (used for tests). */
  agents?: Partial<Record<string, Agent>>;
  /** Concurrency cap across (chunk x agent) tasks. */
  concurrency?: number;
  pullRequest: ReviewSummary['pullRequest'];
  signal?: AbortSignal;
  onAgentStart?: (info: { agent: string; chunk: string }) => void;
  onAgentEnd?: (info: { agent: string; chunk: string; durationMs: number; findings: number; error?: Error }) => void;
}

export interface PipelineResult {
  summary: ReviewSummary;
  findings: Finding[];
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const startedAt = new Date();
  const parsed = parseUnifiedDiff(input.diffText);
  const ignored = filterIgnored(parsed.files, input.config.ignore);
  const { files, skipped } = selectReviewableFiles(ignored, {
    maxChangedLines: input.config.review_limits?.max_changed_lines_per_file,
    maxPatchBytes: input.config.review_limits?.max_patch_bytes_per_file,
    includeGenerated: input.config.review_limits?.include_generated,
  });

  const chunks = files.flatMap((f) => chunkFile(f));
  const contextLoader = input.cwd
    ? new FileContextLoader({ cwd: input.cwd, contextLines: 12 })
    : null;

  const agentsToRun = input.config.agents
    .map((name) => input.agents?.[name] ?? AGENT_REGISTRY[name])
    .filter((a): a is Agent => Boolean(a));

  const concurrency = Math.max(1, input.concurrency ?? 6);
  const tasks: Array<() => Promise<AgentExecutionLocal>> = [];

  for (const chunk of chunks) {
    for (const agent of agentsToRun) {
      tasks.push(async () => {
        const t0 = Date.now();
        input.onAgentStart?.({ agent: agent.name, chunk: chunk.file.path });
        try {
          const surrounding = contextLoader
            ? await contextLoader.surround(chunk.file.path, chunk.startLine, chunk.endLine)
            : undefined;
          const model = input.config.models[agent.name] ?? agent.defaultModel;
          const { provider, model: resolvedModel } = input.providerRegistry.resolve(model);
          const res = await agent.run({
            chunk,
            surroundingContext: surrounding,
            config: input.config,
            model: resolvedModel,
            provider,
            signal: input.signal,
          });
          const durationMs = Date.now() - t0;
          input.onAgentEnd?.({ agent: agent.name, chunk: chunk.file.path, durationMs, findings: res.findings.length });
          return {
            agent: agent.name as ReviewSummary['agentExecutions'][number]['agent'],
            status: 'ok' as const,
            durationMs,
            promptTokens: res.promptTokens,
            completionTokens: res.completionTokens,
            costUsd: 0,
            findings: res.findings,
          };
        } catch (err) {
          const durationMs = Date.now() - t0;
          input.onAgentEnd?.({ agent: agent.name, chunk: chunk.file.path, durationMs, findings: 0, error: err as Error });
          return {
            agent: agent.name as ReviewSummary['agentExecutions'][number]['agent'],
            status: 'error' as const,
            durationMs,
            promptTokens: 0,
            completionTokens: 0,
            costUsd: 0,
            findings: [] as Finding[],
            error: (err as Error).message,
          };
        }
      });
    }
  }

  const executions = await runWithConcurrency(tasks, concurrency);
  const completedAt = new Date();

  const merged = mergeExecutions(executions);
  const allFindings = merged.flatMap((e) => e.findings);

  const summary: ReviewSummary = {
    pullRequest: input.pullRequest,
    status: 'completed',
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    agentExecutions: merged,
    totalFindings: allFindings.length,
    totalCostUsd: merged.reduce((sum, e) => sum + e.costUsd, 0),
    skippedFiles: skipped,
  };

  return { summary, findings: allFindings };
}

interface AgentExecutionLocal {
  agent: ReviewSummary['agentExecutions'][number]['agent'];
  status: 'ok' | 'error' | 'skipped';
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  findings: Finding[];
  error?: string;
}

function mergeExecutions(executions: AgentExecutionLocal[]): ReviewSummary['agentExecutions'] {
  const byAgent = new Map<string, AgentExecutionLocal>();
  for (const e of executions) {
    const existing = byAgent.get(e.agent);
    if (!existing) {
      byAgent.set(e.agent, { ...e, findings: [...e.findings] });
      continue;
    }
    existing.durationMs += e.durationMs;
    existing.promptTokens += e.promptTokens;
    existing.completionTokens += e.completionTokens;
    existing.costUsd += e.costUsd;
    existing.findings.push(...e.findings);
    if (e.status === 'error') {
      existing.status = 'error';
      existing.error = [existing.error, e.error].filter(Boolean).join('; ');
    }
  }
  return [...byAgent.values()];
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length || 1) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]!();
    }
  });
  await Promise.all(workers);
  return results;
}
