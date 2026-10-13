// Minimal GitHub Actions plumbing.
//
// Deliberately not @actions/core. This Action runs inside other people's CI,
// so every line should be readable without unpacking a bundle — which rules
// out a dependency tree and the `dist/` blob that comes with it.

import { appendFileSync } from 'node:fs';
import { EOL } from 'node:os';

/** Read an action input. Composite actions pass them as INPUT_<NAME>. */
export function input(name, fallback = '') {
  const key = `INPUT_${name.replace(/[ -]/g, '_').toUpperCase()}`;
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value.trim();
}

export function boolInput(name, fallback = false) {
  const raw = input(name, String(fallback)).toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** Multi-line inputs: one value per line, blanks and `#` comments dropped. */
export function listInput(name, fallback = []) {
  const raw = input(name, '');
  if (!raw) return fallback;
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function writeFile(envVar, text) {
  const path = process.env[envVar];
  if (!path) return;
  appendFileSync(path, text + EOL, 'utf8');
}

/** Values written here appear as `steps.<id>.outputs.<name>`. */
export function setOutput(name, value) {
  // Heredoc form, because outputs legitimately contain newlines (the report).
  const token = `ghadelim_${Math.random().toString(36).slice(2)}`;
  writeFile('GITHUB_OUTPUT', `${name}<<${token}${EOL}${value}${EOL}${token}`);
}

/** Markdown shown on the workflow run's summary page. */
export function summary(markdown) {
  writeFile('GITHUB_STEP_SUMMARY', markdown);
}

export const log = {
  info: (msg) => console.log(msg),
  notice: (msg) => console.log(`::notice::${msg}`),
  warn: (msg) => console.log(`::warning::${msg}`),
  error: (msg) => console.log(`::error::${msg}`),
  group: (name, body) => {
    console.log(`::group::${name}`);
    body();
    console.log('::endgroup::');
  },
};

/** The webhook payload for the event that triggered this run, if any. */
export async function eventPayload() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}
