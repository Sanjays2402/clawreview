import { detectLanguage } from './language.js';
import type { DiffFile, DiffHunk, ParsedDiff } from './types.js';

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parsePath(line: string): string | null {
  const stripped = line.replace(/^[ab]\//, '');
  if (stripped === '/dev/null') return null;
  return stripped;
}

export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const files: DiffFile[] = [];
  const lines = diffText.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.startsWith('diff --git')) {
      i += 1;
      continue;
    }

    const headerStart = i;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let status: DiffFile['status'] = 'modified';
    let isBinary = false;
    const hunks: DiffHunk[] = [];

    i += 1;
    while (i < lines.length && !(lines[i] ?? '').startsWith('diff --git')) {
      const l = lines[i] ?? '';
      if (l.startsWith('new file mode')) status = 'added';
      else if (l.startsWith('deleted file mode')) status = 'deleted';
      else if (l.startsWith('rename from')) status = 'renamed';
      else if (l.startsWith('copy from')) status = 'copied';
      else if (l.startsWith('Binary files')) {
        isBinary = true;
      } else if (l.startsWith('--- ')) {
        oldPath = parsePath(l.slice(4).trim());
      } else if (l.startsWith('+++ ')) {
        newPath = parsePath(l.slice(4).trim());
      } else if (l.startsWith('@@')) {
        const m = HUNK_HEADER_RE.exec(l);
        if (!m) {
          i += 1;
          continue;
        }
        const oldStart = Number(m[1]);
        const oldLines = m[2] ? Number(m[2]) : 1;
        const newStart = Number(m[3]);
        const newLines = m[4] ? Number(m[4]) : 1;
        const header = l;
        const bodyLines: string[] = [];
        i += 1;
        while (i < lines.length) {
          const bl = lines[i] ?? '';
          if (bl.startsWith('@@') || bl.startsWith('diff --git')) break;
          if (bl.startsWith('+') || bl.startsWith('-') || bl.startsWith(' ') || bl === '\\ No newline at end of file') {
            bodyLines.push(bl);
            i += 1;
          } else {
            break;
          }
        }
        hunks.push({
          oldStart,
          oldLines,
          newStart,
          newLines,
          header,
          body: bodyLines.join('\n'),
          newEndLine: newStart + Math.max(newLines - 1, 0),
        });
        continue;
      }
      i += 1;
    }

    const resolvedPath = newPath ?? oldPath ?? '';
    const raw = lines.slice(headerStart, i).join('\n');
    files.push({
      oldPath,
      newPath,
      path: resolvedPath,
      status,
      isBinary,
      language: resolvedPath ? detectLanguage(resolvedPath) : undefined,
      hunks,
      raw,
    });
  }

  return { files };
}
