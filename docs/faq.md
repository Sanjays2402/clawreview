# FAQ

**Why one comment per review?** Multi-comment reviewers train people to ignore noise. One ranked comment respects attention.

**Why TypeScript everywhere?** Sharing zod schemas between server, dashboard, and CLI keeps payloads honest. The same types describe webhook bodies, finding shapes, and config.

**Can I bring my own model?** Yes. Set LLM_OPENAI_BASE_URL to any OpenAI-compatible endpoint, or point per-agent overrides at copilot/ or hermes/ prefixes.

**Does ClawReview train on my code?** No. We do not store diffs longer than a review takes, and we do not relay your code to third-party fine-tuning pipelines.

**Self-host or SaaS?** Both. The Helm chart and Terraform skeleton ship in the repo. The dashboard works the same in both modes.
