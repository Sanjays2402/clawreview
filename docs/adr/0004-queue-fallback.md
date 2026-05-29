# 0004 - In-memory queue fallback

## Status

Accepted, 2026-05-29.

## Context

Self-hosters without Redis still need to run the worker. Forcing Redis in development is friction.

## Decision

Ship an in-memory adapter that implements the same QueueAdapter interface. The factory picks BullMQ when REDIS_URL is set, in-memory otherwise.

## Consequences

Dev loop is faster. Production must set REDIS_URL or accept that restarts drop in-flight jobs.
