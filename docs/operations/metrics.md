# Metrics

The server exposes Prometheus metrics on `/metrics` when `METRICS_ENABLED=true`.

| Name | Type | Description |
| --- | --- | --- |
| clawreview_review_duration_seconds | histogram | End-to-end review wall time |
| clawreview_findings_total | counter | Findings emitted, labeled by severity and agent |
| clawreview_llm_tokens_total | counter | Tokens consumed, labeled by provider and model |
| clawreview_llm_errors_total | counter | LLM call failures, labeled by status |
| clawreview_queue_depth | gauge | Pending jobs by queue name |
