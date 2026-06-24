/**
 * Tick 28: shared default / ceiling constants for `--output` size caps
 * across all `clawreview ... diff` commands.
 *
 * Before tick 28 these were two pairs of identical literals duplicated
 * inside `apps/cli/src/commands/presets.ts`
 * (PRESET_DIFF_DEFAULT_MAX_OUTPUT_BYTES, PRESET_DIFF_MAX_OUTPUT_BYTES_CEILING)
 * and `apps/cli/src/commands/review.ts`
 * (FILTER_REPORT_DIFF_DEFAULT_MAX_OUTPUT_BYTES,
 *  FILTER_REPORT_DIFF_MAX_OUTPUT_BYTES_CEILING).
 *
 * That worked, but it bakes in a footgun: a future bump to the
 * default (say, from 100 KiB to 256 KiB because preset bodies started
 * carrying language-rules JSON inline) has to land in BOTH files at
 * once, with no compiler help if the second site is missed. The two
 * caps would drift silently and `clawreview presets diff` /
 * `clawreview review filter-report --diff` would behave inconsistently
 * for the same operator-typed flag value.
 *
 * Promoting both literals to a single shared module gives:
 *   - one canonical source of truth for the default + ceiling,
 *   - a single line to bump in tick N+1 when the limits change,
 *   - a single test seam pinning the two constants against drift.
 *
 * The original constants in presets.ts / review.ts are re-exported
 * (now as `=` aliases) so existing imports keep working byte-
 * identically. The tests still pass against the same numeric values.
 *
 * Why a dedicated module instead of a 'shared' / 'util' bucket: the
 * limits are a cohesive concept (the size-cap parser uses both
 * together) and a future addition (e.g. a per-format default override
 * so YAML can carry more raw text than JSON) lands cleanly in the
 * same module without confusing a 'util' grab bag.
 */

/**
 * Default size cap for `--output` / `--output -` writes when the
 * caller doesn't pass `--max-output-bytes` explicitly.
 *
 * 100 KiB is chosen as a generous-but-bounded ceiling:
 *   - a real-world preset diff fits in a few hundred bytes;
 *   - a multi-kilobyte diff is plausible for a deeply-customised
 *     local preset stack;
 *   - a megabyte-scale diff almost always indicates a runaway
 *     extends chain (preset) OR a misaligned worker bucket count
 *     (filter-report).
 *
 * Catching that BEFORE it lands on a pipe (where the downstream
 * consumer is usually `jq` or `mail`) saves the on-call from a
 * 30-second wait followed by a "what is this?" stack trace.
 *
 * Exported so test fixtures + integrations can reference the same
 * literal without re-deriving it.
 */
export const DIFF_DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024;

/**
 * Hard ceiling on `--max-output-bytes`. Even an explicit caller
 * cannot ask for an unbounded write -- a 100 MiB diff was never the
 * intended use case for any of these commands, and an accidentally-
 * typed `--max-output-bytes 100000000000` shouldn't allocate a
 * gigabyte-scale buffer either.
 *
 * 16 MiB is a sanity ceiling that's still 160x the default; anything
 * genuinely larger should be produced via the underlying read
 * commands (`clawreview presets show <chain> --format yaml` /
 * `clawreview review filter-report <id> --format json`) and a
 * manual `diff(1)` rather than through these wrappers.
 */
export const DIFF_MAX_OUTPUT_BYTES_CEILING = 16 * 1024 * 1024;
