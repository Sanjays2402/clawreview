import { describe, expect, it } from 'vitest';
import { getAgent } from '../../src/registry.js';

describe('style agent', () => {
  it('is registered with a default model', () => {
    const agent = getAgent('style');
    expect(agent.name).toBe('style');
    expect(agent.defaultModel).toMatch(/\//);
  });
});
