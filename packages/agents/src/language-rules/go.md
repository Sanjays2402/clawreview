# Go review notes

## Things to flag

- Unbounded recursion or unbounded loops over user input.
- Synchronous IO inside a request-handling hot path.
- Missing input validation at trust boundaries.
- Hard-coded credentials or endpoints that look like production.

## Things not to flag

- Stylistic preferences that the language formatter handles.
- Issues that the diff itself resolves.
- Patterns that are idiomatic in this language even if they look odd elsewhere.
