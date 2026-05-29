# Release process

1. Open a release PR using `pnpm changeset version`.
2. Land the PR after CI is green (note: CI is gated behind the `ENABLE_CI` repo variable).
3. Run `pnpm changeset publish` from your laptop or let `release.yml` do it.
4. Tag the release in GitHub.
5. Update the dashboard `/changelog` page.
