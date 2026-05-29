# LLM endpoint outage

When the configured LLM endpoint is failing:

1. Confirm with `curl $LLM_BASE_URL/models`.
2. Failover by setting `LLM_OPENAI_BASE_URL` to a different OpenAI-compatible endpoint and bouncing the workers.
3. Re-queue impacted reviews from the dashboard.
