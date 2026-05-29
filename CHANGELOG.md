# Changelog

All notable changes to ClawReview are documented in this file. Format follows Keep a Changelog and the project uses Semantic Versioning.

## [Unreleased]

### Added

- Aggregator snapshot tests against a known finding set

- Initial monorepo layout with apps for server, dashboard, and CLI
- Reviewer agents for security, performance, style, accessibility, sql-injection, and secrets
- Aggregator with severity ranking and per-file grouping
- Prisma data model covering installations, repos, pull requests, reviews, findings, runs, and agent executions
- BullMQ queue adapter with in-memory fallback for local development
- GitHub App webhook handler with HMAC signature verification
- Dashboard landing page, installations list, review detail view, and audit log viewer
- CLI `run` command for local pipelines against any git diff
- Helm chart and Terraform skeleton for AWS ECS Fargate deploy
- Docker Compose stack for Postgres, Redis, server, and dashboard
