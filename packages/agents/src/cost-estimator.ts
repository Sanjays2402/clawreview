import { chunkFile, filterIgnored, parseUnifiedDiff, selectReviewableFiles } from '@clawreview/diff';
import type { ClawReviewConfig } from '@clawreview/types';

import { AGENT_REGISTRY } from './registry.js';
import type { Agent } from './agent.js';

/**
 * Per-model pricing in USD per 1k tokens. Inputs and outputs are billed
 * separately by every major OpenAI-compatible vendor, so we track both.
 *
 * Numbers reflect published list pricing as of mid-2026 for the models
 * the default agents actually use. When a model isn't in the table we
 * fall back to `DEFAULT_RATE`, which is intentionally conservative so
 * pre-flight stays a high-side estimate (under-running budget is the
 * only acceptable failure mode here).
 */
export interface ModelRate {
  /** USD per 1,000 input tokens. */
  inputPer1k: number;
  /** USD per 1,000 output tokens. */
  outputPer1k: number;
}

export const DEFAULT_RATE: ModelRate = { inputPer1k: 0.003, outputPer1k: 0.015 };

const PRICING_TABLE: Record<string, ModelRate> = {
  // Anthropic-family via Hermes proxy
  'claude-opus-4': { inputPer1k: 0.015, outputPer1k: 0.075 },
  'claude-opus-3.5': { inputPer1k: 0.015, outputPer1k: 0.075 },
  'claude-sonnet-3.5': { inputPer1k: 0.003, outputPer1k: 0.015 },
  'claude-haiku-3.5': { inputPer1k: 0.0008, outputPer1k: 0.004 },
  // OpenAI direct
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  'gpt-4-turbo': { inputPer1k: 0.01, outputPer1k: 0.03 },
  // GitHub Copilot proxy (treated as gpt-4o equivalent for billing)
  'gpt-4': { inputPer1k: 0.01, outputPer1k: 0.03 },
};

/**
 * Strip the provider prefix (`hermes/`, `copilot/`) so the pricing
 * table can be keyed by the bare model id regardless of which provider
 * the agent will route through. Returns the input verbatim when no
 * prefix is present.
 */
export function bareModelId(model: string): string {
  const slash = model.indexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Look up the per-model rate, returning DEFAULT_RATE for unknown models. */
export function rateForModel(model: string): ModelRate {
  const bare = bareModelId(model);
  return PRICING_TABLE[bare] ?? DEFAULT_RATE;
}

/**
 * Approximate the number of tokens in a piece of text using the
 * widely-cited ~4 chars/token heuristic. Off by ~20% for code (code is
 * tokenised more densely than prose) so we round up to keep the
 * estimate on the conservative side; pre-flight should never
 * under-report cost.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface CostEstimateBreakdown {
  agent: string;
  model: string;
  /** Total chunks this agent will run across. */
  chunks: number;
  /** Estimated input tokens summed across all chunks. */
  promptTokens: number;
  /** Estimated output tokens summed across all chunks (heuristic share of input). */
  completionTokens: number;
  /** Estimated cost in USD for this agent's slice of the pipeline. */
  costUsd: number;
}

export interface CostEstimate {
  /** Total estimated cost across all agents and chunks, in USD. */
  totalUsd: number;
  /** Total estimated input tokens. */
  promptTokens: number;
  /** Total estimated output tokens. */
  completionTokens: number;
  /** Number of chunks the pipeline will dispatch. */
  chunks: number;
  /** Number of files in scope after ignore + select. */
  filesReviewed: number;
  /** Number of files dropped by selectReviewableFiles (binary, generated, etc.). */
  filesSkipped: number;
  /** Per-agent breakdown for diagnostics. */
  byAgent: CostEstimateBreakdown[];
}

export interface EstimateOptions {
  /** Override agents (matches PipelineInput['agents']) for testing. */
  agents?: Partial<Record<string, Agent>>;
  /**
   * Overhead added to every chunk to account for the system prompt,
   * fenced JSON wrappers, language rules, and per-agent prompt body.
   * Defaults to 800 tokens; tweak if you've added heavy per-agent
   * instructions.
   */
  overheadTokensPerChunk?: number;
  /**
   * Multiplier applied to estimated input tokens to project completion
   * tokens. Findings JSON is typically short (~25% of input prompt)
   * but high-finding chunks can push past 50%. We default to 0.4 so
   * the estimate stays a high-side guard.
   */
  completionRatio?: number;
}

const DEFAULT_OVERHEAD_TOKENS = 800;
const DEFAULT_COMPLETION_RATIO = 0.4;

/**
 * Estimate the LLM cost of running `runPipeline` on `diffText` against
 * the configured agents WITHOUT actually invoking any LLM.
 *
 * The estimate is a high-side guard so callers can fail fast before
 * spending real money. It mirrors runPipeline()'s discovery path:
 *
 *   1. parseUnifiedDiff -> filterIgnored -> selectReviewableFiles
 *   2. chunkFile over each surviving file
 *   3. For each (agent, chunk) pair: estimate input + output tokens
 *      via `estimateTokens()`, look up per-model rate, accumulate cost.
 */
export function estimateReviewCost(
  diffText: string,
  config: Pick<ClawReviewConfig, 'agents' | 'ignore' | 'models' | 'review_limits'>,
  opts: EstimateOptions = {},
): CostEstimate {
  const overhead = Math.max(0, opts.overheadTokensPerChunk ?? DEFAULT_OVERHEAD_TOKENS);
  const completionRatio = Math.max(0, opts.completionRatio ?? DEFAULT_COMPLETION_RATIO);

  const parsed = parseUnifiedDiff(diffText);
  const ignored = filterIgnored(parsed.files, config.ignore ?? []);
  const { files, skipped } = selectReviewableFiles(ignored, {
    maxChangedLines: config.review_limits?.max_changed_lines_per_file,
    maxPatchBytes: config.review_limits?.max_patch_bytes_per_file,
    includeGenerated: config.review_limits?.include_generated,
  });

  const chunks = files.flatMap((f) => chunkFile(f));
  const chunkInputs = chunks.map((c) => estimateTokens(c.body));

  const agentEntries: Array<{ name: string; agent: Agent; model: string }> = [];
  for (const name of config.agents ?? []) {
    const agent = opts.agents?.[name] ?? AGENT_REGISTRY[name];
    if (!agent) continue;
    const model = (config.models ?? ({} as Record<string, string>))[name] ?? agent.defaultModel;
    agentEntries.push({ name, agent, model });
  }

  const byAgent: CostEstimateBreakdown[] = agentEntries.map(({ name, model }) => {
    let promptTokens = 0;
    let completionTokens = 0;
    let costUsd = 0;
    const rate = rateForModel(model);
    for (const chunkTokens of chunkInputs) {
      const inTok = chunkTokens + overhead;
      const outTok = Math.ceil(inTok * completionRatio);
      promptTokens += inTok;
      completionTokens += outTok;
      costUsd += (inTok / 1000) * rate.inputPer1k + (outTok / 1000) * rate.outputPer1k;
    }
    return {
      agent: name,
      model,
      chunks: chunks.length,
      promptTokens,
      completionTokens,
      costUsd: roundUsd(costUsd),
    };
  });

  const totalUsd = roundUsd(byAgent.reduce((s, a) => s + a.costUsd, 0));
  const promptTokens = byAgent.reduce((s, a) => s + a.promptTokens, 0);
  const completionTokens = byAgent.reduce((s, a) => s + a.completionTokens, 0);

  return {
    totalUsd,
    promptTokens,
    completionTokens,
    chunks: chunks.length,
    filesReviewed: files.length,
    filesSkipped: skipped.length,
    byAgent,
  };
}

/** Round to 4 decimal places (≈ $0.0001 precision) to keep JSON tidy. */
function roundUsd(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export interface PreflightInput {
  diffText: string;
  config: Pick<ClawReviewConfig, 'agents' | 'ignore' | 'models' | 'review_limits' | 'budget'>;
  /** Already-spent USD this billing period (e.g. from BudgetGuard). */
  spentUsd?: number;
  /** Override estimator options (testing / tuning). */
  estimatorOptions?: EstimateOptions;
}

export interface PreflightResult {
  /** True when running the review would NOT push spend past the limit. */
  ok: boolean;
  estimate: CostEstimate;
  /** The limit consulted; comes from config.budget.monthly_usd. */
  limitUsd: number;
  /** Already-spent USD this period (echoes input or 0 when not provided). */
  spentUsd: number;
  /** Human-readable reason when ok=false. Empty when ok=true. */
  reason: string;
}

/**
 * Combine `estimateReviewCost` with the configured monthly budget and
 * the caller's already-spent amount to decide whether the review should
 * proceed. Callers (worker, CLI) can short-circuit on `result.ok === false`
 * and surface `result.reason` to the user instead of spending tokens.
 *
 * Returns `ok: true` when `budget.monthly_usd` is unset (treated as
 * unlimited) so deployments that haven't enabled budgets aren't blocked.
 */
export function preflightBudget(input: PreflightInput): PreflightResult {
  const estimate = estimateReviewCost(input.diffText, input.config, input.estimatorOptions);
  const spentUsd = Math.max(0, input.spentUsd ?? 0);
  const limitUsd = input.config.budget?.monthly_usd ?? 0;

  if (limitUsd <= 0) {
    return { ok: true, estimate, limitUsd: 0, spentUsd, reason: '' };
  }

  const projected = roundUsd(spentUsd + estimate.totalUsd);
  if (projected > limitUsd) {
    return {
      ok: false,
      estimate,
      limitUsd,
      spentUsd,
      reason:
        `Estimated cost $${estimate.totalUsd.toFixed(4)} plus prior spend ` +
        `$${spentUsd.toFixed(2)} would exceed monthly budget $${limitUsd.toFixed(2)} ` +
        `(projected $${projected.toFixed(2)}).`,
    };
  }
  return { ok: true, estimate, limitUsd, spentUsd, reason: '' };
}
