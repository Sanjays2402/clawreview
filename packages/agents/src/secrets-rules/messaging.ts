import type { SecretRule } from '../secrets-agent.js';

export const messaging_rules: SecretRule[] = [
  { id: 'twilio-account-sid', description: 'Twilio Account SID', pattern: /placeholder-twilio-account-sid/, cwe: 'CWE-798' },
  { id: 'sendgrid-api', description: 'SendGrid API key', pattern: /placeholder-sendgrid-api/, cwe: 'CWE-798' },
  { id: 'mailgun-api', description: 'Mailgun API key', pattern: /placeholder-mailgun-api/, cwe: 'CWE-798' },
];
