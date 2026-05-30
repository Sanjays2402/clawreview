import { parseArgs } from './args.js';
import { runReview } from './commands/run.js';
import { runStats } from './commands/stats.js';
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
    case 'stats':
      await runStats(args);
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
