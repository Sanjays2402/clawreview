import { z } from 'zod';

import { AgentNameSchema } from './config.js';
import { FindingSchema } from './finding.js';

export const ReviewStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const AgentExecutionSchema = z.object({
  agent: AgentNameSchema,
  status: z.enum(['ok', 'error', 'skipped']),
  durationMs: z.number().nonnegative(),
  promptTokens: z.number().nonnegative().default(0),
  completionTokens: z.number().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  findings: z.array(FindingSchema),
  error: z.string().optional(),
});
export type AgentExecution = z.infer<typeof AgentExecutionSchema>;

export const ReviewSummarySchema = z.object({
  pullRequest: z.object({
    owner: z.string(),
    repo: z.string(),
    number: z.number().int().positive(),
    headSha: z.string(),
    baseSha: z.string(),
  }),
  status: ReviewStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  agentExecutions: z.array(AgentExecutionSchema),
  totalFindings: z.number().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
});
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;
