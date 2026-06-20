export function renderHelp(): string {
  return `clawreview - multi-agent code review

Usage:
  clawreview run [--base <ref>] [--head <ref>] [--config <path>] [--format text|json]
  clawreview validate [--config <path>]
  clawreview stats [--input <path>] [--fail-on critical|high|medium|low|nit]
  clawreview baseline save [--input <path>] [--output <path>]
  clawreview baseline diff [--input <path>] [--baseline <path>] [--fail-on-new]
  clawreview version

Flags:
  --base <ref>       Git base ref. Defaults to origin/main if reachable, otherwise main.
  --head <ref>       Git head ref. Defaults to HEAD.
  --config <path>    Path to a .clawreview.yml. Defaults to ./.clawreview.yml.
  --format <fmt>     Output format: text (default), json, sarif, junit, csv, gitlab, markdown.
  --threshold <sev>  Override severity threshold: critical|high|medium|low|nit.
  --concurrency <n>  Max parallel (chunk x agent) tasks.
  --no-color         Disable colored output.

Environment:
  LLM_BASE_URL       OpenAI-compatible endpoint base, default http://127.0.0.1:8642/v1.
  LLM_API_KEY        Optional bearer token for the endpoint.
  LLM_DEFAULT_MODEL  Default model id, default hermes/claude-opus-4.

Examples:
  clawreview run --base main --head HEAD
  clawreview run --config .clawreview.yml --format json
  clawreview run --format markdown > review.md
  clawreview run --format gitlab > gl-code-quality-report.json
  clawreview validate --config examples/strict.clawreview.yml
  clawreview run --format json | clawreview stats --fail-on high
  clawreview run --format json > report.json && clawreview baseline save --input report.json
  clawreview run --format json | clawreview baseline diff --fail-on-new
`;
}
