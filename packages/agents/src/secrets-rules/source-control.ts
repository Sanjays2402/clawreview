import type { SecretRule } from '../secrets-agent.js';

export const source_control_rules: SecretRule[] = [
  { id: 'gitlab-pat', description: 'GitLab personal access token', pattern: /placeholder-gitlab-pat/, cwe: 'CWE-798' },
  { id: 'bitbucket-app', description: 'Bitbucket App password', pattern: /placeholder-bitbucket-app/, cwe: 'CWE-798' },
];
