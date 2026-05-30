import { describe, expect, it } from 'vitest';

import { shouldSkipAuthor } from '../src/routes/webhooks.js';

describe('shouldSkipAuthor', () => {
  it('skips bot accounts by default', () => {
    const r = shouldSkipAuthor('dependabot[bot]', { allowBots: false, skipAuthors: new Set() });
    expect(r).toEqual({ skip: true, reason: 'bot' });
  });

  it('allows bot accounts when REVIEW_BOT_PRS is true', () => {
    const r = shouldSkipAuthor('renovate[bot]', { allowBots: true, skipAuthors: new Set() });
    expect(r).toEqual({ skip: false });
  });

  it('skips explicitly listed authors regardless of bot status', () => {
    const r = shouldSkipAuthor('Vendor-CI', {
      allowBots: true,
      skipAuthors: new Set(['vendor-ci']),
    });
    expect(r).toEqual({ skip: true, reason: 'author' });
  });

  it('passes through normal human authors', () => {
    const r = shouldSkipAuthor('sanjay', { allowBots: false, skipAuthors: new Set(['mallory']) });
    expect(r).toEqual({ skip: false });
  });

  it('treats missing login as not-skip (preserves prior behavior)', () => {
    const r = shouldSkipAuthor(undefined, { allowBots: false, skipAuthors: new Set() });
    expect(r).toEqual({ skip: false });
  });
});
