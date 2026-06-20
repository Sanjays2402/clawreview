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
                            comment (PR), inline (review), check, sarif, junit, csv, gitlab, report (md)
- `packages/github`       — App auth, GitHubClient (PR/diff/comments/check-runs/reviews), webhook sig
- `packages/queue`        — QueueAdapter iface + InMemoryQueue + BullQueueAdapter
- `packages/db`           — Prisma client wrapper, audit log helpers, GDPR export/delete, models
- `packages/telemetry`    — pino logger, request-id, tracer, Prometheus metrics, sentry
- `packages/ui`           — React component primitives for dashboard
- `packages/config`       — shared eslint/tsconfig/tailwind/prettier presets
- `apps/server`           — Fastify webhook receiver, worker, routes (webhooks, reviews, budget, sla, …)
- `apps/dashboard`        — Next.js control plane
- `apps/cli`              — `clawreview` CLI (run, validate, stats, baseline) with text/json/sarif/junit/csv/gitlab/markdown output

## Conventions to match

- ESM, `.js` import suffixes, strict TS, `noUncheckedIndexedAccess`
- Tests use `vitest`. Fixture-style `f()` builders. Per-package `tests/` directory.
- Public API re-exported through `src/index.ts`.
- One commit per slice. Cron identity. No emoji in git. Feature branch only.
- Quality gates run via `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (turbo scopes).
- Vitest needs TMPDIR=/Volumes/Projects/.vitest-tmp because the system disk is at 100% and vitest writes SSR cache to $TMPDIR.

## Known baseline issues (pre-existing on origin/main, NOT introduced by autoship)

- `packages/diff/src/context.ts`, `packages/llm/src/*`, `packages/ui`, `packages/db`: tsconfigs reference `@types/node` (`types: ['node']` or import `node:*`) but the type package is not in the dependency graph. `pnpm typecheck` and `pnpm build` are red on these packages on main.
- `apps/dashboard`'s `pnpm lint` triggers Next.js's interactive ESLint setup wizard, exits 1 in CI.
- `pnpm test` cascades the above through turbo's `^build` dependency. Running vitest directly per-package works.
- System root volume (/) is at 100% — Hermes shell snapshot writes occasionally fail with "No space left on device"; this is cosmetic stderr pollution, not a command failure.

## Roadmap (20 candidate features)

### Aggregator exporters / shaping
1. ~~GitLab Code Quality JSON exporter~~ — DONE tick 1 (dffc194)
2. ~~SARIF enrichment — partialFingerprints + helpUri + suppressions~~ — DONE tick 1 (cc52898)
3. ~~PR comment Run-Summary footer — agent timings + cost + skipped-file count~~ — DONE tick 1 (873ab53)
4. ~~CLI `--format markdown` (+ `--format gitlab` wiring)~~ — DONE tick 1 (67ebf4f)
5. **Reviewdog `rdjsonl` exporter** — line-delimited finding stream for reviewdog.

### Suppressions / config
6. ~~File-level inline suppressions — `clawreview-disable-file[:rules]` marker~~ — DONE tick 1 (f5a7a6a)
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

### Backlog seeded for tick 2
- **Foundational infra fix** — wire `@types/node` into `packages/diff`, `packages/llm`, `packages/ui`, `packages/db` so `pnpm typecheck`/`pnpm build` flip green on the baseline. Required before any test gate can be run end-to-end via turbo.

## TICK LOG

### Tick 1 — 2026-06-20 02:11 PT — 5 features + 1 infra unblock

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| - | bootstrap STATE/roadmap | a2621ac | +73/-0 | n/a |
| 1 | GitLab Code Quality exporter (aggregator) | dffc194 | +242/-0 | 9 new |
| 2 | SARIF enrichment (fingerprints/helpUri/suppressions) | cc52898 | +116/-4 | 4 new |
| 3 | File-level inline suppression marker | f5a7a6a | +140/-8 | 4 new |
| 4 | PR comment Run summary footer | 873ab53 | +147/-1 | 4 new |
| 5 | CLI --format markdown and --format gitlab | 67ebf4f | +67/-4 | n/a (covered by unit tests in #1+#4) |
| ∞ | vite ^6 override so vitest 4 can run | eac1ef0 | +7/-1 | unblocks all suites |

Gate results: aggregator 88/88, cli 15/15, diff 24/24, agents 37/37, types 7/7, llm 12/12, github 14/14, queue 3/3, telemetry 6/6, server 179/179 — total 385 tests verified passing. `pnpm typecheck`/`pnpm build`/`pnpm lint` are red on identical baseline issues on origin/main; my branch introduces zero new failures.

## Done
- 1, 2, 3, 4, 6 (and CLI wiring item 4)
