/**
 * Tiny glob matcher. Supports *, **, ?, and character classes [...].
 * Good enough for ignore-style patterns; we do not depend on the npm
 * `minimatch` package to keep the workspace install footprint small.
 */
export function minimatch(path: string, pattern: string): boolean {
  const re = compile(pattern);
  return re.test(path);
}

function compile(pattern: string): RegExp {
  let i = 0;
  let out = '';
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 2;
        if (pattern[i] === '/') i += 1;
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end < 0) {
        out += '\\[';
        i += 1;
      } else {
        out += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else if ('.+^$(){}|\\'.includes(ch)) {
      out += `\\${ch}`;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}
