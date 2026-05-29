import { describe, expect, it } from 'vitest';
import { getAgent } from '../../src/registry.js';

describe('accessibility agent', () => {
  it('is registered with a default model', () => {
    const agent = getAgent('accessibility');
    expect(agent.name).toBe('accessibility');
    expect(agent.defaultModel).toMatch(/\//);
  });
});
