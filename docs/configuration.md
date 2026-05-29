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
