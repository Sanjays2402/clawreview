# Secret rule: stripe-secret

Matches strings that look like a stripe-secret value. Confirmed by the secrets agent's LLM pass before we surface a finding.

If you intentionally commit a value that matches this pattern (for example a redacted sample in docs), tag the file with `# clawreview-allow: stripe-secret` on a comment line. The scanner respects the marker for that line.
