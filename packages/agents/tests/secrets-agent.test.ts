import { describe, expect, it } from 'vitest';

import { scanSecrets, shannonEntropy } from '../src/secrets-agent.js';

describe('scanSecrets', () => {
  it('detects an AWS access key id added in a hunk', () => {
    const body = ` const region = 'us-east-1';\n+const id = "AKIAIOSFODNN7EXAMPLE";\n const x = 1;`;
    const hits = scanSecrets(body, 10);
    expect(hits.some((h) => h.rule.id === 'aws-access-key-id')).toBe(true);
  });

  it('ignores secrets on context lines', () => {
    const body = ` const id = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n+const ok = true;`;
    const hits = scanSecrets(body, 1);
    expect(hits.find((h) => h.rule.id === 'gh-pat')).toBeUndefined();
  });

  it('respects entropy threshold for the AWS secret rule', () => {
    const lowEntropy = '+' + 'a'.repeat(40);
    const hits = scanSecrets(lowEntropy, 1);
    expect(hits.find((h) => h.rule.id === 'aws-secret-access-key')).toBeUndefined();
  });

  it('computes shannon entropy', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBeCloseTo(2, 2);
  });
});
