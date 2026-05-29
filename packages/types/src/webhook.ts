import { z } from 'zod';

export const GitHubRepoRefSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  owner: z.object({
    login: z.string(),
    id: z.number(),
    type: z.string().optional(),
  }),
  private: z.boolean().optional(),
  default_branch: z.string().optional(),
});

export const PullRequestPayloadSchema = z.object({
  action: z.enum(['opened', 'synchronize', 'reopened', 'edited', 'closed', 'ready_for_review']),
  number: z.number(),
  pull_request: z.object({
    id: z.number(),
    number: z.number(),
    title: z.string(),
    state: z.string(),
    draft: z.boolean().optional(),
    head: z.object({ sha: z.string(), ref: z.string() }),
    base: z.object({ sha: z.string(), ref: z.string() }),
    user: z.object({ login: z.string() }).optional(),
  }),
  repository: GitHubRepoRefSchema,
  installation: z.object({ id: z.number() }).optional(),
  sender: z.object({ login: z.string(), id: z.number() }).optional(),
});
export type PullRequestPayload = z.infer<typeof PullRequestPayloadSchema>;

export const InstallationPayloadSchema = z.object({
  action: z.enum(['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted']),
  installation: z.object({
    id: z.number(),
    account: z.object({ login: z.string(), id: z.number(), type: z.string() }),
  }),
  repositories: z.array(GitHubRepoRefSchema).optional(),
  sender: z.object({ login: z.string(), id: z.number() }).optional(),
});
export type InstallationPayload = z.infer<typeof InstallationPayloadSchema>;
