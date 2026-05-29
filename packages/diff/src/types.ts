export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  body: string;
  /** Lines in the new file covered by this hunk. */
  newEndLine: number;
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  /** Convenience: the post-change path or the pre-change path if deleted. */
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  isBinary: boolean;
  language?: string;
  hunks: DiffHunk[];
  /** Raw patch text for this file, header included. */
  raw: string;
}

export interface ParsedDiff {
  files: DiffFile[];
}
