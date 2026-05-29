import { describe, expect, it } from 'vitest';
import { getAgent } from '../../src/registry.js';

describe('secrets agent', () => {
  it('is registered with a default model', () => {
    const agent = getAgent('secrets');
    expect(agent.name).toBe('secrets');
    expect(agent.defaultModel).toMatch(/\//);
  });
});
