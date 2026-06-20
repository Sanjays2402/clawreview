import { readFile } from 'node:fs/promises';
import { cwd as getCwd } from 'node:process';

import YAML from 'yaml';
import { ClawReviewConfigSchema, listPresets } from '@clawreview/types';

import type { ParsedArgs } from '../args.js';
import { mergeWithExtends } from '../config.js';

export async function runValidate(args: ParsedArgs): Promise<void> {
  const path = String(args.flags.config ?? '.clawreview.yml');
  const target = path.startsWith('/') ? path : `${getCwd()}/${path}`;
  const raw = await readFile(target, 'utf8');
  const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
  // Resolve `extends:` to the same merged shape `loadConfig` would feed
  // the pipeline. This way `clawreview validate` proves the *effective*
  // config will pass schema validation, not just the literal file.
  let withExtends: Record<string, unknown>;
  try {
    withExtends = mergeWithExtends(parsed);
  } catch (err) {
    console.error(`Config invalid: ${path}`);
    console.error(`  ${(err as Error).message}`);
    console.error(`  available presets: ${listPresets().join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const result = ClawReviewConfigSchema.safeParse(withExtends);
  if (!result.success) {
    console.error(`Config invalid: ${path}`);
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    process.exitCode = 2;
    return;
  }
  console.log(`Config OK: ${path}`);
  if (parsed.extends !== undefined) {
    const names = Array.isArray(parsed.extends)
      ? (parsed.extends as unknown[]).map(String)
      : [String(parsed.extends)];
    console.log(`  extends:   ${names.join(', ')}`);
  }
  console.log(`  agents:    ${result.data.agents.join(', ')}`);
  console.log(`  threshold: ${result.data.severity_threshold}`);
  console.log(`  budget:    $${result.data.budget.monthly_usd}/mo`);
}
