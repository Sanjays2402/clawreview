export function renderHelp(): string {
  return `clawreview - multi-agent code review

Usage:
  clawreview run [--base <ref>] [--head <ref>] [--config <path>] [--format text|json]
  clawreview validate [--config <path>]
  clawreview version

Flags:
  --base <ref>       Git base ref. Defaults to origin/main if reachable, otherwise main.
  --head <ref>       Git head ref. Defaults to HEAD.
  --config <path>    Path to a .clawreview.yml. Defaults to ./.clawreview.yml.
  --format <fmt>     Output format: text (default), json, sarif.
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
  clawreview validate --config examples/strict.clawreview.yml
`;
}
