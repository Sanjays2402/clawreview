export function renderHelp(): string {
  return `clawreview - multi-agent code review

Usage:
  clawreview run [--base <ref>] [--head <ref>] [--config <path>] [--format text|json]
  clawreview validate [--config <path>]
  clawreview lint-config [--root <dir>] [--pattern <name>[,<name>...]] [--format text|json] [--fix]
  clawreview presets list [--root <dir>] [--format text|json]
  clawreview presets show <name> [--root <dir>] [--format yaml|json|text]
  clawreview presets resolve <chain> [--root <dir>] [--format yaml|json|text] [--since <git-ref> | --since-base <git-ref>] [--output <path>|-]
  clawreview presets diff <a> <b> [--root <dir>] [--format text|yaml|json] [--only-fields <a,b,c> | --exclude-fields <a,b,c>] [--output <path>|-] [--max-output-bytes <n>] [--since <git-ref>] [--since-base <ref>] [--since-target <ref>] [--since-range <a>..<b>|<a>...<b>]
  clawreview presets diff --base <a> --target <b> [...same flags as positional form]
  clawreview stats [--input <path>] [--fail-on critical|high|medium|low|nit] [--by severity|agent|category|file] [--top-files <n>] [--top-agents <n>] [--top-categories <n>] [--min-confidence <n>] [--severity-threshold <sev>] [--filter-summary] [--json-header] [--jsonl] [--no-footer] [--format text|json]
  clawreview review drift [--input <path>] [--min-confidence <n>] [--severity-threshold <sev>] [--format text|json]
  clawreview review drift --base <reviewId> --target <reviewId> --server <url> [--min-confidence <n>] [--severity-threshold <sev>] [--on-regression <cmd> | --on-regression-template slack|webhook] [--format text|json]
  clawreview review drift --watch <reviewId> --server <url> [--interval <ms>] [--max-polls <n>] [--format text|json] [--on-drift <cmd> | --on-drift-template slack|webhook] [--on-drift-once] [--on-recover <cmd> | --on-recover-template slack|webhook]
  clawreview review filter-report <reviewId> --server <url> [--format text|json] [--slim] [--require-filter]
  clawreview review filter-report --watch <reviewId> --server <url> [--interval <ms>] [--max-polls <n>] [--format text|json] [--slim] [--require-filter]
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
  --by <axis>        stats: primary grouping axis: severity (default), agent, category, or file.
  --top-files <n>    stats: cap on the top-files block / topFiles JSON array (default 5, max 200).
  --top-agents <n>   stats: cap on the --by agent block / topAgents JSON array (default 10, max 200).
  --top-categories <n> stats: cap on the --by category block / topCategories JSON array (default 10, max 200).
  --min-confidence <n>  stats: drop findings below this confidence (0..1) BEFORE counting. Mirror of
                        the worker's cfg.min_confidence -- preview what a floor would change.
  --severity-threshold <sev>
                        stats: drop findings less severe than <sev> BEFORE counting (critical|high|
                        medium|low|nit). Mirror of cfg.severity_threshold -- composes with
                        --min-confidence (AND semantics).
  --filter-summary   stats: text-mode only. Print a one-line header showing which filter(s)
                     applied and how many findings were dropped. Off by default; the JSON output's
                     tick-20 filter echoes already serve the same use case for machine consumers.
                     Pair with --json-header (tick 22) to ALSO emit a one-line JSON envelope on
                     stdout before the multi-line JSON report body (JSON mode only) so a CI
                     pipeline can 'head -1 | jq' to short-circuit without parsing the whole report.
                     Pair with --json-header AND --jsonl (tick 23) to STREAM the report as
                     line-delimited JSON (one header + one line per severity + one footer) so a
                     log-aggregator pipeline can ingest each line independently.

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
  clawreview presets show strict
  clawreview presets show web-strict --format yaml >> .clawreview.yml
  clawreview presets resolve strict,security-focused
  clawreview presets resolve strict,security-focused --format json | jq '.fields'
  clawreview presets resolve web-strict --since v2.4    # what did web-strict compose at v2.4?
  clawreview presets diff strict permissive
  clawreview presets diff strict,security-focused web --format json | jq '.changed'
  clawreview presets diff strict permissive --only-fields severity_threshold,min_confidence
  clawreview presets diff strict permissive --format json --output - | jq '.changed'
  clawreview presets diff --base strict --target permissive --format json | jq '.changed'
  clawreview presets diff web-strict web-strict --since HEAD~5   # diff one local preset across 5 commits
  clawreview presets diff web web --since-range HEAD~5..HEAD     # range sugar: split into base+target
  clawreview presets diff web web --since-range HEAD~5..          # HEAD-shorthand: target resolves to HEAD
  clawreview run --format json | clawreview stats --fail-on high
  clawreview run --format json | clawreview stats --by agent
  clawreview run --format json | clawreview stats --by agent --top-agents 3
  clawreview run --format json | clawreview stats --by category --top-categories 5
  clawreview run --format json | clawreview stats --by file --top-files 10
  clawreview run --format json | clawreview stats --format json --by category | jq '.byCategory'
  clawreview run --format json | clawreview stats --min-confidence 0.7        # preview a high-confidence-only report
  clawreview run --format json | clawreview stats --severity-threshold medium # drop nit/low BEFORE counting
  clawreview run --format json | clawreview stats --min-confidence 0.6 --severity-threshold high --fail-on high
  clawreview run --format json > report.json && clawreview baseline save --input report.json
  clawreview run --format json | clawreview baseline diff --fail-on-new
  clawreview diff-stats --base main --head HEAD
  clawreview diff-stats --format json | jq '.totals'
  git diff main...HEAD | clawreview diff-stats --diff -
  clawreview run --format json > report.json && clawreview explain 9d3c4f --input report.json
  clawreview run --format json | clawreview authors --top 5
  curl -s https://clawreview/api/reviews/abc123/digest | clawreview review drift
  curl -s https://clawreview/api/reviews/abc123 | clawreview review drift --format json | jq '.drift.hasDrift'
  curl -s https://clawreview/api/reviews/abc123 | clawreview review drift --min-confidence 0.7  # preview "would drift change if we tighten the floor?"
  clawreview review filter-report rv_42_abc --server https://clawreview                       # render persisted filter report for review rv_42_abc
  clawreview review filter-report rv_42_abc --server https://clawreview --format json --slim   # slim JSON for a CI gate that only needs the applied bit
`;
}
