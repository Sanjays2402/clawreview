# Configuration reference

The configuration lives at the root of each installed repo as
`.clawreview.yml`. Unknown keys are rejected so typos surface as a
review failure, not a silent default.

```yaml
agents:               # list, default: security, performance, style, secrets
  - security
  - performance
  - style
  - secrets

severity_threshold: low   # critical | high | medium | low | nit

ignore:
  - "**/*.snap"
  - "**/vendor/**"

models:
  security: hermes/claude-opus-4
  performance: copilot/gpt-4o-mini

budget:
  monthly_usd: 50

custom_rules: []
max_findings_per_file: 8
comment_style: detailed   # detailed | compact
```

Validate from the CLI:

```
pnpm cli -- validate --config .clawreview.yml
```

## Server environment variables

These control the webhook receiver and worker behavior. They live in the
deployment environment, not in `.clawreview.yml`, because they are per-instance
operator settings rather than per-repo preferences.

| Variable | Default | Purpose |
| --- | --- | --- |
| `REVIEW_CONCURRENCY` | `6` | Max parallel (chunk x agent) tasks per review job. |
| `DEFAULT_MONTHLY_BUDGET_USD` | `50` | Fallback per-installation LLM budget when `.clawreview.yml` omits one. |
| `REVIEW_BOT_PRS` | `false` | When false, PRs opened by accounts whose login ends with `[bot]` are ignored at the webhook with `reason=bot`. Set to `true` to review Dependabot, Renovate, and similar bots. |
| `REVIEW_SKIP_AUTHORS` | empty | Comma-separated GitHub logins (case-insensitive) to always skip at the webhook with `reason=author`. Useful for blocking noisy vendor or CI accounts without changing every repo's config. |
