# Contributing

Thanks for taking the time. The project is small enough that there is no formal RFC process yet, but a few ground rules keep the codebase from drifting.

## Local setup

Requires Node 20+ and pnpm 10. Postgres and Redis are optional for the CLI path.

```
pnpm install
pnpm build
pnpm test
```

The CLI is the fastest dogfood loop:

```
pnpm cli -- run --base main --head HEAD
```

## Branching

- `main` is always shippable.
- Feature work goes on `feat/<short-name>` branches.
- Bug fixes go on `fix/<short-name>` branches.
- Rebase before opening a PR. Merge commits are squashed on land.

## Commit style

Conventional commits, no AI-style sectioned headings (no "## How" or "## Tests" blocks). Imperative mood, present tense.

```
feat(server): retry GitHub installation token fetch
fix(diff): handle CRLF in renamed files
chore(deps): bump prisma to 5.22
```

## Tests

Add a vitest test next to anything in `packages/` you touch. Server and CLI changes need at least one integration-level test in their own `tests/` folder. Dashboard changes should not regress the Playwright smoke suite.

## Code review

Every PR runs through ClawReview itself once the GitHub App is enabled. Treat findings the same as a human comment: respond, dismiss with a reason, or fix.

## Release

We use changesets. Run `pnpm changeset` and describe user-visible changes. `release.yml` publishes once the version PR lands.
