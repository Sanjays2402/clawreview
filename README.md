# clawreview

Multi-agent AI code reviewer for GitHub pull requests.

![landing](docs/screenshots/landing.png)

## What it does

clawreview reviews pull requests with a fan-out of specialised agents (security, performance, style, secrets, sql-injection) and aggregates their output into a single, deduplicated set of findings per PR. GitHub webhooks land on the Fastify server, which enqueues a review job; workers fetch the diff, run agents in parallel against an OpenAI-compatible LLM endpoint, then post line comments and a summary back to the PR. Each finding carries a severity (`critical | high | medium | low | nit`) and a stable id so reruns don't duplicate comments. The dashboard tracks SLA breaches (time-to-first-review, time-to-resolution), per-installation monthly spend against a USD budget, and an append-only audit log of dismiss/reopen/bulk actions. It's keyboard-first (`⌘K` palette, `j/k` row nav), config is a single `.clawreview.yml` file with a live validation playground, and the same engine runs locally via the `clawreview` CLI.

## Features

- Per-PR findings list with severity, file/line, agent attribution, dismiss/reopen
- Bulk actions: `POST /api/reviews/:id/findings/bulk` (dismiss / reopen many)
- SLA tracking with breach feed (`/api/reviews/sla/breaches`) and dashboard page
- Append-only audit log (`/api/audit`, `/app/audit`)
- Monthly budget per installation in USD with reset (`/api/budget/:installationId`)
- Repo health view and pause/resume per repo
- Config playground: paste `.clawreview.yml`, hit `POST /api/config/validate`
- Command palette (`⌘K`) over all dashboard routes
- Vim-style `j/k`, `gg`, `G`, `e`, `x`, `r` shortcuts on findings list
- Rerun a review: `POST /api/reviews/rerun`
- Export findings: CSV, SARIF, JUnit XML, Markdown report
- Outbound notification webhook with HMAC-SHA256 signing and min-severity filter
- Author filters: skip bot PRs and a comma-separated allowlist
- Rate limit (240/min) and Helmet on all server routes
- Weekly stats endpoint for trends charts
- Local CLI (`pnpm cli`) that runs the same agent pipeline against a local diff

## Stack

- Node 20+, TypeScript, pnpm 10 workspaces, Turborepo
- Server: Fastify 5, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`, envalid, zod
- Dashboard: Next.js 15 (App Router), React 19, Tailwind 3, Phosphor Icons, Geist
- DB: PostgreSQL 16 via Prisma 5
- Queue: Redis 7
- LLM: OpenAI-compatible providers (OpenAI, Hermes, Copilot endpoints)
- Tests: Vitest, Playwright (dashboard e2e)

## Architecture

GitHub posts to the Fastify server's webhook route. The server validates, persists the review row, and pushes a job onto Redis. A worker pulls the job, hydrates the diff via `@clawreview/github`, runs the agent pipeline from `@clawreview/agents` against an LLM provider from `@clawreview/llm`, then `@clawreview/aggregator` dedupes and ranks findings before they're written back to Postgres and surfaced via the API to the Next.js dashboard.

```
 GitHub ─webhook─▶ Fastify server ─▶ Postgres (reviews, findings, audit)
                       │
                       ├─▶ Redis queue ─▶ worker ─▶ agents ─▶ LLM provider
                       │                                       │
                       └─◀────── findings + comments ◀─────────┘
 Next.js dashboard ───HTTP───▶ Fastify server
```

## Quick start

Prereqs: Node >= 20, pnpm 10.33, Docker (for Postgres + Redis), a GitHub App.

```bash
git clone https://github.com/Sanjays2402/clawreview.git
cd clawreview
pnpm install

# infra
docker compose -f infra/docker/docker-compose.dev.yml up -d postgres redis

# env
cp apps/server/.env.example apps/server/.env
cp apps/dashboard/.env.example apps/dashboard/.env
cp packages/db/.env.example packages/db/.env
# fill GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, LLM_*_API_KEY

# db
pnpm db:push

# dev (turbo runs server + dashboard + watchers)
pnpm dev
```

Dashboard: `http://localhost:3000` · Server: `http://localhost:4000` · Health: `GET /healthz`.

## Configuration

Server (`apps/server/.env`):

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `test` / `production` |
| `PORT` | `4000` | Fastify port |
| `HOST` | `0.0.0.0` | bind address |
| `LOG_LEVEL` | `info` | pino level |
| `DATABASE_URL` | `postgresql://clawreview:clawreview@localhost:5432/clawreview` | Postgres |
| `REDIS_URL` | _empty_ | required for queue/worker |
| `PUBLIC_URL` | `http://localhost:4000` | public server URL |
| `DASHBOARD_URL` | `http://localhost:3000` | CORS origin |
| `GITHUB_APP_ID` | _empty_ | GitHub App id |
| `GITHUB_APP_PRIVATE_KEY` | _empty_ | PEM contents |
| `GITHUB_WEBHOOK_SECRET` | _empty_ | webhook HMAC secret |
| `GITHUB_APP_SLUG` | `clawreview` | install URL slug |
| `LLM_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base |
| `LLM_OPENAI_API_KEY` | _empty_ | OpenAI key |
| `LLM_HERMES_BASE_URL` | `http://127.0.0.1:8642/v1` | local Hermes endpoint |
| `LLM_COPILOT_BASE_URL` | `http://127.0.0.1:4141/v1` | Copilot proxy |
| `LLM_COPILOT_API_KEY` | _empty_ | Copilot key |
| `REVIEW_CONCURRENCY` | `6` | parallel reviews per worker |
| `DEFAULT_MONTHLY_BUDGET_USD` | `50` | default installation budget |
| `COOKIE_SECRET` | `dev-cookie-secret-change-me` | rotate in prod |
| `REVIEW_BOT_PRS` | `false` | review PRs from `[bot]` accounts |
| `REVIEW_SKIP_AUTHORS` | _empty_ | comma-separated logins |
| `NOTIFY_WEBHOOK_URL` | _empty_ | outbound completion webhook |
| `NOTIFY_WEBHOOK_SECRET` | _empty_ | HMAC-SHA256 signing key |
| `NOTIFY_WEBHOOK_MIN_SEVERITY` | `medium` | `critical`/`high`/`medium`/`low`/`nit` |
| `NOTIFY_WEBHOOK_ON_FAILURE` | `true` | also notify on failed reviews |
| `NOTIFY_WEBHOOK_TIMEOUT_MS` | `5000` | per-delivery timeout |

Dashboard (`apps/dashboard/.env`): `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_API_URL`, `PUBLIC_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

CLI (`apps/cli/.env`): `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_DEFAULT_MODEL`.

Per-repo config (`.clawreview.yml`):

```yaml
agents: [security, performance, style, secrets, sql-injection]
severity_threshold: low
ignore: ["**/*.snap", "**/vendor/**", "pnpm-lock.yaml"]
budget: { monthly_usd: 50 }
comment_style: detailed
max_findings_per_file: 10
```

More examples in `examples/`.

## Scripts

Top-level (`package.json`):

- `pnpm build` turbo build across workspaces
- `pnpm dev` turbo dev (server + dashboard + watchers)
- `pnpm lint` turbo lint
- `pnpm typecheck` turbo typecheck
- `pnpm test` turbo test (vitest in every package)
- `pnpm format` prettier write
- `pnpm cli` run the local `clawreview` CLI
- `pnpm server` run `@clawreview/server` in watch mode
- `pnpm dashboard` run the Next.js dashboard
- `pnpm db:push` `prisma db push` against `DATABASE_URL`
- `pnpm db:migrate` `prisma migrate dev`
- `pnpm changeset` open a changeset
- `pnpm release` `changeset publish`

Workspace scripts:

- `apps/server`: `dev`, `start`, `build`, `typecheck`, `test`, `test:integration`
- `apps/dashboard`: `dev` (port 3000), `build`, `start`, `typecheck`, `lint`, `test:e2e` (Playwright)
- `apps/cli`: `start`, `build`, `typecheck`, `test`
- `packages/db`: `build`, `generate`, `push`, `migrate`, `typecheck`, `test`

Repo scripts (`scripts/`):

- `check-secrets.sh` grep for committed secrets
- `lint-no-emdash.sh` fail on em-dashes in tracked files
- `seed-dev.ts` seed Postgres with sample reviews

## API

Base URL: `http://localhost:4000`. JSON in/out. All `/api/*` are CORS-restricted to `DASHBOARD_URL`.

Health
- `GET /healthz` liveness
- `GET /readyz` readiness (DB/Redis)
- `GET /version` build info

Webhooks
- `POST /webhooks/github` GitHub App events (HMAC-verified)

Reviews
- `GET /api/reviews` list reviews (paginated)
- `GET /api/reviews/:id` single review with findings
- `POST /api/reviews/rerun` rerun a review
- `GET /api/reviews/:id/report.md` Markdown report
- `GET /api/reviews/:id/findings.csv` CSV export
- `GET /api/reviews/:id/sarif` SARIF export
- `GET /api/reviews/:id/junit.xml` JUnit XML export
- `POST /api/reviews/:id/findings/bulk` bulk dismiss/reopen
- `GET /api/reviews/sla/breaches` SLA breach feed

Findings
- `POST /api/findings/:id` mutate a single finding (dismiss/reopen/comment)

Repos
- `GET /api/repos/health` health across all tracked repos
- `GET /api/repos/:owner/:repo/health` single repo
- `POST /api/repos/:owner/:repo/pause` pause reviews
- `POST /api/repos/:owner/:repo/resume` resume reviews

Installations
- `GET /api/installations` list installations
- `GET /api/installations/:id/repos` repos under an installation

Budget
- `GET /api/budget/:installationId` current month spend + cap
- `PUT /api/budget/:installationId` update monthly cap
- `POST /api/budget/:installationId/reset` reset counters

Config
- `GET /api/config/default` server default config
- `POST /api/config/validate` validate a `.clawreview.yml` body

Audit / Stats
- `GET /api/audit` audit log (filterable)
- `GET /api/stats/weekly` weekly aggregate

## Keyboard shortcuts

Global
- `⌘ K` open command palette
- `?` open shortcuts
- `esc` close overlay

Findings list
- `j` next finding
- `k` previous finding
- `g g` jump to first
- `G` jump to last
- `e` expand / collapse focused row
- `x` dismiss focused finding
- `r` reopen focused finding

Palette
- `↑ ↓` navigate results
- `↵` run command
- `ctrl n / p` navigate results

Source: `apps/dashboard/src/app/shortcuts/page.tsx` and `apps/dashboard/src/components/command-palette.tsx`.

## Project structure

```
.
├── apps
│   ├── cli         # local clawreview CLI
│   ├── dashboard   # Next.js 15 dashboard
│   └── server      # Fastify API + worker
├── packages
│   ├── agents      # agent pipeline + prompts + language rules
│   ├── aggregator  # finding dedupe + ranking
│   ├── config      # shared eslint/tsconfig/tailwind/prettier
│   ├── db          # Prisma schema + client
│   ├── diff        # unified diff parsing
│   ├── github      # GitHub App / REST helpers
│   ├── llm         # OpenAI-compatible providers + retry/rate-limit
│   ├── queue       # Redis queue
│   ├── telemetry   # pino logger + request ids
│   ├── types       # zod schemas (severity, findings, config)
│   └── ui          # shared React components
├── infra
│   ├── docker      # Dockerfile.server, Dockerfile.dashboard, compose
│   ├── helm        # chart
│   └── terraform   # AWS
├── examples        # sample .clawreview.yml configs
├── scripts         # check-secrets, lint-no-emdash, seed-dev
├── docs            # ADRs, runbooks, API, screenshots
└── tests           # cross-package fixtures
```

## Operations

The server exposes operational endpoints intended for scraping and probing
by Kubernetes, Prometheus, and on-call tooling.

- `GET /healthz` returns 200 if the process is up. Cheap, no dependencies.
  Used as the Kubernetes liveness probe and excluded from rate limiting and
  metric scraping.
- `GET /readyz` returns 200 only when the queue (and, unless
  `?skipLlm=1` is passed, at least one LLM provider) is reachable. Used as
  the readiness probe.
- `GET /version` returns the build version and Node runtime.
- `GET /metrics` returns Prometheus text format. Includes
  `prom-client` default process metrics (CPU, memory, event loop lag, GC,
  open handles) plus custom series:
  - `http_requests_total{method,route,status_code}` counter
  - `http_request_duration_seconds{method,route,status_code}` histogram
    (buckets: 5ms to 10s)
  - `clawreview_webhook_events_total{event,action,result}` counter
  - `clawreview_reviews_started_total{source}` counter
  - `clawreview_reviews_completed_total{outcome}` counter

  The `route` label uses the matched Fastify route template
  (e.g. `/reviews/:id`), not the raw URL, so review identifiers and other
  high-cardinality path segments do not explode the metric series.
  Unmatched paths collapse to `route="unmatched"`. `/metrics` and
  `/healthz` are intentionally excluded from the HTTP histograms so scrape
  traffic and liveness pings do not skew latency percentiles.

For Prometheus scraping under Helm, set the pod annotations on the server
deployment:

```yaml
podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "4000"
  prometheus.io/path: "/metrics"
```

These are emitted by `infra/helm/clawreview/values.yaml` under
`podAnnotations.server` and can be overridden per environment.

### Audit log

Mutations to review and budget state are recorded to the `AuditLog` table
so operators can answer who did what when. Writes are best effort and
loss tolerant: an audit failure logs a warning and does not break the
caller's request. Backfilling is not supported, so a brief Postgres
outage will leave a hole in the trail.

Actions emitted today:

- `review.enqueued` when an inbound GitHub webhook enqueues a review.
  Actor is the PR author, subject is `<owner>/<repo>#<pr>`, meta includes
  the review id, job id, head sha, GitHub delivery id, and PR action.
- `review.rerun` when `POST /api/reviews/rerun` is called from the
  dashboard. Actor is taken from the `x-actor-login` header when present,
  otherwise `dashboard`.
- `budget.updated` when `PUT /api/budget/:installationId` is called.
  Meta records the new limit and the current spent amount.
- `budget.reset` when `POST /api/budget/:installationId/reset` is called.

Read the trail with `GET /api/audit`. Filters: `installationId`,
`actorLogin`, `action`. Pagination is opaque cursor based; pass the
`nextCursor` returned by the previous page as `?cursor=...` to continue.
`limit` is clamped to 200.

```bash
curl -s "http://localhost:4000/api/audit?installationId=99&limit=25" | jq
```

Backup the table with the same Postgres dump that covers `Review` and
`Finding`. Recommended retention is 365 days for SOC 2 style audits;
prune older rows with a scheduled job (not yet wired in this repo).

Deploy, scale, backup, and on-call notes live in `docs/runbooks/`.

### Scaling and disruption

The Helm chart ships HorizontalPodAutoscaler, PodDisruptionBudget, and
NetworkPolicy templates so production clusters get scaling and blast-radius
controls without bespoke YAML.

HPA is off by default so the static `replicaCount` stays authoritative on
clusters without metrics-server. Enable per component:

```yaml
autoscaling:
  server:
    enabled: true
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilizationPercentage: 70
    targetMemoryUtilizationPercentage: 80
  dashboard:
    enabled: true
    minReplicas: 2
    maxReplicas: 6
    targetCPUUtilizationPercentage: 70
```

The server HPA includes a behavior block that scales up aggressively
(double the pods every 30s, or +2 pods, whichever is larger) and scales
down conservatively (50% every 60s with a 5 minute stabilization window)
so bursty webhook traffic does not flap.

PodDisruptionBudgets are on by default at `minAvailable: 1` for both
server and dashboard. Cluster operators draining a node will always leave
at least one replica serving traffic. Override per environment:

```yaml
podDisruptionBudget:
  server:
    enabled: true
    minAvailable: 2
  dashboard:
    enabled: true
    maxUnavailable: 1
```

NetworkPolicy is off by default because it requires a policy-aware CNI
(Calico, Cilium, etc.). When enabled, the server pod accepts ingress
only from the dashboard pod and from namespaces listed in
`networkPolicy.server.allowFromNamespaces` (defaults include
`ingress-nginx` and `monitoring` so Prometheus can still scrape
`/metrics`). Egress is restricted to DNS plus TCP 443, 5432, and 6379,
and the cloud metadata endpoint `169.254.169.254/32` is explicitly
blocked to mitigate SSRF.

```yaml
networkPolicy:
  enabled: true
  server:
    allowFromNamespaces:
      - ingress-nginx
      - monitoring
  dashboard:
    allowFromNamespaces:
      - ingress-nginx
```

The chart is covered by a vitest in `apps/server/tests/helm-chart.test.ts`
that parses each template and verifies the rendered `kind` and
`apiVersion`, so accidental indentation regressions fail CI before they
reach a cluster.

## License

MIT. See `LICENSE`.

