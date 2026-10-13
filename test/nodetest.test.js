import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJUnit } from '../src/junit.js';
import { classify, OUTCOME } from '../src/classify.js';

// A real JUnit report from node:test, captured by running it against a test
// file that cannot be imported and one that fails an assertion, in the same
// run. Committed on purpose: this file documents a bug that unit tests alone
// did not catch and that reported FALSE PROOF in the field.
//
// node:test never emits <error>. An unimportable file arrives as a
// <failure type="testCodeFailure"> named after the file, indistinguishable at
// a glance from a test that ran and disagreed.

const here = dirname(fileURLToPath(import.meta.url));
const cases = parseJUnit(readFileSync(join(here, 'fixtures', 'nodetest-import-failure.xml'), 'utf8'));

test('node:test: a file that could not be imported is an error, not a failure', () => {
  const c = cases.find((x) => x.name === 'test/a.test.js');
  assert.ok(c, 'the unimportable file should appear as a case');
  assert.equal(c.type, 'error',
    'reported as a <failure>, but nothing ran — reading it as proof is the ' +
    'one conclusion this tool must never reach by accident');
});

test('node:test: a genuine assertion failure is still a failure', () => {
  // The other half of the same report, and the reason the rule has to be
  // narrow: over-correcting here would throw away every true finding.
  const c = cases.find((x) => x.name === 'plain assertion failure');
  assert.equal(c.type, 'failure');
  assert.match(c.message, /Expected values to be strictly equal/);
});

test('node:test: an unimportable test file cannot be credited as proven', () => {
  // End to end, at the level that actually went wrong: postflight reported
  // "✅ Proven" for a test that had never executed.
  const v = classify({ exitCode: 1, output: '' }, cases, ['test/a.test.js']);
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(v.reason, 'load-error');
});

test('node:test: a real failure in the same report is still proven', () => {
  const v = classify({ exitCode: 1, output: '' }, cases, ['plain assertion failure']);
  assert.equal(v.outcome, OUTCOME.RED);
  assert.equal(v.reason, 'assertion');
});

// A second real report, captured by probing what else produces node:test's
// file-level `cause: 'test failed'` entry. It is NOT specific to an import
// failure — the same entry appears for a top-level assertion and for an async
// throw after a test returned. Knowing that bounds how far the correction
// above may be widened.
const other = parseJUnit(
  readFileSync(join(here, 'fixtures', 'nodetest-unattributable.xml'), 'utf8'));

test('node:test: a named test reported as passed survives a file-level failure', () => {
  // The async-leak shape: the file carries a failure entry while the test
  // itself is reported as passing. Reading the file's failure onto the test
  // would invent a verdict for a case that node:test said was fine.
  const t = other.find((c) => c.name === 'leaks an async rejection');
  assert.equal(t.status, 'passed');
  assert.equal(t.type, null);

  const v = classify({ exitCode: 1, output: '' }, other, ['leaks an async rejection']);
  assert.equal(v.outcome, OUTCOME.GREEN_ON_BASE,
    'the test passed on base, whatever else the file did');
});

test('node:test: every unattributable file entry is read as could-not-run', () => {
  // A top-level assertion did run and did disagree, but it is byte-identical
  // in the report to a file that never loaded. Both are reported as errors:
  // the bias costs a true finding at worst, where the other direction hands
  // out false credit.
  for (const name of ['test/toplevel.test.js', 'test/async.test.js']) {
    const c = other.find((x) => x.name === name);
    assert.ok(c, `${name} should appear as a case`);
    assert.equal(c.type, 'error', `${name} is not attributable to a test that ran`);
  }
});
