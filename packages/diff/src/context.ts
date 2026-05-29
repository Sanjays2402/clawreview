import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ContextLoaderOptions {
  /** Repo root used to read files for surrounding context. */
  cwd: string;
  /** Lines of context to fetch on each side of the hunk. */
  contextLines?: number;
}

export class FileContextLoader {
  private cache = new Map<string, string[]>();

  constructor(private readonly opts: ContextLoaderOptions) {}

  async surround(path: string, startLine: number, endLine: number): Promise<string> {
    const context = this.opts.contextLines ?? 12;
    const lines = await this.load(path);
    if (lines.length === 0) return '';
    const from = Math.max(0, startLine - 1 - context);
    const to = Math.min(lines.length, endLine + context);
    return lines
      .slice(from, to)
      .map((l, idx) => `${String(from + idx + 1).padStart(5, ' ')}  ${l}`)
      .join('\n');
  }

  private async load(path: string): Promise<string[]> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    try {
      const raw = await readFile(join(this.opts.cwd, path), 'utf8');
      const lines = raw.split(/\r?\n/);
      this.cache.set(path, lines);
      return lines;
    } catch {
      this.cache.set(path, []);
      return [];
    }
  }
}
