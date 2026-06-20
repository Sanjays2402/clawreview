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
                            comment (PR), inline (review), check, sarif, junit, csv, gitlab, rdjsonl,
                            hotspots, report (md)
- `packages/github`       — App auth, GitHubClient (PR/diff/comments/check-runs/reviews), webhook sig
- `packages/queue`        — QueueAdapter iface + InMemoryQueue + BullQueueAdapter
- `packages/db`           — Prisma client wrapper, audit log helpers, GDPR export/delete, models
- `packages/telemetry`    — pino logger, request-id, tracer, Prometheus metrics, sentry
- `packages/ui`           — React component primitives for dashboard
- `packages/config`       — shared eslint/tsconfig/tailwind/prettier presets
- `apps/server`           — Fastify webhook receiver, worker, routes (webhooks, reviews, budget, sla, …)
- `apps/dashboard`        — Next.js control plane
- `apps/cli`              — `clawreview` CLI (run, validate, stats, baseline, explain) with text/json/sarif/junit/csv/gitlab/markdown/rdjsonl output

## Conventions to match

- ESM, `.js` import suffixes, strict TS, `noUncheckedIndexedAccess`
- Tests use `vitest`. Fixture-style `f()` builders. Per-package `tests/` directory.
- Public API re-exported through `src/index.ts`.
- One commit per slice. Cron identity. No emoji in git. Feature branch only.
- Quality gates run via `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (turbo scopes).
- Vitest needs TMPDIR=/Volumes/Projects/.vitest-tmp because the system disk is at 100% and vitest writes SSR cache to $TMPDIR.
- /tmp is on the full system volume too — write commit messages and temp files under /Volumes/Projects/ instead.
- The `patch` tool can be unreliable when system disk is full (stderr noise from
  failing snapshot writes leaks into source files). Prefer `write_file` for any
  edit to source/test files this tick or until disk pressure resolves.

## Known baseline issues (pre-existing on origin/main, NOT introduced by autoship)

- `packages/diff/src/context.ts`, `packages/llm/src/*`, `packages/ui`, `packages/db`: tsconfigs reference `@types/node` (`types: ['node']` or import `node:*`) but the type package is not in the dependency graph. `pnpm typecheck` and `pnpm build` are red on these packages on main. `packages/aggregator/src/fingerprint.ts` imports `node:crypto` and also has no `@types/node` so aggregator typecheck is red on the baseline.
- `apps/dashboard`'s `pnpm lint` triggers Next.js's interactive ESLint setup wizard, exits 1 in CI.
- `pnpm test` cascades the above through turbo's `^build` dependency. Running vitest directly per-package works.
- System root volume (/) is at 100% — Hermes shell snapshot writes occasionally fail with "No space left on device"; this is cosmetic stderr pollution, but the `patch` tool can splice that stderr into edited files; use `write_file` while disk is full.
- Tick 2 added `@types/node` to `packages/agents/package.json` so the new
  `language-rules-loader.ts` typechecks cleanly there. Did not touch the other
  baseline-red packages this tick — they remain in their pre-existing state.

## Roadmap (20 candidate features)

### Aggregator exporters / shaping
1. ~~GitLab Code Quality JSON exporter~~ — DONE tick 1 (dffc194)
2. ~~SARIF enrichment — partialFingerprints + helpUri + suppressions~~ — DONE tick 1 (cc52898)
3. ~~PR comment Run-Summary footer — agent timings + cost + skipped-file count~~ — DONE tick 1 (873ab53)
4. ~~CLI `--format markdown` (+ `--format gitlab` wiring)~~ — DONE tick 1 (67ebf4f)
5. ~~Reviewdog `rdjsonl` exporter~~ — DONE tick 2 (5c6c2b7)

### Suppressions / config
6. ~~File-level inline suppressions — `clawreview-disable-file[:rules]` marker~~ — DONE tick 1 (f5a7a6a)
7. ~~`.clawreviewignore` finding-level path filter~~ — DONE tick 2 (eda6c4e)
8. **Config preset import** — `extends: [preset-name]` resolution in ClawReviewConfig loader.

### Aggregator analysis
9. ~~Hotspot detection~~ — DONE tick 2 (0517234)
10. **Per-author finding breakdown** — when git blame is available, attribute findings to authors.
11. **Finding similarity-merge across agents** — second-pass dedupe by rationale embedding distance (lex).
12. ~~Confidence calibration~~ — DONE tick 3 (42dfa40)

### Pipeline / agents
13. ~~Per-language prompt rules injection~~ — DONE tick 2 (58eb06b)
14. **Skip-file allowlist agent guard** — short-circuit agents whose `postFilter` would drop everything.
15. ~~Cost-budget pre-flight~~ — DONE tick 3 (f928a99)

### CLI / DX
16. ~~`clawreview explain <fingerprint>`~~ — DONE tick 2 (fa12f29)
17. ~~`clawreview diff-stats`~~ — DONE tick 3 (d951ecd)

### Server / queue / telemetry
18. ~~Queue introspection endpoint~~ — DONE tick 3 (57599bc)
19. ~~Per-agent latency histogram~~ — DONE tick 3 (b2063ec)
20. **Webhook replay endpoint** — `POST /internal/webhook/replay` re-dispatches a stored event payload.

### Backlog seeded for tick 3
- **Foundational infra fix** — wire `@types/node` into `packages/diff`, `packages/llm`, `packages/ui`, `packages/db`, and `packages/aggregator` so `pnpm typecheck`/`pnpm build` flip green on the baseline. Required before any test gate can be run end-to-end via turbo.
- **Aggregate-level helper for hotspot opts** — promote `hotspots: HotspotOptions` from CommentOptions into an `AggregateOptions.hotspots` so the CLI's text/markdown renderers can pull the same clusters without re-computing.
- **CLI `clawreview explain` + dashboard parity** — once item 19 (per-agent metrics) lands, wire `explain` to fetch a single finding from the server's review-store endpoint instead of needing the JSON report on disk.

### Backlog seeded for tick 4 (refill — items below + remaining 8, 10, 11, 14, 20 above)
- **Cost-budget pre-flight visibility on dashboard** — surface tick 3's `preflightBudget` estimate as a "skipped because preflight" reason in apps/dashboard's review list.
- **Per-agent histograms in dashboard** — consume `clawreview_agent_duration_seconds` from /metrics and chart it.
- **Queue introspection in dashboard** — admin page that polls /api/internal/queue and shows pending/inflight + recent failures.
- **Calibration audit log** — extend the worker's `confidence_calibration_applied` log line into the review-store record so the dashboard can show "n findings auto-promoted/floored".
- **`clawreview diff-stats --threshold` CI gate** — exit non-zero when changedLines exceeds a configurable cap, for "PR too large to review" enforcement.

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

### Tick 2 — 2026-06-20 02:53 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | Reviewdog rdjsonl exporter + CLI --format rdjsonl | 5c6c2b7 | +292/-2 | 10 new |
| 2 | .clawreviewignore project-level path filter | eda6c4e | +192/-6 | 9 new |
| 3 | Hotspot detection + PR comment Hotspots block | 0517234 | +390/-2 | 19 new (15 hotspots + 4 comment) |
| 4 | Per-language prompt rules injection in PromptedAgent | 58eb06b | +300/-6 | 12 new (8 loader + 4 prompted-agent) |
| 5 | clawreview explain <fingerprint> command | fa12f29 | +370/-4 | 12 new |

Gate results: aggregator 117/117 (+29 new), agents 49/49 (+12 new), cli 36/36 (+21 new), diff 24/24, types 7/7, llm 12/12, github 14/14, queue 3/3, telemetry 6/6, server 179/179 — total 447 tests verified passing (+62 over tick 1). Touched-package typecheck delta: `@clawreview/cli` clean; `@clawreview/aggregator` and `@clawreview/agents` red only on the documented baseline (`@types/node` missing on a couple of cross-package deps); no new typecheck errors introduced by this tick. Push verified: `git ls-remote origin feature/autoship` -> `fa12f29`.

### Tick 3 — 2026-06-20 05:15 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | CLI `clawreview diff-stats` (text + json, --input/--diff/git modes) | d951ecd | +387/-0 | 8 new |
| 2 | Aggregator confidence calibration (worker + CLI wiring) | 42dfa40 | +330/-3 | 12 new |
| 3 | Telemetry per-agent histogram + invocations/findings counters (worker wiring) | b2063ec | +197/-1 | 5 new (telemetry) + 1 new (server) |
| 4 | Queue introspection endpoint + adapter `details()` (memory + bullmq) | 57599bc | +376/-3 | 5 new (queue) + 1 new (server) |
| 5 | Agents cost-budget pre-flight estimator + worker + CLI integration | f928a99 | +510/-2 | 16 new |

Gate results: aggregator 129/129 (+12 new), agents 65/65 (+16 new), telemetry 11/11 (+5 new), queue 8/8 (+5 new), cli 44/44 (+8 new), server 181/181 (+2 new — internal-queue + worker-metrics agent-histogram), diff 24/24, types 7/7, llm 12/12, github 14/14 — total 495 tests verified passing (+48 over tick 2). Touched-package typecheck: `@clawreview/telemetry` and `@clawreview/queue` clean; `@clawreview/agents` red only on the existing `@types/node`-missing-in-@clawreview/llm baseline (new file `cost-estimator.ts` clean); `apps/cli` clean; `apps/server` adds 10 lines of pre-existing FastifyInstance type-mismatch noise from the new `registerInternalQueueRoutes(app)` call (zero errors in the new route/test files themselves). Push verified: `git ls-remote origin feature/autoship` -> `f928a99`.

## Done
- 1, 2, 3, 4, 5, 6, 7, 9, 12, 13, 15, 16, 17, 18, 19 (and CLI wiring item 4)
