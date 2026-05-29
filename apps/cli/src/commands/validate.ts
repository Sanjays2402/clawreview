import { readFile } from 'node:fs/promises';
import { cwd as getCwd } from 'node:process';

import YAML from 'yaml';
import { ClawReviewConfigSchema } from '@clawreview/types';

import type { ParsedArgs } from '../args.js';

export async function runValidate(args: ParsedArgs): Promise<void> {
  const path = String(args.flags.config ?? '.clawreview.yml');
  const target = path.startsWith('/') ? path : `${getCwd()}/${path}`;
  const raw = await readFile(target, 'utf8');
  const parsed = YAML.parse(raw);
  const result = ClawReviewConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.error(`Config invalid: ${path}`);
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    process.exitCode = 2;
    return;
  }
  console.log(`Config OK: ${path}`);
  console.log(`  agents: ${result.data.agents.join(', ')}`);
  console.log(`  threshold: ${result.data.severity_threshold}`);
  console.log(`  budget: $${result.data.budget.monthly_usd}/mo`);
}
