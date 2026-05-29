import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('language rules sheets', () => {
  const dir = join(__dirname, '..', 'src', 'language-rules');
  const files = readdirSync(dir);
  it.each(files)('%s starts with a heading', (f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    expect(text.startsWith('# ')).toBe(true);
  });
});
