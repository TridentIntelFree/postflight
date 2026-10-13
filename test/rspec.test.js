import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRspecJson } from '../src/rspec.js';
import { classify, OUTCOME } from '../src/classify.js';

// Real `rspec --format json` reports, captured by installing rspec and
// running it against actual Ruby code. Committed on purpose: every heuristic
// bug this project has had came from imagining a runner's output rather than
// looking at it, and rspec's "failed" status covers two things that must not
// be confused.

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => parseRspecJson(readFileSync(join(here, 'fixtures', name), 'utf8'));

const mixed = fixture('rspec-mixed.json');
const loadError = fixture('rspec-load-error.json');
const runtime = fixture('rspec-runtime-error.json');

test('rspec: a failed expectation is an assertion failure', () => {
  const c = mixed.find((x) => x.name === 'Calc rejects divide by zero');
  assert.equal(c.type, 'failure');
  assert.match(c.message, /ExpectationNotMetError/);
});

test('rspec: a passing example is reported as passing', () => {
  const c = mixed.find((x) => x.name === 'Calc divides');
  assert.equal(c.status, 'passed');
  assert.equal(c.type, null);
});

test('rspec: a method that does not exist yet is an error, not proof', () => {
  // The distinction everything rests on, and rspec reports BOTH as
  // status: "failed". An example calling a method the pull request introduces
  // must never be credited as having observed the old behaviour.
  const c = mixed.find((x) => x.name === 'modulo is always non-negative');
  assert.equal(c.status, 'failed');
  assert.equal(c.type, 'error', 'NoMethodError on the module under test means the code is not there');
  assert.match(c.message, /undefined method/);
});

test('rspec: a nil crash is a real observation, not missing code', () => {
  // The other side of NoMethodError, and the reason it cannot be a blanket
  // rule. `undefined method 'fetch' for nil` means the code RAN and hit a
  // nil — the classic Ruby bug a fix like this exists to capture. Calling it
  // "could not run" would throw away a true finding.
  const c = runtime.find((x) => x.name === 'nil handling survives a nil lookup');
  assert.equal(c.type, 'failure');
  assert.match(c.message, /for nil/);
});

test('rspec: a runtime exception from code that exists is a failure', () => {
  const c = runtime.find((x) => x.name === 'nil handling observes a real runtime error');
  assert.equal(c.type, 'failure');
  assert.match(c.message, /ZeroDivisionError/);
});

test('rspec: a spec file that would not load is an error', () => {
  assert.equal(loadError.length, 1);
  assert.equal(loadError[0].type, 'error');
  assert.match(loadError[0].message, /LoadError|cannot load such file/);
  assert.match(loadError[0].name, /broken_spec\.rb/, 'named after the file that failed');
});

test('rspec: an added example that fails an assertion classifies as proven', () => {
  const v = classify({ exitCode: 1, output: '' }, mixed, ['rejects divide by zero']);
  assert.equal(v.outcome, OUTCOME.RED);
  assert.equal(v.reason, 'assertion');
});

test('rspec: an added example reaching for new code is inconclusive', () => {
  // The same report, a different added name. If this returned RED the tool
  // would be handing out false credit on every new Ruby feature.
  const v = classify({ exitCode: 1, output: '' }, mixed, ['is always non-negative']);
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(v.reason, 'load-error');
});

test('rspec: a passing added example is reported as proving nothing', () => {
  const v = classify({ exitCode: 1, output: '' }, mixed, ['divides']);
  assert.equal(v.outcome, OUTCOME.GREEN_ON_BASE);
});

test('rspec: non-rspec input returns null so the caller falls back', () => {
  assert.equal(parseRspecJson('not json'), null);
  assert.equal(parseRspecJson('{"some":"other json"}'), null);
  // jest's report also has no `examples`, so it must not be claimed here.
  assert.equal(parseRspecJson('{"testResults":[],"numTotalTests":0}'), null);
  assert.equal(parseRspecJson(''), null);
});
