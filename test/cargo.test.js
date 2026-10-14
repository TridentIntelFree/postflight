import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCargoTest } from '../src/cargotest.js';
import { classify, OUTCOME } from '../src/classify.js';
import { scoreMatch } from '../src/cases.js';

// Real `cargo test` output, captured by running cargo against actual Rust
// code. Committed on purpose: every heuristic bug this project has had came
// from imagining a runner's output rather than looking at it.
//
// cargo was the last runner with no per-case verdicts, which matters more
// than it sounds — without them the verdict falls back to FILE level, and
// file-level scoring was measured over-crediting 24% of pull requests on
// click, crediting authors for failures in tests they did not write.

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => parseCargoTest(readFileSync(join(here, 'fixtures', name), 'utf8'));

const ran = fixture('cargo-assertion.txt');
const didNotCompile = fixture('cargo-compile-failure.txt');

test('cargo: a panicking test is an assertion failure', () => {
  const c = ran.find((x) => x.name === 'tests::clamps_negatives_to_zero');
  assert.equal(c.status, 'failed');
  assert.equal(c.type, 'failure');
  assert.match(c.message, /assertion `left == right` failed/);
  assert.match(c.message, /left: -5/);
});

test('cargo: a passing test in the same run is still reported', () => {
  const c = ran.find((x) => x.name === 'tests::passes_positives_through');
  assert.equal(c.status, 'passed');
  assert.equal(c.type, null);
});

test('cargo: the backtrace is left out of the message', () => {
  // Dozens of lines of rustc internals. The assertion is what a reviewer
  // wants, and a report nobody reads is a check nobody keeps.
  for (const c of ran) {
    assert.ok(!/rust_begin_unwind|stack backtrace/.test(c.message),
      'rustc internals must not reach the report');
  }
});

test('cargo: a crate that did not compile is an error, not proof', () => {
  // In Rust this is the clean case: if the code a test reaches for does not
  // exist, the crate does not compile. So a compile error ALWAYS means the
  // test never ran, and a panic always means it did.
  assert.equal(didNotCompile.length, 1);
  assert.equal(didNotCompile[0].type, 'error');
  assert.match(didNotCompile[0].message, /E0308|mismatched types/);
  assert.match(didNotCompile[0].name, /compile/);
});

test('cargo: an added test that panics on base classifies as proven', () => {
  const v = classify({ exitCode: 101, output: '' }, ran, ['clamps_negatives_to_zero']);
  assert.equal(v.outcome, OUTCOME.RED);
  assert.equal(v.reason, 'assertion');
});

test('cargo: a compile failure classifies as could-not-run', () => {
  const v = classify({ exitCode: 101, output: '' }, didNotCompile, ['clamps_negatives_to_zero']);
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(v.reason, 'load-error');
});

test('cargo: a module path corresponds to the bare test name', () => {
  // cargo reports `tests::clamps_negatives_to_zero`; the diff says
  // `clamps_negatives_to_zero`. Without the `::` rule those match only by
  // substring, which is the path that can pair the wrong case with the
  // wrong name.
  assert.equal(scoreMatch('clamps_negatives_to_zero',
    { name: 'tests::clamps_negatives_to_zero', classname: '' }), 85);
  // Go's subtest separator has the same shape.
  assert.equal(scoreMatch('sub_case', { name: 'TestOuter/sub_case', classname: '' }), 85);
});

test('cargo: an ignored test is skipped, not failed', () => {
  const cases = parseCargoTest('running 1 test\ntest tests::wip ... ignored\n');
  assert.equal(cases[0].status, 'skipped');
  assert.equal(cases[0].type, null);
});

test('cargo: non-cargo input returns null so the caller falls back', () => {
  assert.equal(parseCargoTest('PASS src/a.test.js'), null);
  assert.equal(parseCargoTest(''), null);
  assert.equal(parseCargoTest('some unrelated output'), null);
});
