export function renderHelp(): string {
  return `clawreview - multi-agent code review

Usage:
  clawreview run [--base <ref>] [--head <ref>] [--config <path>] [--format text|json]
  clawreview validate [--config <path>]
  clawreview lint-config [--root <dir>] [--pattern <name>[,<name>...]] [--format text|json] [--fix]
  clawreview presets list [--root <dir>] [--format text|json]
  clawreview stats [--input <path>] [--fail-on critical|high|medium|low|nit] [--by severity|agent|category] [--format text|json]
  clawreview baseline save [--input <path>] [--output <path>]
  clawreview baseline diff [--input <path>] [--baseline <path>] [--fail-on-new]
  clawreview diff-stats [--base <ref>] [--head <ref>] [--input <path>] [--diff -] [--format text|json]
  clawreview explain <fingerprint> [--input <report.json>]
  clawreview authors [--input <report.json>] [--ref <ref>] [--format text|json] [--top <n>]
  clawreview version

Flags:
  --base <ref>       Git base ref. Defaults to origin/main if reachable, otherwise main.
  --head <ref>       Git head ref. Defaults to HEAD.
  --config <path>    Path to a .clawreview.yml. Defaults to ./.clawreview.yml.
  --format <fmt>     Output format: text (default), json, sarif, junit, csv, gitlab, markdown, rdjsonl.
  --threshold <sev>  Override severity threshold: critical|high|medium|low|nit.
  --concurrency <n>  Max parallel (chunk x agent) tasks.
  --input <path>     Read a previously-generated JSON report from a file (stats / explain).
  --no-color         Disable colored output.
  --fail-on-budget   Exit non-zero (3) when 'clawreview run' estimates the review will
                     exceed the configured monthly budget. Off by default; the estimate
                     is still printed to stderr either way.
  --root <dir>       lint-config / presets list: root directory to scan (default: cwd).
  --pattern <name>   lint-config: filenames to match (default: .clawreview.yml). Comma-separated
                     for multiple, e.g. --pattern .clawreview.yml,clawreview.config.yml.
  --by <axis>        stats: primary grouping axis: severity (default), agent, or category.

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
  clawreview lint-config --root . --pattern .clawreview.yml
  clawreview lint-config --format json | jq '.invalid'
  clawreview lint-config --fix
  clawreview lint-config --fix --format json | jq '.fixed'
  clawreview presets list
  clawreview presets list --format json | jq '.presets[] | select(.source=="local")'
  clawreview run --format json | clawreview stats --fail-on high
  clawreview run --format json | clawreview stats --by agent
  clawreview run --format json | clawreview stats --format json --by category | jq '.byCategory'
  clawreview run --format json > report.json && clawreview baseline save --input report.json
  clawreview run --format json | clawreview baseline diff --fail-on-new
  clawreview diff-stats --base main --head HEAD
  clawreview diff-stats --format json | jq '.totals'
  git diff main...HEAD | clawreview diff-stats --diff -
  clawreview run --format json > report.json && clawreview explain 9d3c4f --input report.json
  clawreview run --format json | clawreview authors --top 5
`;
}
