import type { AgentName, Finding } from '@clawreview/types';
import { FindingsResponseSchema } from '@clawreview/types';
import { chatJson } from '@clawreview/llm';

import type { Agent, AgentRunInput, AgentRunResult } from './agent.js';

export interface PromptedAgentOptions {
  name: AgentName;
  description: string;
  defaultModel: string;
  systemPrompt: string;
  /** Optional post-filter applied to findings emitted by the model. */
  postFilter?: (f: Finding, input: AgentRunInput) => boolean;
}

const USER_TEMPLATE = (input: AgentRunInput): string => `\
File: ${input.chunk.file.path}
Language: ${input.chunk.file.language ?? 'unknown'}
Hunk lines: ${input.chunk.startLine}-${input.chunk.endLine}

Diff hunk (\`+\` = added, \`-\` = removed, ' ' = context):
\`\`\`
${input.chunk.body}
\`\`\`

${input.surroundingContext ? `Surrounding file context:\n\`\`\`\n${input.surroundingContext}\n\`\`\`\n` : ''}
Reply with strict JSON matching:
{
  "findings": [
    {
      "agent": "${input.config.agents[0] ?? 'unknown'}",
      "category": "security|performance|style|maintainability|accessibility|sql-injection|secrets|bug|other",
      "severity": "critical|high|medium|low|nit",
      "title": "short imperative title",
      "rationale": "1-3 sentence explanation",
      "file": "${input.chunk.file.path}",
      "startLine": <line in new file>,
      "endLine": <optional line>,
      "confidence": 0..1,
      "cwe": "CWE-### (optional)",
      "suggested": { "description": "...", "diff": "unified diff fragment" }
    }
  ]
}

Constraints:
- Only include findings caused or aggravated by lines marked with \`+\`.
- Skip stylistic nits unless explicitly in scope for this agent.
- If nothing relevant, return {"findings": []}.
- Never invent line numbers outside the hunk.`;

export class PromptedAgent implements Agent {
  readonly name: AgentName;
  readonly description: string;
  readonly defaultModel: string;

  constructor(private readonly opts: PromptedAgentOptions) {
    this.name = opts.name;
    this.description = opts.description;
    this.defaultModel = opts.defaultModel;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { value, raw } = await chatJson<unknown>(input.provider, {
      model: input.model || this.defaultModel,
      temperature: 0.1,
      messages: [
        { role: 'system', content: this.opts.systemPrompt },
        { role: 'user', content: USER_TEMPLATE(input) },
      ],
    });

    const parsed = FindingsResponseSchema.safeParse(value);
    if (!parsed.success) {
      return {
        findings: [],
        promptTokens: raw.usage.promptTokens,
        completionTokens: raw.usage.completionTokens,
        rawContent: raw.content,
      };
    }

    const stamped: Finding[] = parsed.data.findings.map((f) => ({
      ...f,
      agent: this.name,
      file: f.file || input.chunk.file.path,
    }));

    const within = stamped.filter((f) => {
      if (f.startLine < input.chunk.startLine) return false;
      if (f.startLine > input.chunk.endLine + 2) return false;
      return true;
    });

    const post = this.opts.postFilter
      ? within.filter((f) => this.opts.postFilter!(f, input))
      : within;

    return {
      findings: post,
      promptTokens: raw.usage.promptTokens,
      completionTokens: raw.usage.completionTokens,
      rawContent: raw.content,
    };
  }
}
