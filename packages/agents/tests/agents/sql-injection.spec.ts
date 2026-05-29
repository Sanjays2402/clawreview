import { describe, expect, it } from 'vitest';
import { getAgent } from '../../src/registry.js';

describe('sql-injection agent', () => {
  it('is registered with a default model', () => {
    const agent = getAgent('sql-injection');
    expect(agent.name).toBe('sql-injection');
    expect(agent.defaultModel).toMatch(/\//);
  });
});
