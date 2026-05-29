# 0008 - Three roles: admin, member, viewer

## Status

Accepted, 2026-05-29.

## Context

Permissions need to be obvious in the UI.

## Decision

Admins manage installs and rotate keys. Members dismiss findings. Viewers read.

## Consequences

No per-finding ACLs. Audit log carries the actor.
