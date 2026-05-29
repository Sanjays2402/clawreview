# Webhook security

We compute HMAC-SHA256 of the raw request body using the GitHub App webhook
secret and compare it to the X-Hub-Signature-256 header in constant time.
Requests without a valid signature are rejected with 401 before any work is
queued. In production we additionally require the secret to be configured: if
GITHUB_WEBHOOK_SECRET is empty we return 503 rather than silently allowing
unsigned webhooks.
