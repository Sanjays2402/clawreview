# 0001 - Multi-agent review with a single aggregator

## Status

Accepted, 2026-05-29.

## Context

Single-model reviewers either drown PRs in nits or miss the one critical
issue that mattered. A focused prompt on a focused diff chunk consistently
outperforms a kitchen-sink reviewer, but five focused prompts each posting a
comment defeats the purpose.

## Decision

We split the review across N specialist agents that produce structured
findings, then run a deterministic aggregator that merges, dedupes, and
ranks findings before exactly one comment is posted to the PR.

## Consequences

- Each agent can be tuned in isolation. Prompts can change without affecting
  the merge logic.
- The aggregator becomes the single source of truth for severity ordering
  and threshold filtering. It is heavily tested.
- Agents that produce overlapping findings (security vs. sql-injection) need
  predictable dedup. The aggregator handles that with a shared dedup
  function instead of asking agents to coordinate.
