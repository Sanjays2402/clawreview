import type { SecretRule } from '../secrets-agent.js';

export const payment_providers_rules: SecretRule[] = [
  { id: 'square-access-token', description: 'Square access token', pattern: /placeholder-square-access-token/, cwe: 'CWE-798' },
  { id: 'stripe-publishable', description: 'Stripe publishable key', pattern: /placeholder-stripe-publishable/, cwe: 'CWE-798' },
];
