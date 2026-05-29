# Clearing a webhook backlog

If the worker has been down and BullMQ has accumulated work:

1. Scale workers up temporarily by increasing `REVIEW_CONCURRENCY` and adding replicas.
2. Monitor `/healthz` and pull p95 latency from your tracing backend.
3. Once depth returns to normal, scale back.

If the backlog is older than 24 hours, consider purging stale jobs: most PR events are stale by then.
