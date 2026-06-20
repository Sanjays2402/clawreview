import type { AgentName, Finding } from '@clawreview/types';
import { FindingsResponseSchema } from '@clawreview/types';
import { chatJson } from '@clawreview/llm';

import type { Agent, AgentRunInput, AgentRunResult } from './agent.js';
import { formatLanguageRulesBlock, loadLanguageRules } from './language-rules-loader.js';

export interface PromptedAgentOptions {
  name: AgentName;
  description: string;
  defaultModel: string;
  systemPrompt: string;
  /** Optional post-filter applied to findings emitted by the model. */
  postFilter?: (f: Finding, input: AgentRunInput) => boolean;
  /**
   * Optional pre-flight chunk filter. If supplied AND returns false for
   * the current chunk, the agent SKIPS the model call entirely and
   * returns `{ findings: [], promptTokens: 0, completionTokens: 0 }`.
   *
   * This is the cheap, fast cousin of `postFilter`: it lets agents that
   * only care about a narrow language/path subset (accessibility on
   * UI files, sql-injection on backend code) bow out before paying for
   * an LLM round trip. When omitted the agent runs against every chunk
   * the pipeline routes to it, exactly like before.
   */
  preFilter?: (input: AgentRunInput) => boolean;
  /**
   * Auto-attach `language-rules/<lang>.md` to the system prompt when a
   * matching sheet exists for the current chunk's language. Defaults to
   * `true`. Set to `false` for agents that operate on raw bytes / non
   * language-specific input where the rules would only add noise.
   */
  injectLanguageRules?: boolean;
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
  private readonly injectLanguageRules: boolean;

  constructor(private readonly opts: PromptedAgentOptions) {
    this.name = opts.name;
    this.description = opts.description;
    this.defaultModel = opts.defaultModel;
    this.injectLanguageRules = opts.injectLanguageRules ?? true;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    // Pre-flight: if the agent has a chunk filter and it rejects this
    // chunk, skip the model call entirely. The pipeline still records
    // the (zero-cost, zero-finding) execution so the metrics counter
    // reflects the actual chunk x agent pairing fan-out.
    if (this.opts.preFilter && !this.opts.preFilter(input)) {
      return { findings: [], promptTokens: 0, completionTokens: 0 };
    }
    const systemPrompt = await this.buildSystemPrompt(input);
    const { value, raw } = await chatJson<unknown>(input.provider, {
      model: input.model || this.defaultModel,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
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

  /**
   * Compose the system prompt for a single agent invocation. When
   * `injectLanguageRules` is on (the default), look up the rule sheet
   * for the chunk's language and append it under a fenced header. Misses
   * are silent — most languages have a rule sheet, but a few intentionally
   * do not, and falling back to the bare agent prompt is the right move.
   */
  private async buildSystemPrompt(input: AgentRunInput): Promise<string> {
    if (!this.injectLanguageRules) return this.opts.systemPrompt;
    const rules = await loadLanguageRules(input.chunk.file.language);
    if (!rules) return this.opts.systemPrompt;
    return this.opts.systemPrompt + formatLanguageRulesBlock(rules);
  }
}
