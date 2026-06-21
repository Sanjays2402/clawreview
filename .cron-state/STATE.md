# ClawReview Autoship State

**Active branch: `main`** — commit and push DIRECTLY to main every tick. No feature branches.
Cron identity: `Cake (cron) <51058514+Sanjays2402@users.noreply.github.com>`
First tick: 2026-06-20

## Monorepo map (learned by reading)

- `packages/types`        — Zod schemas: AgentName, Severity, Finding, ClawReviewConfig, ReviewSummary
- `packages/diff`         — unified-diff parser, chunker, language detector, ignore globs, file selector
- `packages/llm`          — LLMProvider iface, OpenAI-compatible client, retry, rate-limit, provider registry
- `packages/agents`       — PromptedAgent + SecretsAgent + AGENT_REGISTRY, prompt-variants, language-rules, pipeline
- `packages/aggregator`   — dedupe + rank + severity rules + suppressions + fingerprints +
                            comment (PR), inline (review), check, sarif, junit, csv, gitlab, rdjsonl,
                            hotspots, similarity-merge, authors, calibrate, report (md)
- `packages/github`       — App auth, GitHubClient (PR/diff/comments/check-runs/reviews), webhook sig
- `packages/queue`        — QueueAdapter iface + InMemoryQueue + BullQueueAdapter
- `packages/db`           — Prisma client wrapper, audit log helpers, GDPR export/delete, models
- `packages/telemetry`    — pino logger, request-id, tracer, Prometheus metrics, sentry
- `packages/ui`           — React component primitives for dashboard
- `packages/config`       — shared eslint/tsconfig/tailwind/prettier presets
- `apps/server`           — Fastify webhook receiver, worker, routes (webhooks, reviews, budget, sla, …)
- `apps/dashboard`        — Next.js control plane
- `apps/cli`              — `clawreview` CLI (run, validate, lint-config, stats, baseline, diff-stats, explain, authors) with text/json/sarif/junit/csv/gitlab/markdown/rdjsonl output

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
- After a push, `git fetch origin` sometimes does NOT advance the local
  `refs/remotes/origin/feature/autoship` ref (packed-refs / refspec quirk on
  this clone). Use `git ls-remote origin feature/autoship` as the source of
  truth and force the local tracking ref forward with `git update-ref` when
  needed. Verified: `262279f` was actually pushed in tick 5.

## Known baseline issues (pre-existing on origin/main, NOT introduced by autoship)

- `packages/diff/src/context.ts`, `packages/llm/src/*`, `packages/ui`, `packages/db`: tsconfigs reference `@types/node` (`types: ['node']` or import `node:*`) but the type package is not in the dependency graph. `pnpm typecheck` and `pnpm build` are red on these packages on main. `packages/aggregator/src/fingerprint.ts` imports `node:crypto` and also has no `@types/node` so aggregator typecheck is red on the baseline.
- `apps/dashboard`'s `pnpm lint` triggers Next.js's interactive ESLint setup wizard, exits 1 in CI.
- `pnpm test` cascades the above through turbo's `^build` dependency. Running vitest directly per-package works.
- System root volume (/) is at 100% — Hermes shell snapshot writes occasionally fail with "No space left on device"; this is cosmetic stderr pollution, but the `patch` tool can splice that stderr into edited files; use `write_file` while disk is full.
- Tick 2 added `@types/node` to `packages/agents/package.json` so the new
  `language-rules-loader.ts` typechecks cleanly there. Did not touch the other
  baseline-red packages this tick — they remain in their pre-existing state.
- `apps/server`'s `pnpm typecheck` is red on the baseline for `api-auth.ts`,
  `rate-limit.ts`, `webhooks.ts`, and `server.ts` (FastifyInstance/Logger
  type-provider mismatches + indexed access nullability). All new code lands
  cleanly; touched-file delta is zero each tick.

## Roadmap (25/25 — every original + backlog item shipped)

### Aggregator exporters / shaping
1. ~~GitLab Code Quality JSON exporter~~ — DONE tick 1 (dffc194)
2. ~~SARIF enrichment — partialFingerprints + helpUri + suppressions~~ — DONE tick 1 (cc52898)
3. ~~PR comment Run-Summary footer — agent timings + cost + skipped-file count~~ — DONE tick 1 (873ab53)
4. ~~CLI `--format markdown` (+ `--format gitlab` wiring)~~ — DONE tick 1 (67ebf4f)
5. ~~Reviewdog `rdjsonl` exporter~~ — DONE tick 2 (5c6c2b7)

### Suppressions / config
6. ~~File-level inline suppressions — `clawreview-disable-file[:rules]` marker~~ — DONE tick 1 (f5a7a6a)
7. ~~`.clawreviewignore` finding-level path filter~~ — DONE tick 2 (eda6c4e)
8. ~~Config preset import (`extends:` chain in CLI loader)~~ — DONE tick 4 (8a95772)

### Aggregator analysis
9. ~~Hotspot detection~~ — DONE tick 2 (0517234)
10. ~~Per-author finding breakdown (git blame attribution + CLI)~~ — DONE tick 4 (2ff2dd8)
11. ~~Cross-agent finding similarity-merge (rationale lexical overlap)~~ — DONE tick 4 (63d5277)
12. ~~Confidence calibration~~ — DONE tick 3 (42dfa40)

### Pipeline / agents
13. ~~Per-language prompt rules injection~~ — DONE tick 2 (58eb06b)
14. ~~Skip-file allowlist agent guard (preFilter short-circuit)~~ — DONE tick 4 (8c6f66f)
15. ~~Cost-budget pre-flight~~ — DONE tick 3 (f928a99)

### CLI / DX
16. ~~`clawreview explain <fingerprint>`~~ — DONE tick 2 (fa12f29)
17. ~~`clawreview diff-stats`~~ — DONE tick 3 (d951ecd)

### Server / queue / telemetry
18. ~~Queue introspection endpoint~~ — DONE tick 3 (57599bc)
19. ~~Per-agent latency histogram~~ — DONE tick 3 (b2063ec)
20. ~~Webhook replay endpoint (POST /api/internal/webhook/replay/:deliveryId)~~ — DONE tick 4 (7d9390a)

### Tick 5 backlog items (refilled at end of tick 4)
21. ~~Authors breakdown in PR comment (Top contributors block)~~ — DONE tick 5 (568f66d)
22. ~~Worker-side similarity merge metrics (`clawreview_similarity_merges_total`)~~ — DONE tick 5 (90d0dac)
23. ~~Preset auto-loading from `.clawreview/presets/*.yml`~~ — DONE tick 5 (bc70294)
24. ~~`clawreview lint-config` (schema-validate every config in a repo)~~ — DONE tick 5 (c377e80)
25. ~~Webhook replay /recent endpoint filters (event/sinceMs/repo)~~ — DONE tick 5 (262279f)

### Backlog seeded for tick 3 (still open after tick 5)
- **Foundational infra fix** — wire `@types/node` into `packages/diff`, `packages/llm`, `packages/ui`, `packages/db`, and `packages/aggregator` so `pnpm typecheck`/`pnpm build` flip green on the baseline. Required before any test gate can be run end-to-end via turbo.
- **Aggregate-level helper for hotspot opts** — promote `hotspots: HotspotOptions` from CommentOptions into an `AggregateOptions.hotspots` so the CLI's text/markdown renderers can pull the same clusters without re-computing.
- **CLI `clawreview explain` + dashboard parity** — once item 19 (per-agent metrics) lands, wire `explain` to fetch a single finding from the server's review-store endpoint instead of needing the JSON report on disk.

### Backlog seeded for tick 4 (dashboard work, still open after tick 5)
- **Cost-budget pre-flight visibility on dashboard** — surface tick 3's `preflightBudget` estimate as a "skipped because preflight" reason in apps/dashboard's review list.
- **Per-agent histograms in dashboard** — consume `clawreview_agent_duration_seconds` from /metrics and chart it.
- **Queue introspection in dashboard** — admin page that polls /api/internal/queue and shows pending/inflight + recent failures.
- **Calibration audit log** — extend the worker's `confidence_calibration_applied` log line into the review-store record so the dashboard can show "n findings auto-promoted/floored".
- **`clawreview diff-stats --threshold` CI gate** — exit non-zero when changedLines exceeds a configurable cap, for "PR too large to review" enforcement.
- **Webhook replay dashboard view** — consume /api/internal/webhook/recent (now with event/sinceMs/repo filters) + /replay so on-calls can re-fire stuck deliveries from the dashboard, not curl. Tick 5 made the filters first-class; the dashboard wiring is still TODO.

### Backlog seeded for tick 6 (refill — original + tick-4-refill are now 25/25 done!)
- ~~Worker emits `clawreview_authors_attributed_total{author}` counter~~ — telemetry primitive DONE tick 6 (29d65ee); worker-side wiring deferred until blame-via-GitHub-API plumbing lands.
- **`clawreview lint-config --fix` for trivial typos** — when a Zod issue maps cleanly to a known fix (e.g. `severity_threshold: warning` -> `medium`), offer a rewritten file. Off by default; require explicit flag.
- ~~Local preset transitive `extends:`~~ — DONE tick 6 (a4897e8). Local presets can now compose recursively with cycle detection across local + built-in namespaces.
- ~~Webhook recent endpoint pagination cursor~~ — DONE tick 6 (1636fd4). `?after=<deliveryId>` + `nextCursor` in response.
- ~~Aggregator `applyFloor` opts: a `min_confidence` knob~~ — DONE tick 6 (71ec100). `min_confidence` lives on `AggregateOptions`, the config schema, and wires through CLI + worker.
- ~~Server `/api/internal/webhook/stats`~~ — DONE tick 6 (0531fb7). Counts by event, event/action, and an hourly sparkline.

### Backlog seeded for tick 7 (refill — five of six tick-6 items shipped, plus follow-ups)
- ~~`clawreview lint-config --fix` for trivial typos~~ — DONE tick 7 (a1f48c3). Ships with curated typo rewrites for `severity_threshold`, `comment_style`, `inline_comments.min_severity`; AST-level rewrite preserves comments + key order.
- **Worker-side blame attribution + `clawreview_authors_attributed_total` wiring** — pair the tick-6 counter helper with a blame fetcher that uses the GitHub API (since the worker has no local checkout). Drives the Top Contributors PR block AND the Prometheus counter from the server side.
- **Dashboard widget for `/api/internal/webhook/stats`** — the endpoint shipped this tick. Wire it into apps/dashboard so on-calls see the by-event / hourly sparkline without curl. Tick 7's granularity work is now landing here too.
- **Dashboard widget for `/api/internal/webhook/recent` cursor pagination** — same store, list view rather than aggregate. Tick 6 made the cursor first-class; dashboard wiring is still TODO.
- ~~`severity_rules` matchers on `min_confidence`~~ — DONE tick 7 (345f712), shipped as `min_confidence` + `max_confidence` matchers plus a new `drop: true` action so the policy ladder composes cleanly with the global floor.
- ~~CLI `clawreview presets list`~~ — DONE tick 7 (a10b6cb). Prints built-in + local with declared extends chain; locals shadow built-ins and are annotated.

### Tick 7 — 2026-06-20 19:44 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | `severity_rules` confidence band matchers + `drop: true` action (types + aggregator + worker + CLI wiring) | 345f712 | +258/-28 | 12 new (types +5, aggregator +7) |
| 2 | `clawreview presets list` CLI (built-in + local with declared extends chain) | a10b6cb | +371/-1 | 6 new (cli/presets.test.ts) |
| 3 | `clawreview lint-config --fix` (AST-level rewrite of curated scalar typos, preserves comments + key order) | a1f48c3 | +256/-16 | 6 new (cli/lint-config.test.ts) |
| 4 | Telemetry `clawreview_findings_dropped_total{reason}` (closed reason set) + worker wiring across all three drop sources | 3b80acf | +105/-1 | 5 new (telemetry/metrics.test.ts) |
| 5 | Webhook stats `granularity` (minute/hour/day) + per-granularity bucket caps + `buckets` query knob | 4112f6c | +175/-27 | 5 new (server/webhook-replay.test.ts) |

Gate results: types 27/27 (+5 new), telemetry 29/29 (+5 new), aggregator 172/172 (+7 new), cli 93/93 (+12 new = 6 presets + 6 lint-config --fix), agents 72/72, server 205/205 (+5 new), diff 24/24, llm 12/12, github 14/14, queue 8/8 — **total 656 tests verified passing (+22 over tick 6)**. Touched-package typecheck delta: `@clawreview/types` clean (config.ts refinements add zero errors); `@clawreview/telemetry` clean (metrics.ts additions add zero errors); `@clawreview/aggregator` red only on the pre-existing `node:crypto`/`node:fs/promises` baseline (severity-rules.ts changes are clean); `apps/cli` clean across presets.ts, lint-config.ts, cli.ts, help.ts; `apps/server` red only on the pre-existing api-auth.ts / rate-limit.ts / webhooks.ts / server.ts / worker.ts (pino) baseline -- zero new errors on webhook-store.ts, webhook-replay.ts, or worker.ts beyond it. Push verified: `git ls-remote origin feature/autoship` -> `4112f6c`.

**Tick-7 refill: 3 of 6 backlog items shipped this tick (lint-config --fix, presets list, severity_rules min_confidence/drop). The three dashboard / blame-fetcher items remain open because they need work outside the unit-test-driven cron loop (live GitHub API integration / Next.js page wiring). Refilled with 5 fresh items for tick 8 below.**

### Backlog seeded for tick 8 (refill — three follow-ups carried + fresh items)
- **Worker-side blame attribution + `clawreview_authors_attributed_total` wiring** — carried from tick 7. Pair the tick-6 counter helper with a blame fetcher that uses the GitHub API. Drives the Top Contributors PR block AND the Prometheus counter from the server side.
- **Dashboard widget for `/api/internal/webhook/stats`** — carried from tick 7. Wire it into apps/dashboard so on-calls see the by-event / sparkline (now multi-granularity after tick 7) without curl.
- **Dashboard widget for `/api/internal/webhook/recent` cursor pagination** — carried from tick 7. Same store, list view rather than aggregate.
- ~~Aggregator `applyMinConfidence(findings, threshold)` extracted helper~~ — DONE tick 8 (a0196fc). Standalone helper that worker + CLI now use to count drops without re-walking sim.findings.
- ~~`clawreview stats --by category|agent|severity` grouping~~ — DONE tick 8 (433383f). Also added `--format json` (totals / byAgent / byCategory / topFiles / totalCostUsd) so dashboards consume the same numbers.
- ~~`/api/internal/webhook/recent` + `/stats` rate-limit class~~ — DONE tick 8 (f1404d6). Dedicated operator-poll class with its own bucket (default 3000/min) so chatty dashboards don't eat the operator's rerun / replay budget.
- ~~CLI `clawreview presets show <name>`~~ — DONE tick 8 (9973372). Yaml (default) / json / text, prints the extends-flattened body so an operator can preview before adopting.

### Tick 8 — 2026-06-20 22:27 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | Aggregator `applyMinConfidence(findings, threshold)` extracted helper + worker / CLI rewiring | a0196fc | +177/-20 | 6 new (aggregate.test.ts) |
| 2 | CLI `clawreview stats --by severity\|agent\|category` + `--format json` | 433383f | +366/-27 | 9 new (stats.test.ts: 5 --by + 4 --format json) |
| 3 | CLI `clawreview presets show <name>` (yaml default + json + text) | 9973372 | +367/-12 | 8 new (presets.test.ts) |
| 4 | Server operator-poll rate-limit class for /api/internal/webhook/{recent,stats} | f1404d6 | +292/-2 | 7 new (rate-limit-operator.test.ts: 2 pure + 5 wired) |
| 5 | Webhook stats `byRepo` slice + `?topRepos=` cap with `(other)` tail | 02d0eed | +229/0 | 5 new (webhook-replay.test.ts) |

Gate results: aggregator 178/178 (+6 new), cli 111/111 (+18 new = 9 stats + 8 presets show + 1 incidental from a stats sample-report refactor), server 217/217 (+12 new = 7 operator-poll + 5 byRepo), telemetry 29/29, types 27/27, agents 72/72, diff 24/24, llm 12/12, github 14/14, queue 8/8 — **total 712 tests verified passing (+56 over tick 7)**. Touched-package typecheck delta: `@clawreview/aggregator` red only on the pre-existing `node:crypto`/`node:fs/promises` baseline (aggregate.ts additions clean); `@clawreview/cli` clean across stats.ts, presets.ts, cli.ts, help.ts, run.ts changes; `@clawreview/telemetry` clean; `apps/server` red only on the pre-existing api-auth.ts / rate-limit.ts / server.ts / worker.ts (`pino`) baseline -- zero new errors on the new operator-poll class, webhook-store.ts byRepo additions, or webhook-replay.ts route changes. Push verified: `git ls-remote origin feature/autoship` -> `02d0eed`.

**Tick-8 refill: 4 of 7 backlog items shipped this tick (#1 helper, #2 stats --by, #3 presets show, #4 operator-poll class). The three dashboard / blame-fetcher items still need work outside the unit-test-driven cron loop. Refilled with fresh items for tick 9 below.**

### Backlog seeded for tick 9 (refill — three follow-ups carried + fresh items)
- **Worker-side blame attribution + `clawreview_authors_attributed_total` wiring** — carried from tick 7. Pair the tick-6 counter helper with a blame fetcher that uses the GitHub API. Drives the Top Contributors PR block AND the Prometheus counter from the server side.
- **Dashboard widget for `/api/internal/webhook/stats`** — carried from tick 7. Wire it into apps/dashboard so on-calls see the by-event / sparkline / byRepo (tick 8) without curl.
- **Dashboard widget for `/api/internal/webhook/recent` cursor pagination** — carried from tick 7. Same store, list view rather than aggregate.
- ~~`/api/internal/webhook/stats` peak-bucket detection~~ — DONE tick 9 (48b7e05). `peakBucketIndex` + `peakBucketCount` on `hourly`, tie-break to the newer bucket.
- **`/api/internal/webhook/stats` Prometheus exposition** — add a small `clawreview_webhook_deliveries_total{event,repo}` counter on the `put()` path so Prometheus can scrape the same shape the dashboard reads.
- ~~CLI `clawreview presets resolve <chain>`~~ — DONE tick 9 (2d1cf1f). Third sub-command on top of show/list. Resolve an ad-hoc extends chain without writing a file.
- ~~CLI `clawreview stats --top-files <n>` + `--by file`~~ — DONE tick 9 (6a47dcb). Both shipped together with the findingDigest rewire so the CLI and the worker / PR comment agree on counts.
- ~~Aggregator `findingDigest()` helper~~ — DONE tick 9 (4c80827). Pure single-pass helper that returns totalsBySeverity / byCategory / byAgent / byFile / topFiles / optional hotspots. CLI stats rewired to consume it.
- ~~Operator-poll class: `?force=1` bypass for in-band probes~~ — DONE tick 9 (5cbcd6d). Truthy-set bypass with bypass header; default per-token limiter still observes the hit so a runaway client cannot hide forever.

### Tick 9 — 2026-06-21 01:11 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | Aggregator `findingDigest(findings, opts)` single-pass summary helper (totalsBySeverity, byCategory, byAgent, byFile, topFiles cap, optional hotspots) | 4c80827 | +323/0 | 11 new (digest.test.ts) |
| 2 | CLI `clawreview stats --by file` + `--top-files <n>` + findingDigest rewire (CLI, worker, PR comment now share one counting helper; JSON shape gains `byFile`) | 6a47dcb | +284/-59 | 7 new (stats.test.ts --by file + --top-files group) |
| 3 | CLI `clawreview presets resolve <chain>` (yaml/json/text; positional + --chain; per-entry source attribution; unknown-name / cycle / empty-entry guards) | 2d1cf1f | +411/-5 | 12 new (presets.test.ts) |
| 4 | Server webhook stats `peakBucketIndex` + `peakBucketCount` (tie-break to newer bucket; null when sparkline empty) | 48b7e05 | +164/-1 | 4 new (webhook-replay.test.ts peak bucket group) |
| 5 | Server operator-poll class `?force=1` bypass for in-band probes (operatorPollForceParam helper + bypass header; per-token limiter still observes the hit) | 5cbcd6d | +173/-1 | 8 new (rate-limit-operator.test.ts: 5 pure + 3 wired) |

Gate results: aggregator 189/189 (+11 new digest), cli 130/130 (+19 new = 7 stats + 12 presets resolve), server 229/229 (+12 new = 4 peak + 8 force-bypass), telemetry 29/29, types 27/27, agents 72/72, diff 24/24, llm 12/12, github 14/14, queue 8/8 — **total 734 tests verified passing (+22 over tick 8)**. Touched-package typecheck delta: `@clawreview/aggregator` red only on the pre-existing `node:crypto`/`node:fs/promises` baseline (digest.ts clean); `apps/cli` clean across stats.ts, presets.ts, cli.ts, help.ts changes; `apps/server` red only on the pre-existing api-auth.ts / rate-limit.ts (isExempt / hits[0] / oldest baseline) / server.ts / worker.ts (pino) baseline -- zero new errors on webhook-store.ts peak fields, webhook-replay.ts (no changes), or rate-limit.ts operator-bypass additions. Push verified: `git fetch -q origin && git log --oneline origin/main | head -1` -> `5cbcd6d`.

**Tick-9 refill: 5 of 9 backlog items shipped this tick (#4 peak bucket, #6 presets resolve, #7 stats --top-files/--by file, #8 findingDigest helper, #9 force=1 bypass). The three dashboard / blame-fetcher items + the Prometheus exposition item still need work outside the unit-test-driven cron loop. Refilled with fresh items for tick 10 below.**

### Backlog seeded for tick 10 (refill — four follow-ups carried + fresh items)
- **Worker-side blame attribution + `clawreview_authors_attributed_total` wiring** — carried from tick 7. Pair the tick-6 counter helper with a blame fetcher that uses the GitHub API.
- **Dashboard widget for `/api/internal/webhook/stats`** — carried. Wire it into apps/dashboard so on-calls see the by-event / sparkline / byRepo / peakBucket (tick 9) without curl.
- **Dashboard widget for `/api/internal/webhook/recent` cursor pagination** — carried.
- ~~`/api/internal/webhook/stats` Prometheus exposition~~ — DONE tick 10 (0e265bc). `clawreview_webhook_deliveries_total{event,repo}` counter on the put() path plus sanitizeRepoLabel/observeWebhookDelivery helpers.
- **Aggregator `findingDigest` worker rewire** — surface the helper inside the worker's PR-comment header pipeline so the comment / CLI / dashboard agree on byte-identical counts. Today the CLI uses it (tick 9), worker still inlines its own loops.
- ~~CLI `clawreview presets diff <a> <b>`~~ — DONE tick 10 (8d5bfb0). Field-level delta between two ad-hoc preset chains; exit code 3 on non-empty delta for CI gateability.
- ~~Operator-poll class: `?probe=name` annotation~~ — DONE tick 10 (d317eb2). Pure logging + response header; works alongside force=1 to attribute polling traffic to a named dashboard widget.
- ~~CLI `clawreview stats --top-agents <n>` + `--by agent` cap~~ — DONE tick 10 (4b3eacb). Mirrors tick-9's --top-files cap; also added --top-categories. Digest now carries topAgents / topCategories slices alongside topFiles.
- ~~Webhook store `recent({ payloadFields })` projection~~ — DONE tick 10 (d47f67e). Shallow top-level allowlist projection on the store + `?payloadFields=action,number,sender` query parser on the route, so dashboards can render rich rows in one round-trip instead of N follow-up GETs.

### Tick 10 — 2026-06-21 04:42 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | Telemetry `clawreview_webhook_deliveries_total{event,repo}` ingress counter + sanitizeRepoLabel / observeWebhookDelivery helpers; receiver put() path wired | 0e265bc | +260/-2 | 11 new (8 telemetry sanitize/observe + 3 server wired ingress) |
| 2 | Server operator-poll `?probe=name` annotation (operatorPollProbeParam helper + structured req.log + x-ratelimit-operator-probe header; works with/without force=1) | d317eb2 | +271/-1 | 13 new (7 pure + 6 wired) |
| 3 | Webhook-store `recent({ payloadFields })` shallow projection + route `?payloadFields=action,number,sender` parser; capped at 32 names; explicit empty allowlist as opt-out | d47f67e | +480/-11 | 19 new (15 unit: sanitizeProjection / projectPayload / store integration + 4 wired route) |
| 4 | CLI `clawreview stats --top-agents <n>` + `--top-categories <n>` mirroring --top-files; digest gains topAgents/topCategories slices (default 10) | 4b3eacb | +372/-61 | 10 new (4 aggregator digest + 6 cli stats covering --by agent/category cap + json shape + default + clamp) |
| 5 | CLI `clawreview presets diff <a> <b>` (text/yaml/json; exit code 3 on non-empty delta for CI gateability; computePresetDelta helper) | 8d5bfb0 | +559/-5 | 12 new (cli presets.test.ts: no-diff/with-diff/only_in_a/only_in_b/changed/multi-chain/missing/unknown/invalid-format/empty-entry/text/yaml/flag-form) |

Gate results: telemetry 37/37 (+8 new), aggregator 193/193 (+4 new digest), cli 148/148 (+18 new = 6 stats + 12 presets diff), server 263/263 (+34 new = 3 webhook delivery + 13 probe + 4 wired payloadFields + 15 store-projection unit), types 27/27, agents 72/72, diff 24/24, llm 12/12, github 14/14, queue 8/8 — **total 798 tests verified passing (+64 over tick 9)**. Touched-package typecheck delta: `@clawreview/telemetry` clean (zero new errors on metrics.ts additions); `@clawreview/aggregator` red only on the pre-existing `node:crypto`/`node:fs/promises` baseline (digest.ts changes clean); `apps/cli` clean across stats.ts, presets.ts, cli.ts, help.ts; `apps/server` total typecheck line count IDENTICAL to bdee243 baseline (206 lines) -- verified by checking the pre-batch vs post-batch tsc output; zero new errors on webhooks.ts, webhook-store.ts, webhook-replay.ts, or rate-limit.ts beyond the pre-existing FastifyInstance / pino baseline noise. Push verified: `git fetch -q origin && git log --oneline origin/main | head -1` -> `8d5bfb0`.

**Tick-10 refill: 5 of 9 backlog items shipped this tick (#4 Prometheus exposition, #6 presets diff, #7 ?probe=name, #8 --top-agents/--top-categories, #9 payloadFields projection). The four carried items (worker blame wiring + 2 dashboard widgets + worker findingDigest rewire) still need work outside the unit-test-driven cron loop. Refilled with fresh items for tick 11 below.**

### Backlog seeded for tick 11 (refill — four follow-ups carried + fresh items)
- **Worker-side blame attribution + `clawreview_authors_attributed_total` wiring** — carried from tick 7. Pair the tick-6 counter helper with a blame fetcher that uses the GitHub API.
- **Dashboard widget for `/api/internal/webhook/stats`** — carried. Wire it into apps/dashboard so on-calls see the by-event / sparkline / byRepo / peakBucket (tick 9) without curl. Now also consumes `clawreview_webhook_deliveries_total` from /metrics for the same numbers Prometheus sees.
- **Dashboard widget for `/api/internal/webhook/recent` cursor pagination + payloadFields projection** — carried. Same store, list view rather than aggregate; tick 10's payloadFields projection means the widget can render rich rows in one round-trip.
- ~~Aggregator `findingDigest` worker rewire~~ — DONE tick 11 (97b4d77). `recomputeAggregateTotals(result)` helper centralises the post-suppression bucket arithmetic; worker collapsed from a 12-line loop to a single call. Worker / CLI / dashboard now share `findingDigest()` end-to-end.
- ~~Worker PR-comment header rewire to consume digest.topAgents / .topCategories~~ — DONE tick 11 (2ad9148). `renderPrComment` gains `topAgents` / `topCategories` / `digest` opts; worker passes both at default 8 each so the comment, CLI, and dashboard ship byte-identical capped ordering.
- ~~Server `?probe=name` Prometheus counter~~ — DONE tick 11 (5c575be). `clawreview_operator_poll_total{probe,result}` counter + sanitizeOperatorPollProbe / observeOperatorPoll helpers; rate-limit hook bumps on ok / bypass / throttled.
- ~~CLI `clawreview presets diff --only-fields <a,b,c>` filter~~ — DONE tick 11 (d007958). `parsePresetOnlyFields` + `filterPresetDelta` helpers; text / yaml / json renderers all surface the scope; CI-gateable exit-3 only fires on in-scope drift.
- ~~Webhook store `recent({ payloadFields })` dotted-path shape~~ — DONE tick 11 (7d45497). `splitProjectionPath` helper + `projectPayload` widening to walk nested paths and mirror the source shape; depth capped at 6.
- **Server `/api/internal/webhook/stats` `?bucketWindow=` end-time override** — today the sparkline is "from now, walking back"; some operators want "walking back from a specific incident time" so a postmortem snapshot is reproducible.

### Tick 11 — 2026-06-21 07:55 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | Aggregator `recomputeAggregateTotals(result)` helper (worker post-suppression rewire to share `findingDigest()`) | 97b4d77 | +207/-17 | 7 new (aggregate.test.ts: sparse-key contract, severity-bucket zeroing, idempotence, byte-identical match with aggregate()) |
| 2 | Comment renderer `topAgents` / `topCategories` / `digest` opts + worker wiring (default 8/8 caps) | 2ad9148 | +238/-7 | 5 new (comment.test.ts: category cap + tail, by-agent default-off / on, back-compat unbounded path, caller-supplied digest is honored) |
| 3 | Telemetry `clawreview_operator_poll_total{probe,result}` counter + rate-limit hook wiring (ok / bypass / throttled) | 5c575be | +369/0 | 12 new (7 telemetry sanitize/observe/closed-set/bundle-cache; 5 wired ok/bypass/throttled/(none)/non-poll-route) |
| 4 | CLI `presets diff --only-fields` scope filter (parsePresetOnlyFields + filterPresetDelta + text/yaml/json annotations) | d007958 | +391/-6 | 15 new (8 CLI integration; 7 pure helpers covering EMPTY_ENTRY sentinel, no-mutation, empty allowlist) |
| 5 | Webhook store payloadFields dotted-path support (`pull_request.title` walks + mirrored output shape; depth cap 6) | 7d45497 | +415/-22 | 18 new (5 splitProjectionPath pure; 9 projectPayload dotted; 3 wired list() integration; tick-10 back-compat byte-identical pin) |

Gate results: aggregator 205/205 (+12 new = 7 recompute + 5 comment), telemetry 44/44 (+7 new), cli 162/162 (+15 new presets diff filter), server 285/285 (+22 new = 5 rate-limit-operator wired + 18 webhook-store-projection dotted-path - 1 dedup from existing count, actually +22 net), types 27/27, agents 72/72, diff 24/24, llm 12/12, github 14/14, queue 8/8 — **total 853 tests verified passing (+55 over tick 10)**. Touched-package typecheck delta: `@clawreview/aggregator` red only on the pre-existing `node:crypto`/`node:fs/promises` baseline (aggregate.ts + comment.ts + digest.ts additions clean); `@clawreview/telemetry` clean (metrics.ts additions add zero errors); `apps/cli` clean across presets.ts, help.ts, presets.test.ts (test-side `process` baseline noise unchanged); `apps/server` typecheck line count IDENTICAL to 35f2eb5 baseline (209 lines) -- verified by stashing the batch, running tsc, and comparing line counts; zero new errors on worker.ts, rate-limit.ts, webhook-store.ts, webhook-replay.ts beyond the pre-existing FastifyInstance / pino / `path` / `oldest` baseline. Push verified: `git fetch -q origin && git log --oneline origin/main | head -1` -> `7d45497`.

**Tick-11 refill: 5 of 9 backlog items shipped this tick (#4 findingDigest worker rewire, #5 comment header rewire, #6 ?probe Prometheus counter, #7 presets diff --only-fields, #8 dotted-path payloadFields). The three dashboard items (stats / recent / blame attribution) and the new bucketWindow override still need work outside the unit-test-driven cron loop. Refilled with fresh items for tick 12 below.**

### Backlog seeded for tick 12 (refill — four follow-ups carried + fresh items)
- **Worker-side blame attribution + `clawreview_authors_attributed_total` wiring** — carried from tick 7. Pair the tick-6 counter helper with a blame fetcher that uses the GitHub API.
- **Dashboard widget for `/api/internal/webhook/stats`** — carried. Wire it into apps/dashboard so on-calls see the by-event / sparkline / byRepo / peakBucket (tick 9) without curl.
- **Dashboard widget for `/api/internal/webhook/recent` cursor pagination + payloadFields projection (now with dotted paths)** — carried. Tick 11 made `pull_request.title` first-class on the wire; the dashboard widget is the natural consumer.
- **Dashboard widget for `clawreview_operator_poll_total`** — pair the tick-11 Prometheus counter with a small "polling load by probe" panel in apps/dashboard so on-calls can see who's hammering the operator-poll budget without leaving the UI.
- ~~Server `/api/internal/webhook/stats` `?bucketWindow=` end-time override~~ — DONE tick 12 (c0d5bce). `?bucketWindow=<ms>` + `?bucketWindowAt=<ISO>` overrides the sparkline anchor for reproducible postmortem snapshots; composes with granularity / buckets / peakBucket. NaN/negative falls back to live clock silently; `appliedFilters.bucketWindow` echoes null vs ms so dashboards can render a Live/Snapshot label.
- ~~Aggregator `findingDigest` worker hand-off to comment header~~ — DONE tick 12 (2f826f0). Worker builds one digest per review and passes the SAME reference to `renderPrComment({digest})` AND `store.complete({digest})`. ReviewRecord gains optional `digest?: FindingDigest`; `/api/reviews/:id` DTO surfaces it (null on legacy). One tree walk powers PR comment header + dashboard detail + future drift detection.
- ~~Operator-poll counter labels `?probe=name` from the bypass arm~~ — DONE tick 12 (42e176b). New `clawreview_operator_poll_bypass_total{probe,reason}` attribution counter (closed reason set `['force']`). Volume metric answers "how many?"; attribution answers "why?". Bypass arm fires BOTH counters so they reconcile per-probe.
- ~~CLI `clawreview presets diff --exclude-fields <a,b,c>` (mirror of --only-fields)~~ — DONE tick 12 (7cd9abc). Same parser shape, opposite set semantics. Mutually exclusive with --only-fields (combining the two would double-filter; the mutex refuses loudly).
- ~~CLI `clawreview presets diff --output <path>` (write JSON / YAML to a file)~~ — DONE tick 12 (0143075). For migration-ticket flows where the diff body lands on disk for a follow-up commit. Resolves relative paths against --root; mkdir -p on intermediate dirs; --format text + --output exits 2 (text is for terminal display, not artifacts).

### Tick 12 — 2026-06-21 10:51 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | Server `/api/internal/webhook/stats` `?bucketWindow=<ms>` + `?bucketWindowAt=<ISO>` end-time anchor override (postmortem snapshots; NaN/negative falls back to live clock; appliedFilters.bucketWindow echoes null vs ms) | c0d5bce | +192/0 | 5 new (webhook-replay.test.ts bucketWindow override group) |
| 2 | Worker `findingDigest` hand-off: build ONCE, pass to renderPrComment({digest}) AND store.complete({digest}). ReviewRecord.digest persisted; /api/reviews/:id DTO surfaces it (null on legacy) | 2f826f0 | +187/-5 | 4 new (2 review-store digest persistence + 2 reviews-route DTO surface) |
| 3 | Telemetry `clawreview_operator_poll_bypass_total{probe,reason}` attribution counter (closed `['force']`). Rate-limit bypass arm fires BOTH volume + attribution so they reconcile per-probe | 42e176b | +267/-6 | 8 new (5 pure: bypass record / (none) bucket / closed literal / reconcile / bundle cache; 3 wired: force=1 bumps both / anonymous (none) / non-bypass leaves zero) |
| 4 | CLI `clawreview presets diff --exclude-fields <a,b,c>` (mirror of --only-fields; mutex check refuses combination; filterPresetDeltaExcluding pure helper) | 7cd9abc | +313/-7 | 11 new (7 CLI integration: drop-IN semantics / exit-0 hide / text annotation / yaml header / empty-entry-2 / mutex-2 / dedup; 4 pure helper: null pass-through / drop-IN / empty no-op / exclude-all empties) |
| 5 | CLI `clawreview presets diff --output <path>` (write JSON/YAML to file; mkdir -p; resolves relative-to-root; --format text exits 2) | 0143075 | +300/-22 | 8 new (6 CLI integration: JSON-to-file / YAML-to-file / mkdir -p / empty-diff still writes / text-exits-2 / --only-fields composes; 2 pure helper: absolute pass-through / relative-to-root) |

Gate results: telemetry 49/49 (+5 new bypass), aggregator 205/205, cli 181/181 (+19 new = 11 exclude-fields + 8 --output), server 297/297 (+12 new = 5 bucketWindow + 4 digest persistence + 3 wired bypass), types 27/27, agents 72/72, diff 24/24, llm 12/12, github 14/14, queue 8/8 — **total 889 tests verified passing (+36 over tick 11)**. Touched-package typecheck delta: `@clawreview/telemetry` clean (metrics.ts additions add zero errors); `@clawreview/cli` clean across presets.ts, help.ts (the pre-existing process/Buffer baseline noise in presets.test.ts is unchanged — cli's tsconfig doesn't pull @types/node); `apps/server` typecheck line count IDENTICAL to 7d45497 baseline (209 lines) — verified by `pnpm --filter @clawreview/server exec tsc --noEmit 2>&1 | wc -l`; zero new errors on webhook-replay.ts, review-store.ts, reviews.ts, rate-limit.ts, worker.ts beyond the pre-existing FastifyInstance / pino / `path` / `oldest` baseline. Push verified: `git fetch -q origin && git log --oneline origin/main | head -1` -> `0143075`.

**Tick-12 refill: 5 of 9 backlog items shipped this tick (#5 bucketWindow, #6 findingDigest worker hand-off, #7 bypass counter, #8 --exclude-fields, #9 --output). The four dashboard items (stats / recent / operator-poll-bypass / blame attribution) still need work outside the unit-test-driven cron loop. Refilled with fresh items for tick 13 below.**

### Backlog seeded for tick 13 (refill — four follow-ups carried + fresh items)
- **Worker-side blame attribution + `clawreview_authors_attributed_total` wiring** — carried from tick 7. Pair the tick-6 counter helper with a blame fetcher that uses the GitHub API.
- **Dashboard widget for `/api/internal/webhook/stats`** — carried. Now also consumes tick-12's `?bucketWindow=` for postmortem snapshot mode (a Live ↔ Snapshot toggle on the sparkline header).
- **Dashboard widget for `/api/internal/webhook/recent` cursor pagination + payloadFields projection** — carried.
- **Dashboard widget for `clawreview_operator_poll_total` + `clawreview_operator_poll_bypass_total`** — carried + extended. Tick-12's attribution counter pairs naturally with the volume counter; a single "polling load by probe / bypass drift by reason" panel covers both.
- **Worker drift detection via persisted digest** — tick 12 persisted `digest` on `ReviewRecord`. A follow-up should add a CLI / dashboard hook that recomputes `findingDigest(record.findings)` and surfaces drift (e.g. after a bulk dismiss the persisted digest no longer matches the live findings; show "review header counts are stale, refresh comment?").
- **Aggregator `findingDigest()` Hotspot integration on the persisted shape** — today the worker calls `findingDigest({topAgents, topCategories})` but never passes `hotspots: true`. Once the dashboard surfaces hotspots in the digest the worker should populate them so the dashboard, comment header, and CLI agree on the cluster list too.
- **Server `/api/internal/webhook/stats` `?bucketWindow=` Prometheus exposition** — tick 12 added the anchor override; a future tick could expose `clawreview_webhook_window_anchor` so an alert can fire "this dashboard is pinned to an incident snapshot, may be stale".
- **CLI `clawreview presets diff --output -` (stdout sentinel)** — for a CI pipeline that wants the file-write contract (one body, no kleur noise) but doesn't want to allocate a temp file. Reuses the existing --output plumbing with a `-` sentinel that writes to stdout in pure mode.
- **CLI `clawreview presets diff --base <a> --target <b>` (named flag form)** — today the chains are positional. A named-flag form pairs better with shell aliases (`alias prdiff='clawreview presets diff --base $BASE --target $TARGET'`).
- **CLI `clawreview presets diff --since <ref>` (compute chain a from a git ref)** — for "what changed in `.clawreview/presets/<name>.yml` between two commits?" — a thin wrapper that resolves both presets via git show then runs the existing diff.

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

### Tick 4 — 2026-06-20 08:32 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | Built-in config presets + `extends:` chain in CLI loader | 8a95772 | +425/-8 | 11 new (types) + 7 new (cli) |
| 2 | Server webhook replay endpoint + bounded in-memory store | 7d9390a | +483/-26 | 6 new (server, with dispatch refactor) |
| 3 | Agents preFilter short-circuit + UI/backend allowlists | 8c6f66f | +227/-4 | 7 new (agents) |
| 4 | Aggregator cross-agent similarity merge (rationale overlap) | 63d5277 | +338/-3 | 13 new (aggregator, worker + CLI wired) |
| 5 | Per-author finding breakdown via git blame + `clawreview authors` | 2ff2dd8 | +638/-0 | 11 new (aggregator) + 3 new (cli) |

Gate results: types 18/18 (+11 new), aggregator 153/153 (+24 new = 13 similarity + 11 authors), agents 72/72 (+7 new), cli 54/54 (+10 new = 7 extends + 3 authors), server 187/187 (+6 new, no regressions after webhook dispatch refactor), diff 24/24, llm 12/12, github 14/14, queue 8/8, telemetry 11/11 — total 553 tests verified passing (+58 over tick 3). Touched-package typecheck delta: `@clawreview/types` clean (presets.ts has zero new errors); `@clawreview/aggregator` similarity.ts and authors.ts clean (only the pre-existing `node:crypto` baseline noise on fingerprint.ts remains); `@clawreview/cli` clean across all new files (authors.ts, config-extends-aware config.ts, git.ts addition); `@clawreview/agents` clean on the modified files (the LLM `@types/node` baseline still shows when typechecking through the workspace graph but `agents.ts`/`prompted-agent.ts`/`prefilter.test.ts` introduce zero new errors); `apps/server` adds 1 line of FastifyInstance type-mismatch noise from the new `registerWebhookReplayRoutes(app)` call mirroring the existing internal-queue baseline pattern (zero errors in the new route/store/test files themselves). Push verified: `git ls-remote origin feature/autoship` -> `2ff2dd8`. **Original roadmap is now 20/20 — refilled with 5 fresh items for tick 5.**

### Tick 5 — 2026-06-20 13:56 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | Aggregator Top Contributors PR comment block (blame or pre-computed breakdown, top-N cap, unknown footnote) | 568f66d | +216/0 | 6 new (comment.test.ts) |
| 2 | Telemetry `clawreview_similarity_merges_total{winner_agent,loser_agent}` + worker wiring | 90d0dac | +102/-1 | 3 new (metrics.test.ts) |
| 3 | Project-local presets under `.clawreview/presets/*.yml` (validate + extends both honor them; per-package scoping) | bc70294 | +274/-13 | 8 new (config-extends.test.ts) |
| 4 | `clawreview lint-config` command (recursive walk, monorepo-scoped extends/local-preset resolution, text+json) | c377e80 | +451/0 | 11 new (lint-config.test.ts) |
| 5 | `/api/internal/webhook/recent` filters: `?event=`, `?sinceMs=`/`?since=` (ISO alt), `?repo=`, AND-composed | 262279f | +202/-14 | 5 new (webhook-replay.test.ts) |

Gate results: aggregator 159/159 (+6 new), telemetry 14/14 (+3 new), cli 73/73 (+19 new = 8 extends + 11 lint-config), server 192/192 (+5 new), agents 72/72, types 18/18, diff 24/24, llm 12/12, github 14/14, queue 8/8 — **total 586 tests verified passing (+33 over tick 4)**. Touched-package typecheck delta: `@clawreview/telemetry` clean; `@clawreview/aggregator` red only on the pre-existing `node:crypto`/`node:fs/promises` baseline in fingerprint.ts and diff/context.ts (zero new errors on comment.ts); `apps/cli` clean across new files (lint-config.ts, config.ts changes); `apps/server` red only on pre-existing api-auth.ts / rate-limit.ts / server.ts FastifyInstance baseline (zero new errors on webhook-replay.ts, webhook-store.ts, or worker.ts beyond the pre-existing `pino` type-resolution baseline). Push verified: `git ls-remote origin feature/autoship` -> `262279f`. **Original roadmap + tick-4 refill are now 25/25 — refilled with 6 fresh items for tick 6.**

### Tick 6 — 2026-06-20 16:29 PT — 5 features

| # | Slice | SHA | Lines | Tests |
|---|---|---|---|---|
| 1 | Telemetry `clawreview_authors_attributed_total` counter + sanitizeAuthorLabel + observeAuthorAttribution helpers | 29d65ee | +166/0 | 10 new (metrics.test.ts: 5 sanitize + 5 observe) |
| 2 | Server `/api/internal/webhook/stats` endpoint (totals by event, event/action, hourly sparkline) | 0531fb7 | +291/0 | 4 new (webhook-replay.test.ts) |
| 3 | `/api/internal/webhook/recent` pagination via `?after=<deliveryId>` + `nextCursor` response field | 1636fd4 | +174/-3 | 4 new (webhook-replay.test.ts) |
| 4 | Aggregator `min_confidence` floor in `AggregateOptions` + config schema + CLI/worker wiring + `--min-confidence` flag | 71ec100 | +172/-1 | 10 new (aggregate.test.ts +6, config.test.ts +4) |
| 5 | Local preset transitive `extends:` with cycle detection (replaces the "stripped with warning" stub) | a4897e8 | +258/-15 | 8 new (config-extends.test.ts) |

Gate results: aggregator 165/165 (+6 new), telemetry 24/24 (+10 new), cli 81/81 (+8 new), server 200/200 (+8 new = 4 stats + 4 cursor), types 22/22 (+4 new), agents 72/72, diff 24/24, llm 12/12, github 14/14, queue 8/8 — **total 634 tests verified passing (+48 over tick 5)**. Touched-package typecheck delta: `@clawreview/telemetry` clean (no new errors on metrics.ts -- the `bundle` LSP narrowing noise is unchanged baseline); `@clawreview/types` clean (zero new errors on config.ts); `@clawreview/aggregator` red only on the pre-existing `node:crypto`/`node:fs/promises` baseline (zero new errors on aggregate.ts); `apps/cli` clean across config.ts, run.ts, and the touched test files; `apps/server` red only on pre-existing api-auth.ts / rate-limit.ts / server.ts / worker.ts (`pino` resolution) baseline -- zero new errors on webhook-replay.ts, webhook-store.ts, or worker.ts. Push verified: `git ls-remote origin feature/autoship` -> `a4897e8`.

**Tick-6 refill: 5 of 6 backlog items shipped this tick (lint-config --fix was deferred to keep the batch focused on the 5 highest-impact slices). Refilled with 6 fresh items for tick 7 covering follow-ups for this tick's primitives (worker-side blame wiring for the new counter, dashboard widgets for the new endpoints) plus a couple of clean-slate items (severity_rules min_confidence integration, `clawreview presets list`).**

## Done
- 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25 — every roadmap item shipped.
