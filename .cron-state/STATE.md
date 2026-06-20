# ClawReview Autoship State

Branch: `feature/autoship` (off `origin/main`)
Cron identity: `Cake (cron) <51058514+Sanjays2402@users.noreply.github.com>`
First tick: 2026-06-20

## Monorepo map (learned by reading)

- `packages/types`        — Zod schemas: AgentName, Severity, Finding, ClawReviewConfig, ReviewSummary
- `packages/diff`         — unified-diff parser, chunker, language detector, ignore globs, file selector
- `packages/llm`          — LLMProvider iface, OpenAI-compatible client, retry, rate-limit, provider registry
- `packages/agents`       — PromptedAgent + SecretsAgent + AGENT_REGISTRY, prompt-variants, language-rules, pipeline
- `packages/aggregator`   — dedupe + rank + severity rules + suppressions + fingerprints +
                            comment (PR), inline (review), check, sarif, junit, csv, report (md)
- `packages/github`       — App auth, GitHubClient (PR/diff/comments/check-runs/reviews), webhook sig
- `packages/queue`        — QueueAdapter iface + InMemoryQueue + BullQueueAdapter
- `packages/db`           — Prisma client wrapper, audit log helpers, GDPR export/delete, models
- `packages/telemetry`    — pino logger, request-id, tracer, Prometheus metrics, sentry
- `packages/ui`           — React component primitives for dashboard
- `packages/config`       — shared eslint/tsconfig/tailwind/prettier presets
- `apps/server`           — Fastify webhook receiver, worker, routes (webhooks, reviews, budget, sla, …)
- `apps/dashboard`        — Next.js control plane
- `apps/cli`              — `clawreview` CLI (run, validate, stats, baseline) with text/json/sarif/junit/csv output

## Conventions to match

- ESM, `.js` import suffixes, strict TS, `noUncheckedIndexedAccess`
- Tests use `vitest`. Fixture-style `f()` builders. Per-package `tests/` directory.
- Public API re-exported through `src/index.ts`.
- One commit per slice. Cron identity. No emoji in git. Feature branch only.
- Quality gates run via `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (turbo scopes).

## Roadmap (20 candidate features)

### Aggregator exporters / shaping
1. **GitLab Code Quality JSON exporter** — `toGitlabCodeQuality()`; wire into CLI `--format gitlab`.
2. **SARIF enrichment** — `partialFingerprints`, per-rule `helpUri`, suppressions section.
3. **PR comment Run-Summary footer** — agent timings + cost + skipped-file count.
4. **CLI `--format markdown`** — surface `renderReviewReport` from the CLI.
5. **Reviewdog `rdjsonl` exporter** — line-delimited finding stream for reviewdog.

### Suppressions / config
6. **File-level inline suppressions** — `clawreview-disable-file[:rules]` marker.
7. **`.clawreviewignore` finding-level path filter** — pre-aggregate filter so ignored files don't reach LLM.
8. **Config preset import** — `extends: [preset-name]` resolution in ClawReviewConfig loader.

### Aggregator analysis
9. **Hotspot detection** — group findings into `(file, line-window)` clusters and surface in comment.
10. **Per-author finding breakdown** — when git blame is available, attribute findings to authors.
11. **Finding similarity-merge across agents** — second-pass dedupe by rationale embedding distance (lex).
12. **Confidence calibration** — auto-floor low-confidence nits; bump high-confidence security to medium+.

### Pipeline / agents
13. **Per-language prompt rules injection** — auto-attach `language-rules/<lang>.md` to PromptedAgent context.
14. **Skip-file allowlist agent guard** — short-circuit agents whose `postFilter` would drop everything.
15. **Cost-budget pre-flight** — estimate cost from token-count heuristic; fail fast when over `budget.monthly_usd`.

### CLI / DX
16. **`clawreview explain <fingerprint>`** — look up a finding by fingerprint in a JSON report.
17. **`clawreview diff-stats`** — summarize the file/line shape of a diff without running agents.

### Server / queue / telemetry
18. **Queue introspection endpoint** — `/internal/queue` returns pending/inflight counts + recent failures.
19. **Per-agent latency histogram** — Prometheus `clawreview_agent_duration_seconds{agent,outcome}`.
20. **Webhook replay endpoint** — `POST /internal/webhook/replay` re-dispatches a stored event payload.

## TICK LOG
<!-- Each batch appends one block. Earliest at bottom. -->

(no ticks yet)

## Done
<!-- Mark items here as feature → commit SHA -->
