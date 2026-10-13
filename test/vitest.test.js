import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJUnit } from '../src/junit.js';
import { classify, OUTCOME } from '../src/classify.js';
import { diagnoseLoadError, missingNames } from '../src/diagnose.js';

// Real vitest JUnit XML, captured by running vitest against a base commit
// that lacks an export the test imports. Committed on purpose: vitest claimed
// `errors="0" failures="1"` and postflight reported "✅ Proven" for a test
// that never executed — the worst error this tool can make, in one of the
// most widely used JS runners.
//
// The cause is a bundler, not vitest's reporter: esbuild rewrites a named
// import to a property access, so a missing export silently becomes
// `undefined` and the only symptom is a TypeError at the call site. There is
// no import error anywhere in the output to recognise.

const XML = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="3" failures="1" errors="0" time="0.007">
    <testsuite name="test/calc.test.js" tests="3" failures="1" errors="0" skipped="0">
        <testcase classname="test/calc.test.js" name="divides" time="0.001"></testcase>
        <testcase classname="test/calc.test.js" name="rejects divide by zero" time="0.001"></testcase>
        <testcase classname="test/calc.test.js" name="modulo is non-negative" time="0.003">
            <failure message="(0 , modulo) is not a function" type="TypeError">
TypeError: (0 , modulo) is not a function
 ❯ test/calc.test.js:7:53
            </failure>
        </testcase>
    </testsuite>
</testsuites>`;

test('vitest: a missing export arrives as a plain TypeError failure', () => {
  // Documenting the shape, because it is the reason message-matching cannot
  // settle this: the report says failure, not error, and it is not lying —
  // from vitest's point of view a function call returned the wrong thing.
  const cases = parseJUnit(XML);
  const c = cases.find((x) => x.name === 'modulo is non-negative');
  assert.equal(c.type, 'failure');
  assert.match(c.message, /is not a function/);

  const v = classify({ exitCode: 1, output: '' }, cases, ['modulo is non-negative']);
  assert.equal(v.outcome, OUTCOME.RED, 'classify alone cannot know better');
});

test('vitest: the name is recovered from the bundler-rewritten message', () => {
  // `(0 , modulo) is not a function` — the name is not adjacent to the
  // phrase, which is why a pattern without the optional paren matched
  // nothing on the output that motivated it.
  assert.deepEqual(missingNames('TypeError: (0 , modulo) is not a function'), ['modulo']);
});

test('vitest: the PR declaring the name is what settles it', () => {
  // Evidence rather than a pattern: if this pull request DECLARES `modulo`,
  // the base commit cannot have had it, so nothing was observed. That
  // reasoning does not depend on the runner, which is the point.
  const d = diagnoseLoadError({
    message: 'TypeError: (0 , modulo) is not a function',
    addedSourceLines: ['export function modulo(a, b) { return ((a % b) + b) % b; }'],
    changedFiles: ['src/calc.js', 'test/calc.test.js'],
  });
  assert.equal(d.kind, 'references-new-code');
  assert.deepEqual(d.names, ['modulo']);
});

test('vitest: a TypeError about code that already exists is NOT downgraded', () => {
  // The other direction, and the reason this is not a blanket rule. A
  // TypeError from code the base commit has is a real observation of old
  // behaviour, and discarding it would throw away a true finding.
  const d = diagnoseLoadError({
    message: 'TypeError: (0 , handler) is not a function',
    addedSourceLines: ['  return value * 2;'],
    changedFiles: ['src/calc.js', 'test/calc.test.js'],
  });
  assert.notEqual(d.kind, 'references-new-code');
});

test('a C-family method declaration counts as introduced', () => {
  // `public static int modulo(int a, int b)` has no declaring keyword, so
  // none of the JS/Python/Ruby patterns see it. Found by auditing Maven,
  // where the diagnosis blamed a missing dependency for a method the pull
  // request plainly added.
  const d = diagnoseLoadError({
    message: 'CalcTest.java:6: error: cannot find symbol\n  symbol:   method modulo(int,int)',
    addedSourceLines: ['    public static int modulo(int a, int b) { return ((a % b) + b) % b; }'],
    changedFiles: ['src/main/java/app/Calc.java'],
  });
  assert.equal(d.kind, 'references-new-code');
});

test('a call is not a declaration', () => {
  // The C-family pattern is a type followed by a name followed by `(`, which
  // an ordinary `return modulo(a, b);` would match without the keyword guard.
  const d = diagnoseLoadError({
    message: 'cannot find symbol\n  symbol:   method modulo(int,int)',
    addedSourceLines: ['        return modulo(a, b);'],
    changedFiles: ['src/main/java/app/Calc.java'],
  });
  assert.notEqual(d.kind, 'references-new-code');
});

test("cargo's unresolved import names the symbol", () => {
  assert.deepEqual(
    missingNames('error[E0432]: unresolved import `cg::modulo`'), ['modulo']);
});
