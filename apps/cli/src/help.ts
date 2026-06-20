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
  --format <fmt>     Output format: text (default), json, sarif, junit, csv, gitlab, markdown, rdjsonl.
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
  clawreview run --format rdjsonl | reviewdog -f rdjsonl -reporter=github-pr-review
  clawreview validate --config examples/strict.clawreview.yml
  clawreview run --format json | clawreview stats --fail-on high
  clawreview run --format json > report.json && clawreview baseline save --input report.json
  clawreview run --format json | clawreview baseline diff --fail-on-new
`;
}
/bin/bash: line 4: /var/folders/9g/q9vh1btn7wqdzh95619wmlh80000gn/T/hermes-snap-9e73823f4ad6.sh: No space left on device
/bin/bash: line 5: /var/folders/9g/q9vh1btn7wqdzh95619wmlh80000gn/T/hermes-cwd-9e73823f4ad6.txt: No space left on device
/bin/bash: line 4: /var/folders/9g/q9vh1btn7wqdzh95619wmlh80000gn/T/hermes-snap-9e73823f4ad6.sh: No space left on device
/bin/bash: line 5: /var/folders/9g/q9vh1btn7wqdzh95619wmlh80000gn/T/hermes-cwd-9e73823f4ad6.txt: No space left on device
