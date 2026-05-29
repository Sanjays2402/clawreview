import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('parses command, positional, and value flags', () => {
    const r = parseArgs(['run', '--base', 'main', '--head', 'HEAD', 'extra']);
    expect(r.command).toBe('run');
    expect(r.flags).toEqual({ base: 'main', head: 'HEAD' });
    expect(r.positional).toEqual(['extra']);
  });

  it('supports --key=value', () => {
    const r = parseArgs(['run', '--format=json']);
    expect(r.flags.format).toBe('json');
  });

  it('treats lone --flag as boolean true', () => {
    const r = parseArgs(['run', '--no-color']);
    expect(r.flags['no-color']).toBe(true);
  });
});
