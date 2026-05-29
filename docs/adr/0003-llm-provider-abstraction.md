# 0003 - OpenAI-compatible provider abstraction

## Status

Accepted, 2026-05-29.

## Context

We expect to talk to many model endpoints: a local Hermes agent, a
github-copilot proxy, OpenAI itself, and on-prem deployments. Coupling the
agents to one SDK locks us out of self-hosting.

## Decision

`packages/llm` exposes a small `LLMProvider` interface with one method
(`chat`). A registry resolves model ids prefixed with `hermes/` or
`copilot/` to the right base URL. Everything else falls back to a generic
OpenAI-compatible call. Retries, rate limits, and JSON recovery live in the
provider so agents never see a 429.

## Consequences

- Switching to a new endpoint is one config change, not a code change.
- We do not support streaming yet. Reviews are not interactive; the latency
  win from streaming is small and the parsing cost of JSON-mid-stream is
  high. Revisit if interactive review chat becomes a product.
