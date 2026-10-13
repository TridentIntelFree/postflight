// Building the thing we actually test: the base commit's source, with the
// pull request's test files laid over the top.
//
// Done in a detached `git worktree` rather than by checking out base in place.
// The job's own checkout is left untouched, so a crashed run cannot strand
// someone's workspace on the wrong commit, and a failure mid-way is cleaned
// up by removing one directory.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const exec = promisify(execFile);

async function git(args, cwd = process.cwd()) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Files changed between base and head.
 *
 * Uses the merge base (`base...head`), not a direct diff, so commits that
 * landed on the base branch after this pull request opened are not mistaken
 * for the author's work.
 */
export async function changedFiles(baseSha, headSha, cwd = process.cwd()) {
  const range = `${baseSha}...${headSha}`;
  const out = await git(['diff', '--name-only', '--diff-filter=ACMR', range], cwd);
  return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * Confirm both commits are present. Shallow clones are the default for
 * actions/checkout, and the resulting error ("bad object") is opaque enough
 * that it is worth catching here and saying what to change.
 */
export async function assertHistory(baseSha, headSha, cwd = process.cwd()) {
  for (const sha of [baseSha, headSha]) {
    try {
      await git(['cat-file', '-e', `${sha}^{commit}`], cwd);
    } catch {
      throw new Error(
        `Commit ${sha.slice(0, 8)} is not in this clone. redgreen needs both ` +
        `sides of the comparison, so the checkout step needs enough history:\n\n` +
        `    - uses: actions/checkout@v4\n` +
        `      with:\n` +
        `        fetch-depth: 0\n`
      );
    }
  }
}

/**
 * Create a worktree at `baseSha` and overlay the head versions of `testFiles`.
 *
 * Returns the worktree path plus a `cleanup()` that always succeeds — cleanup
 * failing must never turn a meaningful result into a failed run.
 */
export async function buildBaseWorktree({
  baseSha,
  headSha,
  testFiles,
  linkPaths = [],
  cwd = process.cwd(),
}) {
  const dir = await mkdtemp(join(tmpdir(), 'redgreen-'));
  const worktree = join(dir, 'base');

  await git(['worktree', 'add', '--detach', worktree, baseSha], cwd);

  const cleanup = async () => {
    try { await git(['worktree', 'remove', '--force', worktree], cwd); } catch { /* best effort */ }
    try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    // Overlay the head version of each test file. `git show` is used rather
    // than `git checkout <head> -- <path>` so that a test file ADDED by the
    // pull request lands correctly: checkout would also stage it against the
    // worktree's index, and a path that does not exist at base makes the
    // whole checkout fail rather than just that file.
    const overlaid = [];
    const missing = [];
    for (const file of testFiles) {
      let content;
      try {
        content = await gitShowRaw(headSha, file, cwd);
      } catch {
        missing.push(file);   // deleted on head: nothing to overlay
        continue;
      }
      const target = join(worktree, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      overlaid.push(file);
    }

    // Reuse whatever the job already installed instead of installing it
    // twice. A dependency tree is identical often enough, and expensive
    // enough, that this is usually the difference between a check people
    // keep and one they remove.
    const linked = [];
    for (const path of linkPaths) {
      const source = resolve(cwd, path);
      try {
        await access(source);
      } catch {
        continue;              // not present: nothing to reuse
      }
      const target = join(worktree, path);
      try {
        await mkdir(dirname(target), { recursive: true });
        await symlink(source, target, 'junction');
        linked.push(path);
      } catch { /* a real copy already there, or no permission: let it be */ }
    }

    return { worktree, cleanup, overlaid, missing, linked };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** `git show <sha>:<path>` as a Buffer, so binary fixtures survive intact. */
async function gitShowRaw(sha, path, cwd) {
  const { stdout } = await exec('git', ['show', `${sha}:${path}`], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export const _internal = { git };
