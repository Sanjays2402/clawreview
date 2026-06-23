import { parseArgs } from './args.js';
import { runReview } from './commands/run.js';
import { runStats } from './commands/stats.js';
import { runBaseline } from './commands/baseline.js';
import { runDiffStats } from './commands/diff-stats.js';
import { runExplain } from './commands/explain.js';
import { runAuthors } from './commands/authors.js';
import { runLintConfig } from './commands/lint-config.js';
import { runPresetsDiff, runPresetsList, runPresetsResolve, runPresetsShow } from './commands/presets.js';
import { runReviewDrift, runReviewFilterReport } from './commands/review.js';
import { runValidate } from './commands/validate.js';
import { renderHelp } from './help.js';

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  switch (args.command) {
    case '':
    case 'help':
    case '--help':
    case '-h':
      console.log(renderHelp());
      return;
    case 'run':
      await runReview(args);
      return;
    case 'validate':
      await runValidate(args);
      return;
    case 'lint-config':
      await runLintConfig(args);
      return;
    case 'presets':
      // Sub-commands: `presets list` (default), `presets show <name>`,
      // `presets resolve <chain>`, and `presets diff <a> <b>`. All four
      // share the local-presets resolver and the built-in registry so
      // what each renders is what loadConfig would actually compose.
      {
        const sub = args.positional[0] ?? 'list';
        if (sub === 'list') {
          await runPresetsList(args);
          return;
        }
        if (sub === 'show') {
          await runPresetsShow(args);
          return;
        }
        if (sub === 'resolve') {
          await runPresetsResolve(args);
          return;
        }
        if (sub === 'diff') {
          await runPresetsDiff(args);
          return;
        }
        console.error(`Unknown presets sub-command: ${sub}\n`);
        console.log(renderHelp());
        process.exitCode = 1;
        return;
      }
    case 'stats':
      await runStats(args);
      return;
    case 'review':
      // Sub-commands: today `review drift` (single-shot / watch / compare)
      // and tick-23's `review filter-report` (single-shot fetch of the
      // persisted filter report). The dispatcher matches the presets
      // pattern so adding `review show <id>` later is a one-line addition.
      {
        const sub = args.positional[0] ?? '';
        if (sub === 'drift') {
          await runReviewDrift(args);
          return;
        }
        if (sub === 'filter-report') {
          await runReviewFilterReport(args);
          return;
        }
        console.error(`Unknown review sub-command: ${sub || '(none)'}\n`);
        console.log(renderHelp());
        process.exitCode = 1;
        return;
      }
    case 'baseline':
      await runBaseline(args);
      return;
    case 'diff-stats':
      await runDiffStats(args);
      return;
    case 'explain':
      await runExplain(args);
      return;
    case 'authors':
      await runAuthors(args);
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log('clawreview 0.1.0');
      return;
    default:
      console.error(`Unknown command: ${args.command}\n`);
      console.log(renderHelp());
      process.exitCode = 1;
  }
}
