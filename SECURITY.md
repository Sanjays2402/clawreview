# Security Policy

## Supported versions

Only the latest minor release of ClawReview receives security fixes during the pre-alpha period.

## Reporting a vulnerability

Please email security@clawreview.dev with:

- A description of the issue and its impact
- Steps to reproduce or a proof of concept
- Affected versions and components
- Any suggested remediation

You can expect:

- Acknowledgement within 2 business days
- A triage decision within 5 business days
- Coordinated disclosure once a fix is available, typically within 30 days for high severity issues

Please do not file public GitHub issues for security reports. Do not test against installations you do not own.

## Scope

In scope:

- The webhook receiver in `apps/server`
- The dashboard in `apps/dashboard`
- The CLI in `apps/cli`
- Any package under `packages/`

Out of scope:

- Third-party LLM providers we proxy to
- Self-hosted deployments not maintained by the ClawReview team
- Social engineering of maintainers

## Hardening notes

- Webhook signatures are verified before any work is queued
- All env vars are validated at boot
- Secrets never leave the worker process
- Dashboard sessions use HttpOnly, Secure, SameSite=Lax cookies
- Audit log entries are append-only at the application layer
