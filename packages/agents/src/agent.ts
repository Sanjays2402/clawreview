import type { AgentName, ClawReviewConfig, Finding } from '@clawreview/types';
import type { DiffChunk } from '@clawreview/diff';
import type { LLMProvider } from '@clawreview/llm';

export interface AgentRunInput {
  chunk: DiffChunk;
  surroundingContext?: string;
  config: ClawReviewConfig;
  /** Model override resolved by caller (config.models[agent] || agent default). */
  model: string;
  provider: LLMProvider;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  findings: Finding[];
  promptTokens: number;
  completionTokens: number;
  rawContent?: string;
}

export interface Agent {
  readonly name: AgentName;
  readonly description: string;
  readonly defaultModel: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
