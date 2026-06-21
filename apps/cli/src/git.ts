import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function gitDiff(base: string, head: string, cwd: string): Promise<string> {
  const { stdout } = await exec('git', ['diff', `${base}...${head}`], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function detectBase(cwd: string): Promise<string> {
  try {
    await exec('git', ['rev-parse', '--verify', 'origin/main'], { cwd });
    return 'origin/main';
  } catch {
    try {
      await exec('git', ['rev-parse', '--verify', 'main'], { cwd });
      return 'main';
    } catch {
      const { stdout } = await exec('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd });
      const root = stdout.split('\n').filter(Boolean).pop();
      if (!root) throw new Error('Could not detect a base ref');
      return root;
    }
  }
}

export async function revParse(ref: string, cwd: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', ref], { cwd });
  return stdout.trim();
}

/**
 * Run `git blame --line-porcelain <ref> -- <file>` and return raw stdout.
 *
 * Returns an empty string when the file is not present in `ref`
 * (newly-added files have no prior blame) rather than throwing — the
 * caller falls back to the unknown-author bucket and moves on.
 */
export async function gitBlameFile(
  ref: string,
  file: string,
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await exec(
      'git',
      ['blame', '--line-porcelain', ref, '--', file],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return '';
  }
}
