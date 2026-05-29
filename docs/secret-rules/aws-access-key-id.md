# Secret rule: aws-access-key-id

Matches strings that look like a aws-access-key-id value. Confirmed by the secrets agent's LLM pass before we surface a finding.

If you intentionally commit a value that matches this pattern (for example a redacted sample in docs), tag the file with `# clawreview-allow: aws-access-key-id` on a comment line. The scanner respects the marker for that line.
