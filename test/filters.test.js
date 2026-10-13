import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { RUNNERS } from '../src/runners.js';

// Every runner's narrowing filter is pasted into a shell command, so every
// one of them has to survive the shell. This file exists because they did
// not: `quote()` treated `^ $ ( ) |` as inert, so five of the ten runners
// emitted them raw.
//
//   go       -run ^(TestAlpha|TestBeta)$     bash: syntax error near `('
//   vitest   -t TestAlpha|TestBeta           a pipe into `TestBeta`
//
// The symptom was not a wrong verdict but a dead one: a pipeline's exit
// status is the last command's 127, so postflight reported
// `error (command-unavailable)` on an ordinary pull request. It survived four
// releases because every test name in every lab and benchmark happened to
// contain a space, which forced quoting by accident.

const FILTERED = Object.entries(RUNNERS).filter(([, r]) => typeof r.filter === 'function');

// Names chosen to be hostile in the ways real test names are: single words
// (the case that was broken), spaces, an apostrophe, and the two forms of
// shell injection a test title could plausibly contain.
const NAME_SETS = [
  ['TestAlpha', 'TestBeta'],
  ['oneword'],
  ['has a space', 'another one'],
  ["it's got an apostrophe", 'x'],
  ['$(touch /tmp/postflight-pwned)', 'y'],
  ['`touch /tmp/postflight-pwned2`', 'z'],
  ['a;rm -rf /tmp/nothing', 'w'],
];

test('every runner filter survives the shell', () => {
  assert.ok(FILTERED.length >= 9, 'most runners should declare a filter');
  for (const [name, runner] of FILTERED) {
    for (const names of NAME_SETS) {
      const argument = runner.filter(names);
      // `true` ignores its arguments, so this asserts nothing but that bash
      // can parse the command at all — which is exactly what was failing.
      execFileSync('/bin/bash', ['-c', `true ${argument}`], { stdio: 'pipe' });
    }
  }
});

test('a filter cannot execute anything', () => {
  // The same bug is an injection: a test title is author-controlled text that
  // ends up in a shell command. This is not theoretical — mutating `quote()`
  // to return its argument unchanged makes the commands below really run, and
  // the proof was finding these files on disk afterwards.
  const marks = ['/tmp/postflight-pwned', '/tmp/postflight-pwned2'];
  for (const path of marks) rmSync(path, { force: true });

  for (const [, runner] of FILTERED) {
    const argument = runner.filter([
      `$(touch ${marks[0]})`, `\`touch ${marks[1]}\``,
    ]);
    execFileSync('/bin/bash', ['-c', `true ${argument}`], { stdio: 'pipe' });
  }

  for (const path of marks) {
    assert.equal(existsSync(path), false,
      `${path} exists — a test name was executed as a command`);
  }
});

test('single-word names are quoted, because that is the case that broke', () => {
  // Explicit, because the general test above would still pass if someone
  // "simplified" quoting back to an allowlist containing shell characters:
  // `true a|b` parses fine, it just means something entirely different.
  for (const runner of ['vitest', 'jest', 'mocha', 'node-test', 'go']) {
    const argument = RUNNERS[runner].filter(['Alpha', 'Beta']);
    assert.ok(/'[^']*\|[^']*'/.test(argument),
      `${runner}: the alternation must be inside quotes, got ${argument}`);
  }
});

test('go wraps the alternation in an anchored group, inside quotes', () => {
  const argument = RUNNERS.go.filter(['TestA', 'TestB']);
  assert.equal(argument, "-run '^(TestA|TestB)$'");
});

test('cargo passes several filters through to the test binary', () => {
  // `cargo test a b` is a usage error: cargo takes at most one TESTNAME.
  // Verified against real cargo — the old form was invalid for any pull
  // request adding more than one test, which is most of them.
  assert.equal(RUNNERS.cargo.filter(['alpha', 'beta']), '-- alpha beta');
});
