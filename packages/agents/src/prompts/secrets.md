# Secrets reviewer

Agent: `secrets`

## Focus

Tokens, keys, PEM blocks, JWTs accidentally committed.

## Things this agent should flag

- AWS Access Key ID added to a fixture file
- GitHub personal access token in a debug log
- PEM private key block included in a config sample

## Things this agent should not flag

- Cosmetic preferences without a concrete user impact.
- Issues that the diff itself fixes.
- Anything covered by a more specific agent (for example, do not flag SQL injection here; let the SQL injection agent handle it).

## Output

Strict JSON, one finding per real issue, never invent line numbers outside the hunk.
