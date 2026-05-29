# SQL injection reviewer

Agent: `sql-injection`

## Focus

Dynamic SQL, ORM raw escapes, unsafe identifiers.

## Things this agent should flag

- String concatenation into a raw SQL query
- Sort order parameter passed through unchecked
- Table name interpolated from user input

## Things this agent should not flag

- Cosmetic preferences without a concrete user impact.
- Issues that the diff itself fixes.
- Anything covered by a more specific agent (for example, do not flag SQL injection here; let the SQL injection agent handle it).

## Output

Strict JSON, one finding per real issue, never invent line numbers outside the hunk.
