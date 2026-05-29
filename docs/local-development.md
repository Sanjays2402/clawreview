# Local development

```
pnpm install
cp apps/server/.env.example apps/server/.env
cp apps/dashboard/.env.example apps/dashboard/.env
cp apps/cli/.env.example apps/cli/.env

docker compose -f infra/docker/docker-compose.dev.yml up -d postgres redis
pnpm db:push
pnpm dev
```

`pnpm dev` runs the server, the dashboard, and the supporting watch tasks.
The CLI is independent and can be exercised against any repo:

```
pnpm cli -- run --base main --head HEAD --format text
```

If you do not have a local Hermes endpoint running, point the CLI at any
OpenAI-compatible endpoint with `LLM_BASE_URL` and `LLM_API_KEY`.
