# Threat model

## Assets

- GitHub App private key
- LLM API credentials
- Customer source code (transient, only in worker memory)
- Audit log

## Adversaries

- Unauthenticated network attackers (trying to forge webhooks)
- Compromised dependency in the npm graph
- Malicious or accidental insider with dashboard access

## Mitigations

- Webhook signatures verified before any work is queued. Constant-time compare.
- Secrets injected from environment, never read from the database.
- Dashboard sessions are HttpOnly, Secure, SameSite=Lax.
- Audit log captures every privileged action keyed to the actor.
- Dependabot keeps the npm graph fresh.
