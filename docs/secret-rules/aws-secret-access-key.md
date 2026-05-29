# Secret rule: aws-secret-access-key

Matches strings that look like a aws-secret-access-key value. Confirmed by the secrets agent's LLM pass before we surface a finding.

If you intentionally commit a value that matches this pattern (for example a redacted sample in docs), tag the file with `# clawreview-allow: aws-secret-access-key` on a comment line. The scanner respects the marker for that line.
