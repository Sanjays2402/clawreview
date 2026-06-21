import { PromptedAgent } from './prompted-agent.js';

/**
 * Language allowlists for agents whose findings are only meaningful on
 * a narrow subset of file types. The accessibility agent has always
 * scoped to UI files; before this slice that filter ran AFTER the LLM
 * call as a postFilter, so we paid for the round trip and then threw
 * the result away. Moving the same set into `preFilter` lets us skip
 * the model call entirely on out-of-scope chunks.
 *
 * sql-injection has the same problem in reverse: it ran against every
 * chunk even though it only meaningfully fires on backend code. The
 * allowlist here mirrors the languages where SQL string construction
 * realistically lives.
 */
export const UI_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'vue',
  'svelte',
  'html',
  'css',
  'scss',
]);

export const BACKEND_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'python',
  'go',
  'java',
  'kotlin',
  'csharp',
  'php',
  'ruby',
  'rust',
  'sql',
]);

export const securityAgent = new PromptedAgent({
  name: 'security',
  description: 'Spots auth, authz, input handling, deserialization, and crypto issues.',
  defaultModel: 'hermes/claude-opus-4',
  systemPrompt: `You are a senior application security reviewer. Read the diff hunk and flag concrete vulnerabilities introduced or worsened by the change. Focus on: authentication, authorization, injection, deserialization, SSRF, path traversal, weak crypto, secrets in code, race conditions affecting auth, and unsafe defaults. Always cite a CWE when applicable. Do not flag style or general code quality.`,
});

export const performanceAgent = new PromptedAgent({
  name: 'performance',
  description: 'Spots N+1 queries, blocking IO on hot paths, allocations in loops, and quadratic algorithms.',
  defaultModel: 'hermes/claude-opus-4',
  systemPrompt: `You are a senior performance reviewer. Flag concrete performance regressions introduced in the diff: N+1 queries, blocking IO on hot paths, quadratic loops, large allocations inside loops, missing indexes, unnecessary serialization, render thrash. Be specific about the cost and propose a measurable fix. Skip micro-optimizations.`,
});

export const styleAgent = new PromptedAgent({
  name: 'style',
  description: 'Naming, readability, dead code, unclear abstractions.',
  defaultModel: 'hermes/claude-opus-4',
  systemPrompt: `You are a senior code reviewer focused on readability and maintainability. Flag confusing names, dead code, leaking abstractions, missing error handling, unsafe casts, mismatched comments. Prefer "low" or "nit" severity unless the issue actively traps future readers. Never duplicate findings the security or performance agents would catch.`,
});

export const accessibilityAgent = new PromptedAgent({
  name: 'accessibility',
  description: 'WCAG-tier accessibility issues in UI diffs.',
  defaultModel: 'hermes/claude-opus-4',
  systemPrompt: `You are a frontend accessibility reviewer. Focus on UI diffs (jsx, tsx, vue, svelte, html, css). Flag missing labels, missing alt text, color contrast issues, missing aria roles, keyboard traps, focus management, and motion that disregards prefers-reduced-motion. Ignore non-UI files.`,
  // preFilter short-circuits the LLM call on non-UI chunks; postFilter
  // is kept as a belt-and-suspenders guard against the LLM emitting a
  // finding whose file extension changed mid-run (renamed file edge).
  preFilter: (input) => UI_LANGUAGES.has(input.chunk.file.language ?? ''),
  postFilter: (_f, input) => UI_LANGUAGES.has(input.chunk.file.language ?? ''),
});

export const sqlInjectionAgent = new PromptedAgent({
  name: 'sql-injection',
  description: 'Targets SQL injection, ORM misuse, dynamic query construction.',
  defaultModel: 'hermes/claude-opus-4',
  systemPrompt: `You are a SQL injection specialist. Only report findings related to query construction. Flag string concatenation into SQL, missing parameterization, unsafe ORM raw escapes, dynamic table or column names from user input. Cite CWE-89. Do not report generic security issues outside SQL.`,
  preFilter: (input) => BACKEND_LANGUAGES.has(input.chunk.file.language ?? ''),
});
