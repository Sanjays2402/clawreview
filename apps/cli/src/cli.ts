import { parseArgs } from './args.js';
import { runReview } from './commands/run.js';
import { runStats } from './commands/stats.js';
import { runBaseline } from './commands/baseline.js';
import { runDiffStats } from './commands/diff-stats.js';
import { runExplain } from './commands/explain.js';
import { runAuthors } from './commands/authors.js';
import { runLintConfig } from './commands/lint-config.js';
import { runPresetsList } from './commands/presets.js';
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
      // Single sub-command for now: `presets list`. Future could add
      // `presets show <name>` or `presets resolve <name>` -- the
      // dispatch shape is ready.
      if ((args.positional[0] ?? 'list') === 'list') {
        await runPresetsList(args);
        return;
      }
      console.error(`Unknown presets sub-command: ${args.positional[0]}\n`);
      console.log(renderHelp());
      process.exitCode = 1;
      return;
    case 'stats':
      await runStats(args);
      return;
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
