import { describe, expect, it } from 'vitest';
import { getAgent } from '../../src/registry.js';

describe('security agent', () => {
  it('is registered with a default model', () => {
    const agent = getAgent('security');
    expect(agent.name).toBe('security');
    expect(agent.defaultModel).toMatch(/\//);
  });
});
