import { z } from 'zod';

import { SeveritySchema } from './severity.js';

export const FindingCategorySchema = z.enum([
  'security',
  'performance',
  'style',
  'maintainability',
  'accessibility',
  'sql-injection',
  'secrets',
  'bug',
  'other',
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const SuggestedPatchSchema = z.object({
  description: z.string().min(1).max(400),
  diff: z.string().min(1).max(8000),
});
export type SuggestedPatch = z.infer<typeof SuggestedPatchSchema>;

export const FindingSchema = z.object({
  id: z.string().optional(),
  agent: z.string().min(1),
  category: FindingCategorySchema,
  severity: SeveritySchema,
  title: z.string().min(3).max(160),
  rationale: z.string().min(1).max(4000),
  file: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  confidence: z.number().min(0).max(1).default(0.6),
  cwe: z.string().regex(/^CWE-\d+$/).optional(),
  suggested: SuggestedPatchSchema.optional(),
  tags: z.array(z.string()).default([]),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingsResponseSchema = z.object({
  findings: z.array(FindingSchema),
  reasoning: z.string().optional(),
});
export type FindingsResponse = z.infer<typeof FindingsResponseSchema>;
