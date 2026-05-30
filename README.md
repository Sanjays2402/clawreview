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

GDPR
- `GET /api/users/:login/data-export` export a user's data (right to access)
- `DELETE /api/users/:login` erase a user (right to erasure)

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

### GitHub App installations

The server exposes the GitHub App's tenant graph through two read-only
endpoints. Both require at least the `readonly` API role and every
successful call writes an audit row (`installations.list` or
`installations.repos.list`) so operators can trace tenant enumeration.

- `GET /api/installations` returns every installation of the configured
  GitHub App. Paginates against the GitHub API internally and returns a
  flattened list with `count`.
- `GET /api/installations/:id/repos?per_page=&page=` returns the
  repositories a specific installation has granted access to. Accepts
  `per_page` (1..100, default 30) and `page` (1..1000, default 1). The
  response includes `totalCount`, `page`, and `perPage` so the dashboard
  can paginate without re-querying GitHub.

When `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY` is unset, both routes
return `503 GitHubAppNotConfigured` rather than a silent empty list, so a
misconfigured deployment is visible to the dashboard and to alerting.
Non-existent installation ids surface as `404 NotFound`; other upstream
failures surface as `502 GitHubUpstreamError` with the underlying GitHub
status echoed in the body. Both routes count against the per-IP and
per-token rate limits described below.

The `GITHUB_APP_PRIVATE_KEY` env var accepts either real newlines or the
literal `\n` sequences produced by most secret stores; the route
normalises them before signing the App JWT.

### Rate limiting

Two independent limiters protect the API.

- **Per IP, global.** `@fastify/rate-limit` is registered with a default
  of 240 requests per minute keyed on client IP. It applies to every
  route except `/healthz` and `/metrics`. This is the first line of
  defence against unauthenticated floods and bots probing the surface.
- **Per token, scoped to `/api/*`.** A second limiter in
  `apps/server/src/plugins/rate-limit.ts` keys on the API token name
  resolved by the api-auth plugin and falls back to client IP when no
  token is present. The default is 600 requests per minute per token
  over a sliding 60 second window. The per-token limiter exists so a
  runaway script using a valid token cannot exhaust the per-IP budget
  for everyone else behind the same NAT, and so each integration can
  be rotated or revoked independently when it misbehaves.

When either limiter trips, the server returns `429 Too Many Requests`
with a `retry-after` header (seconds) and a JSON body containing
`error`, `limit`, `retryAfter`, and the originating `requestId`. Every
rate-limited response also includes `x-ratelimit-limit` and
`x-ratelimit-remaining` so well-behaved clients can back off without
seeing a 429 first.

Exempt paths (never rate-limited): `/healthz`, `/readyz`, `/metrics`,
`/version`, and `/webhooks/*`. Webhooks are authenticated by HMAC
signature in the webhook handler, so they have their own abuse story
and throttling them would cause GitHub to retry against a healthy
upstream for no gain.

To disable the per-token limiter locally during load tests, set
`DISABLE_PER_TOKEN_RATE_LIMIT=1`. This flag is ignored in production.

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

### Error tracking (Sentry)

Unhandled server faults are forwarded to Sentry when `SENTRY_DSN` is
set. The wrapper lives in `@clawreview/telemetry` (`sentry.ts`) and
lazily loads `@sentry/node` so leaving the DSN empty keeps the SDK out
of the process entirely. No traffic is emitted in development or test.

What is captured:

- 5xx responses from the Fastify error handler, tagged with
  `requestId`, `method`, `url`, and the matched `route` template (same
  label used by the Prometheus histograms, so traces and metrics line
  up).
- `unhandledRejection` and `uncaughtException` from the Node process,
  tagged with `source` so worker failures are distinguishable from
  request-path failures.
- Bootstrap failures in `main()` before the HTTP listener is up.

4xx responses are intentionally not forwarded; they are caller
mistakes and would only add noise. The shutdown handler calls
`flushSentry(2000)` so in-flight events are not dropped on SIGTERM.

Configuration:

| Variable | Default | Notes |
| --- | --- | --- |
| `SENTRY_DSN` | empty | Empty disables the SDK. Store in a secret, not the chart values. |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` | Override per cluster (e.g. `staging`, `production`). |
| `SENTRY_RELEASE` | `npm_package_version` | Set to the git sha at build time for source-mapped stack traces. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Bump above 0 to enable Sentry performance tracing. |

Under Helm, the DSN is wired through `secrets.sentryDsn` and the
remaining knobs through `env.SENTRY_*` in `values.yaml` so on-call can
rotate the DSN without re-rendering the chart.

### API authentication

All `/api/*` routes require a bearer token. Public surfaces stay open:
`/healthz`, `/readyz`, `/metrics`, and `/webhooks/*` (webhooks are
independently authenticated by GitHub HMAC signature verification).

Tokens are configured via the `API_AUTH_TOKENS` env var, a comma-separated
list. Each entry may encode a role for per-route authorization:

```
API_AUTH_TOKENS="dashboard:readonly:$(openssl rand -hex 32),ops:operator:$(openssl rand -hex 32),root:admin:$(openssl rand -hex 32)"
```

Legacy `name:token` and bare-token entries are still accepted and default
to the `admin` role so existing deployments do not silently downgrade on
upgrade.

Callers present the token as either header:

```
Authorization: Bearer <token>
x-api-key: <token>
```

Matching is constant-time. Failed auth returns `401 Unauthorized` with a
`www-authenticate: Bearer realm="clawreview-api"` header and the
offending request id in the body.

Behaviour by environment:

- `development` and `test`: an empty `API_AUTH_TOKENS` leaves the API
  open and the server logs `api auth disabled` at startup. This keeps the
  local `pnpm dev` loop and the existing vitest suite frictionless.
- `production`: an empty `API_AUTH_TOKENS` is a hard startup failure.
  The server refuses to boot rather than silently exposing the management
  API. Set the value via `secrets.apiAuthTokens` in the Helm chart (it is
  mounted into the server pod through the shared secret as `envFrom`).

The dashboard reads `CLAWREVIEW_API_TOKEN` server-side only (no
`NEXT_PUBLIC_` prefix) and attaches it to every upstream call from
`apps/dashboard/src/lib/data.ts`. Rotate by adding a second named token,
rolling the dashboard with the new value, then removing the old entry on
the next deploy.

On-call runbook for a leaked token:

1. Remove the affected entry from `secrets.apiAuthTokens` and `helm
   upgrade`. The server reloads on rollout and the old token stops
   working immediately (no in-process token cache TTL).
2. Generate a replacement with `openssl rand -hex 32`, add it under a new
   name, and roll the dashboard / CI consumers that depend on it.
3. Grep the server logs for `api auth enabled` to confirm the new token
   count, and for `Unauthorized` 401s coming from unexpected IPs to
   confirm the leaked credential is rejected.

### Role-based access control

Every `/api/*` route is gated by one of three roles. The roles form a
strict hierarchy: `admin` includes `operator` includes `readonly`.

| Role | What it can do |
| --- | --- |
| `readonly` | GET review lists and detail, exports (`.md`, `.sarif`, `.junit.xml`, `.csv`), budget snapshots, repo health, SLA breaches, weekly stats, config validation, installations |
| `operator` | Everything `readonly` does, plus budget edits and resets, review rerun, repo pause/resume, finding acknowledgement (`/api/findings/:id`, `/api/reviews/:id/findings/bulk`) |
| `admin` | Everything `operator` does, plus `GET /api/audit` and GDPR endpoints `GET /api/users/:login/data-export` and `DELETE /api/users/:login` |

A token with insufficient role gets `403 Forbidden` with a body that
names both the role it has and the role the route requires. Every denial
is persisted as an audit row with action `api.forbidden` so abuse is
visible from the `GET /api/audit` query.

Issue tokens scoped to the minimum role the consumer needs:

- Dashboard SSR fetches that only read data: `readonly`.
- A dashboard action that triggers reruns or pauses a repo: `operator`.
- A DPO tool that calls `DELETE /api/users/:login`: `admin`.
- CI smoke checks that hit `GET /api/reviews`: `readonly`.

When rotating, prefer adding the new role-scoped token first, switching
consumers, then removing the old broader-scoped entry.

### GDPR data lifecycle

ClawReview persists user identities (GitHub login, optional email),
active sessions, installation memberships, and audit entries that name
the user as actor. Two operator endpoints fulfil the right-to-access and
right-to-erasure obligations under GDPR Articles 15 and 17. Both routes
are gated by the standard API token auth, are rate limited by the
per-token limiter, and write an audit row on success.

- `GET /api/users/:login/data-export` returns a JSON bundle with the
  user profile, sessions, memberships, and the most recent 1000 audit
  entries the user authored. Sent as an attachment with
  `content-disposition: user-<login>-export.json` so the dashboard or an
  operator can hand the file to the requester directly. 404 if no such
  user exists.
- `DELETE /api/users/:login` removes the user row and cascades sessions
  and memberships via Prisma's `onDelete: Cascade`. Audit log entries
  authored by the user are kept (deleting them would defeat the security
  purpose of the log) but have their `actorLogin` replaced with a stable
  per-login pseudonym of the form `erased-user-<12 hex chars>` and any
  free-form `metaJson` payload cleared. The response is a receipt with
  `deletedUserId`, `sessionsDeleted`, `membershipsDeleted`,
  `auditEntriesAnonymised`, `pseudonym`, and `completedAt` that the DPO
  can archive as evidence of fulfilment.

The pseudonym is deterministic (`sha256("gdpr:<login>")` truncated to
12 hex chars), so audit rows for the same erased user remain correlatable
for forensic follow-up, but the original login cannot be recovered from
the pseudonym alone.

Operational notes:

1. Verify the data subject's identity out of band before calling either
   endpoint. The endpoints trust the caller's API token; they do not
   re-verify the subject.
2. Pull the export first, archive it, then issue the delete. The export
   route is read-only and safe to retry.
3. Both calls show up in `GET /api/audit` with `action=gdpr.export` or
   `action=gdpr.delete` and `subject=user:<login>`, with the API token
   name as the actor. Keep those rows; they are the audit trail of the
   erasure itself.
4. A delete against an unknown login returns 404 and writes no audit
   row, so retries are idempotent.

### Continuous integration

The `.github/workflows/ci.yml` pipeline is the gate on every push and
pull request against `main`. It is split into four jobs so a regression
in one signal does not mask the others, and each job is guarded by the
`ENABLE_CI` repository variable to keep forks from burning Actions
minutes by accident.

1. `lint-typecheck-test` runs `pnpm typecheck`, `pnpm lint`, and
   `pnpm test` across the turbo graph. This is the fast feedback loop
   and is the prerequisite for the two heavier jobs.
2. `build` runs the real production `pnpm build`, asserts that
   `apps/server/dist/index.js` exists, and uploads the server `dist/`
   tree as an artifact with a 7 day retention. Catches changes that
   pass `tsc --noEmit` but break the emitted bundle.
3. `helm-validate` installs the Helm CLI, runs `helm lint` against
   `infra/helm/clawreview`, renders the chart twice (default values and
   a high-availability override with ingress and autoscaling on), greps
   the HA render for the operationally critical kinds
   (`Deployment`, `Service`, `HorizontalPodAutoscaler`,
   `PodDisruptionBudget`, `NetworkPolicy`, `Secret`, `Ingress`), and
   then validates both renders with `kubeconform` against the
   Kubernetes 1.29 schemas. Stops a template edit that compiles but
   produces invalid manifests from reaching a cluster.
4. `docker-build` builds both `infra/docker/Dockerfile.server` and
   `infra/docker/Dockerfile.dashboard` via a matrix with Buildx and
   GitHub Actions layer caching. Images are built with `load: true` and
   not pushed; the goal is to fail the pipeline if a Dockerfile change
   or a dependency bump breaks the production image.

The `apps/server/tests/ci-workflow.test.ts` test parses the workflow
file and asserts the four jobs, their `needs` ordering, the matrix of
image names, and the presence of the helm and kubeconform invocations.
That way a future edit that quietly drops one of the gates fails the
unit suite locally before it ever reaches CI.

## License

MIT. See `LICENSE`.

