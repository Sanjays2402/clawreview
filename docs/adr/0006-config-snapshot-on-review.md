# 0006 - Snapshot .clawreview.yml on every review

## Status

Accepted, 2026-05-29.

## Context

Re-running a review later should produce the same agents and threshold even if the config changed.

## Decision

Review rows persist the parsed config JSON.

## Consequences

Extra storage per review. Worth it for reproducibility.
