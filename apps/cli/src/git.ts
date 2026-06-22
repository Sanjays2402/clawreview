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
 * Run `git show <ref>:<path>` and return raw stdout.
 *
 * Returns `null` when the file is not present at `ref` (the preset
 * didn't exist yet, or the path has since been renamed) rather than
 * throwing -- the caller decides whether "absent at ref" is a hard
 * error or a graceful skip.
 *
 * Used by `clawreview presets diff --since <ref>` so a preset's
 * resolved body at HEAD can be compared against the same preset's
 * body at a prior commit without checking out the old tree.
 */
export async function gitShow(
  ref: string,
  path: string,
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec(
      'git',
      ['show', `${ref}:${path}`],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
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

/**
 * Run `git merge-base <a> <b>` and return the resolved sha.
 *
 * Used by `clawreview presets diff --since-range <a>...<b>` (tick 17)
 * to resolve the LEFT side of the symmetric-difference form: when
 * the operator wants "what changed on `b` since it diverged from
 * `a`?", we anchor chain A at the merge-base instead of at `a`
 * directly. Otherwise a long-lived feature branch comparison would
 * pick up changes that landed on `main` after the branch split,
 * which is the wrong frame for "changes on the branch".
 *
 * Returns `null` (rather than throwing) when:
 *   - either ref doesn't exist in the repo;
 *   - the two refs have no common ancestor (disjoint histories);
 *   - git is not installed / not on PATH.
 *
 * The caller decides what to do on null -- the presets diff command
 * surfaces it as a clean error message naming both refs so the
 * operator can correct the input.
 */
export async function gitMergeBase(
  a: string,
  b: string,
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec(
      'git',
      ['merge-base', a, b],
      { cwd, maxBuffer: 1024 * 1024 },
    );
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}
