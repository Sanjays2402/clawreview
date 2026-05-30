import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { aggregate } from '../src/aggregate.js';
import { renderPrComment } from '../src/comment.js';

describe('comment rendering against fixture findings', () => {
  it('renders a Markdown comment with severity headers and per-file sections', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'sample-findings.json'), 'utf8'));
    const result = aggregate(raw.findings);
    const md = renderPrComment(result, { prNumber: 42, headSha: 'abcdef0123' });
    expect(md).toMatch(/ClawReview/);
    expect(md).toMatch(/src\/users\\\.ts/);
    expect(md).toMatch(/Medium/);
    expect(md).toMatch(/Critical/);
    expect(md).toMatch(/abcdef0/);
  });
});
