# 0007 - No streaming responses from LLMs yet

## Status

Accepted, 2026-05-29.

## Context

Reviews are not interactive.

## Decision

Accept the higher latency from waiting for full JSON. Revisit if interactive review chat becomes a product.

## Consequences

Simpler parsing, easier retries, slightly higher latency per agent.
