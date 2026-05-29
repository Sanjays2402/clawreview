import { describe, expect, it } from 'vitest';
import { getAgent } from '../../src/registry.js';

describe('performance agent', () => {
  it('is registered with a default model', () => {
    const agent = getAgent('performance');
    expect(agent.name).toBe('performance');
    expect(agent.defaultModel).toMatch(/\//);
  });
});
