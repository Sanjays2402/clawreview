# Investigating a cost spike

A cost spike usually means a runaway monorepo or a prompt regression.

1. Open the dashboard, sort installations by spent.
2. Drill into the noisiest repo, look at recent reviews.
3. If a single PR is generating thousands of tokens per agent, lower `max_findings_per_file` and raise `severity_threshold` for that repo.
4. If a prompt regressed, roll back the prompt change and tag a hotfix.
