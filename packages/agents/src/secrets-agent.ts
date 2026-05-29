import type { Finding } from '@clawreview/types';
import { FindingsResponseSchema } from '@clawreview/types';
import { chatJson } from '@clawreview/llm';

import type { Agent, AgentRunInput, AgentRunResult } from './agent.js';

export interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
  /** Minimum entropy bits to consider a hit a real secret. */
  minEntropy?: number;
  cwe?: string;
}

export const SECRET_RULES: SecretRule[] = [
  {
    id: 'aws-access-key-id',
    description: 'AWS Access Key ID',
    pattern: /\b(AKIA|ASIA|AIDA|AGPA|AROA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b/,
    cwe: 'CWE-798',
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS Secret Access Key',
    pattern: /\b[A-Za-z0-9/+=]{40}\b/,
    minEntropy: 4.0,
    cwe: 'CWE-798',
  },
  {
    id: 'gh-pat',
    description: 'GitHub personal access token',
    pattern: /\bghp_[A-Za-z0-9]{36,}\b/,
    cwe: 'CWE-798',
  },
  {
    id: 'gh-app-token',
    description: 'GitHub App installation token',
    pattern: /\bghs_[A-Za-z0-9]{36,}\b/,
    cwe: 'CWE-798',
  },
  {
    id: 'gh-oauth',
    description: 'GitHub OAuth token',
    pattern: /\bgho_[A-Za-z0-9]{36,}\b/,
    cwe: 'CWE-798',
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    pattern: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/,
    cwe: 'CWE-798',
  },
  {
    id: 'stripe-secret',
    description: 'Stripe secret key',
    pattern: /\bsk_(live|test)_[A-Za-z0-9]{24,}\b/,
    cwe: 'CWE-798',
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/,
    cwe: 'CWE-798',
  },
  {
    id: 'private-key-block',
    description: 'PEM private key block',
    pattern: /-----BEGIN (RSA|EC|OPENSSH|DSA|PGP|PRIVATE) (PRIVATE )?KEY-----/,
    cwe: 'CWE-321',
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    cwe: 'CWE-522',
  },
];

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

interface RawHit {
  rule: SecretRule;
  line: number;
  match: string;
}

export function scanSecrets(diffBody: string, hunkStartLine: number): RawHit[] {
  const lines = diffBody.split('\n');
  const hits: RawHit[] = [];
  let newLine = hunkStartLine - 1;
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    const isAdd = line.startsWith('+');
    const isContext = line.startsWith(' ');
    if (!isAdd && !isContext) continue;
    if (isAdd || isContext) newLine += 1;
    if (!isAdd) continue;
    const content = line.slice(1);
    for (const rule of SECRET_RULES) {
      const m = rule.pattern.exec(content);
      if (!m) continue;
      if (rule.minEntropy && shannonEntropy(m[0]) < rule.minEntropy) continue;
      hits.push({ rule, line: newLine, match: m[0] });
    }
  }
  return hits;
}

export class SecretsAgent implements Agent {
  readonly name = 'secrets' as const;
  readonly description = 'Regex pre-scan plus LLM confirmation for committed secrets.';
  readonly defaultModel = 'hermes/claude-opus-4';

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const hits = scanSecrets(input.chunk.body, input.chunk.startLine);
    if (hits.length === 0) {
      return { findings: [], promptTokens: 0, completionTokens: 0 };
    }

    const prompt = `You are validating possible committed secrets. For each candidate below, decide if it is a real secret being committed to the repo or a false positive (test fixture, placeholder, redacted value, public sample). Reply JSON {"findings":[...]} using ClawReview finding schema. Skip false positives.

Candidates:
${hits
  .map(
    (h, i) =>
      `(${i + 1}) line ${h.line}: rule=${h.rule.id} description=${h.rule.description} match=${mask(h.match)}`,
  )
  .join('\n')}

File: ${input.chunk.file.path}
Hunk diff:
\`\`\`
${input.chunk.body}
\`\`\`
`;

    const { value, raw } = await chatJson<unknown>(input.provider, {
      model: input.model || this.defaultModel,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a secret-scanning confirmation reviewer. Respond ONLY with valid JSON.' },
        { role: 'user', content: prompt },
      ],
    });

    const parsed = FindingsResponseSchema.safeParse(value);
    const findings: Finding[] = parsed.success
      ? parsed.data.findings.map((f) => ({ ...f, agent: this.name, category: 'secrets' }))
      : hits.map<Finding>((h) => ({
          agent: this.name,
          category: 'secrets',
          severity: 'critical',
          title: `Possible ${h.rule.description} committed`,
          rationale: `Pattern ${h.rule.id} matched on a line being added. Rotate the secret and remove it from history.`,
          file: input.chunk.file.path,
          startLine: h.line,
          confidence: 0.6,
          cwe: h.rule.cwe,
          tags: ['regex-only'],
        }));

    return {
      findings,
      promptTokens: raw.usage.promptTokens,
      completionTokens: raw.usage.completionTokens,
      rawContent: raw.content,
    };
  }
}

function mask(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
