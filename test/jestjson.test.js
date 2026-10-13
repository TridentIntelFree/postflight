import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJestJson } from '../src/jestjson.js';
import { classify, OUTCOME } from '../src/classify.js';

// Real `jest --json` reports, captured by installing jest and running it
// against actual failing code. Committed on purpose: every heuristic bug this
// project has had came from imagining a runner's output rather than looking
// at it, and jest in particular was the runner I would most likely have got
// wrong from memory.

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('jest: a failing expectation is an assertion failure', () => {
  const cases = parseJestJson(fixture('jest-assertion.json'));
  const failed = cases.find((c) => c.status === 'failed');
  assert.equal(failed.name, 'rejects divide by zero');
  assert.equal(failed.type, 'failure');
  assert.match(failed.message, /expect\(received\)\.toThrow/);
  assert.ok(cases.some((c) => c.name === 'divides' && c.status === 'passed'));
});

test('jest: a suite that never loaded is an error, not proof', () => {
  // The distinction everything rests on. jest reports a suite that failed to
  // import as having NO assertionResults plus a message — so an import error
  // can never be read as a test that ran and disagreed.
  const cases = parseJestJson(fixture('jest-suite-failed.json'));
  const err = cases.find((c) => c.type === 'error');
  assert.ok(err, 'the unloadable suite should produce an error case');
  assert.match(err.message, /Test suite failed to run/);
  assert.equal(err.name, 'broken.test.js', 'named after the file that failed');
});

test('jest: a working suite in the same run still reports its cases', () => {
  // A broken suite must not swallow the results of the ones that did run.
  const cases = parseJestJson(fixture('jest-suite-failed.json'));
  assert.ok(cases.some((c) => c.name === 'divides' && c.status === 'passed'));
  assert.ok(cases.some((c) => c.type === 'failure'));
});

test('jest: an added test that fails on base classifies as proven', () => {
  const cases = parseJestJson(fixture('jest-assertion.json'));
  const v = classify({ exitCode: 1, output: '' }, cases, ['rejects divide by zero']);
  assert.equal(v.outcome, OUTCOME.RED);
  assert.equal(v.reason, 'assertion');
});

test('jest: an added test whose suite would not load is inconclusive', () => {
  const cases = parseJestJson(fixture('jest-suite-failed.json'));
  const v = classify({ exitCode: 1, output: '' }, cases, ['broken.test.js']);
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(v.reason, 'load-error');
});

test('jest: ANSI colour is stripped from messages', () => {
  const cases = parseJestJson(fixture('jest-assertion.json'));
  for (const c of cases) {
    assert.ok(!/\u001b\[/.test(c.message), 'escape codes must not reach the report');
  }
});

test('jest: non-jest input returns null so the caller falls back', () => {
  assert.equal(parseJestJson('not json'), null);
  assert.equal(parseJestJson('{"some":"other json"}'), null);
  assert.equal(parseJestJson(''), null);
});
