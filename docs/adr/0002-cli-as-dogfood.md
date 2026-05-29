# 0002 - Local-first CLI dogfood path

## Status

Accepted, 2026-05-29.

## Context

Onboarding a GitHub App on every test PR is too slow and too leaky for
iteration. Maintainers need to run the pipeline against a private branch
without registering anything.

## Decision

The CLI runs the exact same pipeline code that the server worker runs,
against a git diff produced locally. It takes a local config file, talks to
a local OpenAI-compatible endpoint by default, and prints a colored report.

## Consequences

- The pipeline must work without GitHub, without a database, and without a
  queue. Side effects are pushed to callers.
- The same aggregator output is rendered as Markdown for GitHub and as a
  colored terminal report for the CLI. The aggregator is the single source
  of truth.
- Pricing model: self-hosters can ignore the dashboard and run from the CLI
  alone. That is fine and intentional.
