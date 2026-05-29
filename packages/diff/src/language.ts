const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  toml: 'toml',
  md: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
  vue: 'vue',
  svelte: 'svelte',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  scala: 'scala',
  lua: 'lua',
  r: 'r',
  jl: 'julia',
  zig: 'zig',
  nim: 'nim',
  proto: 'protobuf',
  tf: 'terraform',
  dockerfile: 'dockerfile',
};

const FILENAME_LANG: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  'go.mod': 'go-mod',
  'go.sum': 'go-sum',
  'package.json': 'json',
};

export function detectLanguage(path: string): string | undefined {
  const base = path.split('/').pop() ?? path;
  if (FILENAME_LANG[base]) return FILENAME_LANG[base];
  const dot = base.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_LANG[ext];
}
