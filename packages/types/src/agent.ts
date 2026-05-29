import { z } from 'zod';

export const AgentContextSchema = z.object({
  filePath: z.string(),
  language: z.string().optional(),
  hunkHeader: z.string(),
  hunkBody: z.string(),
  surroundingContext: z.string().optional(),
  hunkStartLine: z.number().int().positive(),
  hunkEndLine: z.number().int().positive(),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;

export const AgentDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  defaultModel: z.string(),
  systemPrompt: z.string(),
  categories: z.array(z.string()),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
