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
  review_limits: z
    .object({
      max_changed_lines_per_file: z.number().int().positive().default(1500),
      max_patch_bytes_per_file: z.number().int().positive().default(256 * 1024),
      include_generated: z.boolean().default(false),
    })
    .default({
      max_changed_lines_per_file: 1500,
      max_patch_bytes_per_file: 256 * 1024,
      include_generated: false,
    }),
  severity_rules: z
    .array(
      z.object({
        /** Glob pattern matched against the finding's file path. */
        path: z.string().min(1),
        /** Optional category filter; if absent, matches all categories. */
        category: z.string().min(1).optional(),
        /** Optional agent filter. */
        agent: z.string().min(1).optional(),
        /** Either an absolute severity to set, or a +/- step relative to current. */
        set: SeveritySchema.optional(),
        bump: z.number().int().min(-4).max(4).optional(),
        /** Human-readable note appended to the finding's tags for audit. */
        reason: z.string().min(1).max(120).optional(),
      }).refine((r) => r.set !== undefined || r.bump !== undefined, {
        message: 'severity_rules entry must specify set or bump',
      }),
    )
    .default([]),
});
export type ClawReviewConfig = z.infer<typeof ClawReviewConfigSchema>;

export const DEFAULT_CONFIG: ClawReviewConfig = ClawReviewConfigSchema.parse({});
