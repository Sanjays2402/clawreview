import type { AgentName } from '@clawreview/types';

import type { Agent } from './agent.js';
import {
  accessibilityAgent,
  performanceAgent,
  securityAgent,
  sqlInjectionAgent,
  styleAgent,
} from './agents.js';
import { SecretsAgent } from './secrets-agent.js';

export const AGENT_REGISTRY: Record<AgentName, Agent> = {
  security: securityAgent,
  performance: performanceAgent,
  style: styleAgent,
  accessibility: accessibilityAgent,
  'sql-injection': sqlInjectionAgent,
  secrets: new SecretsAgent(),
};

export function getAgent(name: AgentName): Agent {
  const agent = AGENT_REGISTRY[name];
  if (!agent) throw new Error(`Unknown agent: ${name}`);
  return agent;
}
