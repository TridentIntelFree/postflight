import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGoJson } from '../src/gotest.js';
import { classify, OUTCOME } from '../src/classify.js';

// These fixtures are REAL `go test -json` output, captured by compiling and
// running actual Go code — not written from memory. Every heuristic bug this
// project has had came from imagining a runner's output instead of looking at
// it, so the fixtures are committed and the tests read them.

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('go: a failing test is an assertion failure, with its message', () => {
  const cases = parseGoJson(fixture('go-assertion.json'));
  const failed = cases.find((c) => c.status === 'failed');
  assert.equal(failed.name, 'TestFailsAssertion');
  assert.equal(failed.type, 'failure', 'a test that ran and failed is proof');
  assert.match(failed.message, /want 3, got 2/);
  assert.ok(cases.some((c) => c.name === 'TestPasses' && c.status === 'passed'));
});

test('go: a package that will not compile is an error, not proof', () => {
  // The distinction the whole tool rests on. A build failure means no test
  // ever observed the old code, so it proves nothing.
  const cases = parseGoJson(fixture('go-build-failure.json'));
  assert.equal(cases.length, 1);
  assert.equal(cases[0].type, 'error');
  assert.match(cases[0].message, /undefined: undefinedFunction/,
    'the compile diagnostic should be reported, not a generic banner');
});

test('go: a build failure classifies as inconclusive', () => {
  const cases = parseGoJson(fixture('go-build-failure.json'));
  const v = classify({ exitCode: 1, output: '' }, cases);
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
});

test('go: a real failure classifies as proven', () => {
  const cases = parseGoJson(fixture('go-assertion.json'));
  const v = classify({ exitCode: 1, output: '' }, cases, ['TestFailsAssertion']);
  assert.equal(v.outcome, OUTCOME.RED);
  assert.equal(v.reason, 'assertion');
});

test('go: output that is not a json stream returns null so the caller falls back', () => {
  assert.equal(parseGoJson('--- FAIL: TestX\nFAIL\n'), null);
  assert.equal(parseGoJson(''), null);
});

test('go: malformed lines are skipped rather than throwing', () => {
  const mixed = [
    'not json at all',
    '{"Action":"run","Package":"p","Test":"TestA"}',
    '{broken',
    '{"Action":"pass","Package":"p","Test":"TestA"}',
  ].join('\n');
  const cases = parseGoJson(mixed);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].status, 'passed');
});
