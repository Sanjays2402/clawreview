# lua review notes

## Things to flag

- Unbounded recursion or unbounded loops over user input.
- Synchronous IO inside a request-handling hot path.
- Missing input validation at trust boundaries.

## Things not to flag

- Stylistic preferences the language formatter handles.
- Issues the diff itself resolves.
