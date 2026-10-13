// Running the base test command and collecting whatever it produced.

import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const MAX_OUTPUT = 2 * 1024 * 1024; // keep a runaway suite from exhausting memory

/**
 * Run `command` in `cwd`, with `{files}` replaced by the test file list.
 *
 * Output is captured rather than inherited so it can be classified, but it is
 * also echoed: a check whose reasoning you cannot see in the log is a check
 * people stop trusting.
 */
export function runTests({ command, files, cwd, env = {}, echo = true }) {
  const quoted = files.map(shellQuote).join(' ');
  const resolved = command.includes('{files}')
    ? command.replaceAll('{files}', quoted)
    : command;

  return new Promise((resolve) => {
    const child = spawn(resolved, {
      cwd,
      shell: true,
      env: { ...process.env, ...env, POSTFLIGHT: '1' },
    });

    let output = '';
    let truncated = false;
    const collect = (chunk) => {
      const text = chunk.toString();
      if (echo) process.stdout.write(text);
      if (output.length < MAX_OUTPUT) {
        output += text;
      } else {
        truncated = true;
      }
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (err) => {
      resolve({ exitCode: 127, output: `${output}\npostflight: ${err.message}`, truncated, command: resolved });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, output, truncated, command: resolved });
    });
  });
}

function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Find and concatenate JUnit XML written by the run.
 *
 * Only files modified during the run are taken: a stale report committed to
 * the repository, or left by an earlier job, would otherwise be read as this
 * run's evidence and quietly invert the verdict.
 */
export async function collectJUnit(roots, cwd, since) {
  const candidates = [];

  for (const root of roots) {
    await walk(join(cwd, root), candidates, 0);
  }

  const parts = [];
  for (const file of candidates) {
    try {
      const info = await stat(file);
      if (since && info.mtimeMs < since) continue;
      parts.push(await readFile(file, 'utf8'));
    } catch { /* vanished mid-walk */ }
  }
  return parts.join('\n');
}

async function walk(dir, out, depth) {
  if (depth > 6 || out.length > 200) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      await walk(path, out, depth + 1);
    } else if (extname(entry.name) === '.xml') {
      out.push(path);
    }
  }
}
