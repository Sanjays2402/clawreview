import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import YAML from 'yaml';
import { ClawReviewConfigSchema, DEFAULT_CONFIG, type ClawReviewConfig } from '@clawreview/types';

export async function loadConfig(path: string | undefined, cwd: string): Promise<ClawReviewConfig> {
  const target = resolve(cwd, path ?? '.clawreview.yml');
  try {
    const raw = await readFile(target, 'utf8');
    const parsed = YAML.parse(raw);
    return ClawReviewConfigSchema.parse(parsed ?? {});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_CONFIG;
    }
    throw err;
  }
}
