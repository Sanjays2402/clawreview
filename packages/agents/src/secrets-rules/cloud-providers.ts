import type { SecretRule } from '../secrets-agent.js';

export const cloud_providers_rules: SecretRule[] = [
  { id: 'do-token', description: 'DigitalOcean token', pattern: /placeholder-do-token/, cwe: 'CWE-798' },
  { id: 'heroku-api-key', description: 'Heroku API key', pattern: /placeholder-heroku-api-key/, cwe: 'CWE-798' },
];
