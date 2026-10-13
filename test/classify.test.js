import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJUnit, summarise } from '../src/junit.js';
import { classify, OUTCOME } from '../src/classify.js';

// The distinction this Action exists to draw: <failure> is an assertion that
// did not hold, <error> is a test that never ran. Treating them alike is the
// bug that makes a tool like this worse than useless.

test('JUnit: an assertion failure is a failure, not an error', () => {
  const cases = parseJUnit(`
    <testsuite>
      <testcase classname="t.Calc" name="adds">
        <failure message="expected 4, got 5">at Calc.java:12</failure>
      </testcase>
    </testsuite>`);
  const s = summarise(cases);
  assert.equal(s.hasAssertionFailure, true);
  assert.equal(s.hasLoadError, false);
  assert.match(s.failures[0].message, /expected 4/);
});

test('JUnit: a load error is an error, not a failure', () => {
  const s = summarise(parseJUnit(`
    <testsuite>
      <testcase classname="t.Calc" name="adds">
        <error message="ImportError: cannot import name divide">traceback</error>
      </testcase>
    </testsuite>`));
  assert.equal(s.hasLoadError, true);
  assert.equal(s.hasAssertionFailure, false);
});

test('JUnit: self-closing testcases parse as passes', () => {
  const s = summarise(parseJUnit(`
    <testsuite>
      <testcase classname="t" name="a"/>
      <testcase classname="t" name="b"></testcase>
      <testcase classname="t" name="c"><skipped/></testcase>
    </testsuite>`));
  assert.equal(s.total, 3);
  assert.equal(s.passed, 2);
  assert.equal(s.skipped, 1);
});

test('JUnit: entities and CDATA are decoded', () => {
  const s = summarise(parseJUnit(`
    <testsuite>
      <testcase name="x">
        <failure message="expected &lt;a&gt; &amp; &quot;b&quot;"><![CDATA[raw <tag>]]></failure>
      </testcase>
    </testsuite>`));
  assert.match(s.failures[0].message, /expected <a> & "b"/);
  assert.match(s.failures[0].message, /raw <tag>/);
});

test('JUnit evidence beats output heuristics', () => {
  // Output that looks like a load error, XML that says assertion. The
  // structured evidence must win, otherwise the heuristics silently
  // downgrade real signal to "inconclusive".
  const xml = `<testsuite><testcase name="a"><failure message="nope"/></testcase></testsuite>`;
  const v = classify({ exitCode: 1, output: 'ImportError: cannot find module' }, xml);
  assert.equal(v.outcome, OUTCOME.RED);
  assert.equal(v.reason, 'assertion');
});

test('classify: assertion failure on base is the strong result', () => {
  const v = classify({ exitCode: 1, output: 'FAILED test_divide\nAssertionError: 2 != 3' });
  assert.equal(v.outcome, OUTCOME.RED);
  assert.equal(v.reason, 'assertion');
});

test('classify: an import error on base proves nothing', () => {
  const v = classify({
    exitCode: 1,
    output: 'ModuleNotFoundError: No module named "app.divide"',
  });
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(v.reason, 'load-error');
});

test('classify: a missing ESM named export is a load error', () => {
  // Node's actual wording, captured by running the action against a base
  // commit that lacked the imported function. The hand-written markers all
  // missed it, and only the catch-all kept the verdict honest.
  const v = classify({
    exitCode: 1,
    output: "SyntaxError: The requested module '../src/calc.js' does not provide an export named 'modulo'",
  });
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(v.reason, 'load-error');
});

test('classify: passing on base is the finding', () => {
  const v = classify({ exitCode: 0, output: '12 passed in 0.4s' });
  assert.equal(v.outcome, OUTCOME.GREEN_ON_BASE);
});

test('classify: exit 0 having collected nothing is not a pass', () => {
  // A runner handed a file it cannot collect may exit 0. Calling that
  // "passed on base" would report a false finding against the author.
  const v = classify({ exitCode: 0, output: 'collected 0 items\n\nno tests ran in 0.01s' });
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(v.reason, 'no-tests-collected');
});

test('classify: assertion wins when a run has both', () => {
  const v = classify({
    exitCode: 1,
    output: [
      'ERROR collecting tests/test_new.py',
      'ImportError: cannot import name shiny',
      'FAILED tests/test_old.py::test_rounding',
      'AssertionError: 0.1 + 0.2 != 0.3',
    ].join('\n'),
  });
  assert.equal(v.outcome, OUTCOME.RED, 'a real assertion anywhere is the stronger claim');
});

test('classify: an unrecognised failure is not reported as proof', () => {
  const v = classify({ exitCode: 137, output: 'Killed' });
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(v.reason, 'unrecognised');
});
