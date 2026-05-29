#!/usr/bin/env node
import { runCli } from './cli.js';

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
