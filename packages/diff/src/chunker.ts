import type { DiffFile, DiffHunk } from './types.js';

export interface ChunkOptions {
  /** Approximate max characters of hunk body in a single chunk. */
  maxChars?: number;
  /** Merge adjacent hunks within this gap of lines into one chunk. */
  mergeGap?: number;
}

export interface DiffChunk {
  file: DiffFile;
  hunks: DiffHunk[];
  startLine: number;
  endLine: number;
  body: string;
}

export function chunkFile(file: DiffFile, opts: ChunkOptions = {}): DiffChunk[] {
  const maxChars = opts.maxChars ?? 6000;
  const mergeGap = opts.mergeGap ?? 4;
  if (file.hunks.length === 0) return [];

  const groups: DiffHunk[][] = [];
  let current: DiffHunk[] = [file.hunks[0]!];

  for (let i = 1; i < file.hunks.length; i += 1) {
    const prev = current[current.length - 1]!;
    const next = file.hunks[i]!;
    const gap = next.newStart - prev.newEndLine;
    const projectedLen = current.reduce((n, h) => n + h.body.length, 0) + next.body.length;
    if (gap <= mergeGap && projectedLen <= maxChars) {
      current.push(next);
    } else {
      groups.push(current);
      current = [next];
    }
  }
  groups.push(current);

  return groups.map((hs) => {
    const start = hs[0]!.newStart;
    const end = hs[hs.length - 1]!.newEndLine;
    const body = hs.map((h) => `${h.header}\n${h.body}`).join('\n');
    return { file, hunks: hs, startLine: start, endLine: end, body };
  });
}
