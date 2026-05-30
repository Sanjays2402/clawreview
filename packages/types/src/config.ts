import { z } from 'zod';

import { SeveritySchema } from './severity.js';

export const AgentNameSchema = z.enum([
  'security',
  'performance',
  'style',
  'accessibility',
  'sql-injection',
  'secrets',
]);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const ClawReviewConfigSchema = z.object({
  agents: z.array(AgentNameSchema).default(['security', 'performance', 'style', 'secrets']),
  severity_threshold: SeveritySchema.default('low'),
  ignore: z.array(z.string()).default([]),
  models: z.record(AgentNameSchema, z.string()).default({}),
  budget: z
    .object({
      monthly_usd: z.number().positive().default(50),
    })
    .default({ monthly_usd: 50 }),
  custom_rules: z.array(z.string()).default([]),
  max_findings_per_file: z.number().int().positive().default(8),
  comment_style: z.enum(['compact', 'detailed']).default('detailed'),
  inline_comments: z
    .object({
      enabled: z.boolean().default(false),
      min_severity: SeveritySchema.default('medium'),
      max: z.number().int().positive().default(20),
    })
    .default({ enabled: false, min_severity: 'medium', max: 20 }),
});
export type ClawReviewConfig = z.infer<typeof ClawReviewConfigSchema>;

export const DEFAULT_CONFIG: ClawReviewConfig = ClawReviewConfigSchema.parse({});
