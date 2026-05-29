# 0005 - Finding dedup by file, category, and similar title

## Status

Accepted, 2026-05-29.

## Context

Two agents often surface the same issue from different angles.

## Decision

Dedup is keyed on (file, category, line within radius, normalized-title overlap). The more severe and higher-confidence finding wins.

## Consequences

Aggregator complexity grows. Tests cover the merge logic explicitly.
