# Architecture

See docs/overview.md for the high-level picture, docs/agents.md for the agent
contract, and docs/data-model.md for the Prisma schema.

The short version: every review flows through one pipeline. The pipeline lives
in @clawreview/agents and runs whether the trigger is a GitHub webhook, the
CLI, or a manual re-run.
