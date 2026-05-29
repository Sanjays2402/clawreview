# Deployment

Two supported targets ship in the box. Both expect Postgres and Redis to
exist outside the application boxes.

## Docker Compose (development and small self-host)

`infra/docker/docker-compose.dev.yml` brings up Postgres, Redis, the server,
and the dashboard. Run:

```
docker compose -f infra/docker/docker-compose.dev.yml up -d
pnpm db:push
```

Webhook delivery during local development is easiest with a tunnel:

```
cloudflared tunnel --url http://localhost:4000
```

## Kubernetes (Helm)

`infra/helm/clawreview` is a minimal chart with separate `server` and
`dashboard` deployments, a shared `Secret`, and ingress placeholders. Use
the chart values to point at managed Postgres and Redis.

```
helm install clawreview infra/helm/clawreview -f my-values.yaml
```

## AWS (Terraform)

`infra/terraform/aws` is a starting skeleton that provisions:

- VPC with two private and two public subnets
- An ECS cluster with two services (`server`, `dashboard`)
- RDS Postgres
- ElastiCache Redis
- An Application Load Balancer in front of the services

It is intentionally not opinionated about DNS or TLS. Plug in your usual
ACM and Route 53 modules.

## Operational checklist

- Rotate the GitHub App private key once a quarter and update the secret.
- Keep the worker concurrency below your LLM provider's per-key rate limit.
- Monitor `clawreview_review_duration_seconds` and `clawreview_findings_total`.
- Audit log retention should match your compliance window.
