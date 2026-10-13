import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTestNames, matchCases, summariseCases, scoreMatch } from '../src/cases.js';

// Name extraction is the load-bearing part: a name that is not extracted
// silently drops its test from the verdict, and a verdict built from a subset
// of the added tests is worse than no verdict at all.

test('extracts JS test names', () => {
  const names = extractTestNames([
    "  it('rejects divide by zero', () => {",
    '  test("handles unicode", async () => {',
    "  it.each([1, 2])('handles %i', (n) => {",
  ]);
  assert.deepEqual(names, ['rejects divide by zero', 'handles unicode', 'handles %i']);
});

test('a describe block is a group, not a case', () => {
  // `describe` counts towards "did this pull request add tests" in detect.js,
  // but it is not a case: it cannot pass or fail on its own and will never
  // appear in runner output as a result. Naming it here would add a case that
  // can never be matched, which reads as a missing test.
  assert.deepEqual(extractTestNames(['  describe(`a group`, function () {']), []);
});

test('extracts Python and Go test names', () => {
  const names = extractTestNames([
    '    def test_divides(self):',
    'func TestDivideByZero(t *testing.T) {',
    'func BenchmarkParse(b *testing.B) {',
  ]);
  assert.deepEqual(names, ['test_divides', 'TestDivideByZero', 'BenchmarkParse']);
});

test('extracts annotated test names declared on a later line', () => {
  // The name is not on the annotation line, so this needs a forward scan.
  const names = extractTestNames([
    '    @Test',
    '    public void dividesCleanly() {',
    '    #[test]',
    '    fn rejects_zero() {',
  ]);
  assert.deepEqual(names, ['dividesCleanly', 'rejects_zero']);
});

test('ignores ordinary code', () => {
  assert.deepEqual(extractTestNames([
    '  const result = divide(6, 2);',
    '  // it("looks like a test") but is a comment',
    '  return x;',
  ]).length <= 1, true);
});

test('de-duplicates repeated names', () => {
  const names = extractTestNames([
    "it('same', () => {",
    "it('same', () => {",
  ]);
  assert.deepEqual(names, ['same']);
});

// --- matching against runner output ----------------------------------------

const cases = [
  { name: 'rejects divide by zero', classname: 'calc', status: 'failed', type: 'failure', message: 'expected throw' },
  { name: 'divides', classname: 'calc', status: 'passed', type: null, message: '' },
  { name: 'test_loads', classname: 'tests.test_mod', status: 'failed', type: 'error', message: 'ImportError' },
];

test('matches an added name to its result', () => {
  const r = matchCases(['rejects divide by zero'], cases);
  assert.equal(r[0].matched, true);
  assert.equal(r[0].type, 'failure');
});

test('matches despite runner decoration of the name', () => {
  // Runners prefix suites and append parameters; an exact-match-only
  // implementation drops these silently.
  const decorated = [
    { name: 'calc > divides cleanly', classname: '', status: 'passed', type: null, message: '' },
    { name: 'test_rounds[0.1-0.2]', classname: 'tests', status: 'passed', type: null, message: '' },
  ];
  assert.equal(matchCases(['divides cleanly'], decorated)[0].matched, true);
  assert.equal(matchCases(['test_rounds'], decorated)[1 - 1].matched, true);
});

test('reports an unmatched name rather than guessing', () => {
  const r = matchCases(['a test that never ran'], cases);
  assert.equal(r[0].matched, false);
  assert.equal(r[0].status, 'unknown');
});

test('summary counts only assertion failures as proven', () => {
  const s = summariseCases(matchCases(
    ['rejects divide by zero', 'divides', 'test_loads'], cases
  ));
  assert.equal(s.proven.length, 1, 'only the assertion failure is proof');
  assert.equal(s.loadErrors.length, 1, 'the import error is not proof');
  assert.equal(s.passed.length, 1);
  assert.equal(s.usable, true);
});

test('summary is unusable when nothing matched', () => {
  // The caller must fall back to judging the whole file rather than invent a
  // verdict from zero evidence.
  const s = summariseCases(matchCases(['nothing like this'], cases));
  assert.equal(s.usable, false);
});

test('summary is usable when only some names matched', () => {
  const s = summariseCases(matchCases(['divides', 'nothing like this'], cases));
  assert.equal(s.usable, true);
  assert.equal(s.unmatched.length, 1);
});

// --- matching precision ----------------------------------------------------
//
// A wrong match is worse than no match: it hands a case the verdict belonging
// to a different test, silently. These pin down the two ways that happens.

const mk = (name, status, type = null, classname = '') =>
  ({ name, classname, status, type, message: '' });

test('an exact match beats a substring match that comes first', () => {
  // `test_parse_unicode` contains `test_parse`. First-match-wins would pair
  // the added `test_parse` with it and report the wrong result.
  const junit = [
    mk('test_parse_unicode', 'failed', 'failure'),
    mk('test_parse', 'passed'),
  ];
  const r = matchCases(['test_parse'], junit);
  assert.equal(r[0].status, 'passed', 'must pair with the exact name, not the longer one');
});

test('two overlapping names do not claim the same reported case', () => {
  // Without one-to-one assignment both added names grab `test_parse_unicode`
  // and one of them inherits a verdict it did not earn.
  const junit = [
    mk('test_parse', 'passed'),
    mk('test_parse_unicode', 'failed', 'failure'),
  ];
  const r = matchCases(['test_parse', 'test_parse_unicode'], junit);
  assert.equal(r[0].status, 'passed');
  assert.equal(r[1].status, 'failed');
  assert.equal(r[1].type, 'failure');
});

test('pytest parameterisation outranks a loose substring', () => {
  const junit = [
    mk('test_rounds_badly', 'passed'),
    mk('test_rounds[0.1-0.2]', 'failed', 'failure'),
  ];
  const r = matchCases(['test_rounds'], junit);
  assert.equal(r[0].type, 'failure');
});

test('a mocha suite prefix still matches', () => {
  const junit = [mk('calc > divides cleanly', 'failed', 'failure')];
  const r = matchCases(['divides cleanly'], junit);
  assert.equal(r[0].matched, true);
  assert.equal(r[0].type, 'failure');
});

test('scoring ranks exact above decorated above substring', () => {
  const name = 'test_parse';
  const exact = scoreMatch(name, mk('test_parse', 'passed'));
  const param = scoreMatch(name, mk('test_parse[a]', 'passed'));
  const sub = scoreMatch(name, mk('test_parse_unicode_and_more', 'passed'));
  const none = scoreMatch(name, mk('completely_different', 'passed'));
  assert.ok(exact > param, 'exact beats parameterised');
  assert.ok(param > sub, 'parameterised beats loose substring');
  assert.ok(sub > none, 'loose substring beats nothing');
  assert.equal(none, 0);
});

test('two names competing for ONE case: only one may have it', () => {
  // Both added names contain `test_parse`, so both score against the single
  // reported case. Without one-to-one assignment they BOTH claim it and both
  // inherit its failure — manufacturing proof for a test that never ran.
  //
  // An earlier version of this test used names with distinct exact matches,
  // so dropping the constraint changed nothing and the test passed against
  // broken code. Caught by mutating the source, not by reading it.
  const junit = [mk('test_parse', 'failed', 'failure')];
  const r = matchCases(['test_parse_alpha', 'test_parse_beta'], junit);
  const matched = r.filter((x) => x.matched);
  assert.equal(matched.length, 1, 'exactly one name may claim the only reported case');
  assert.equal(r.filter((x) => x.type === 'failure').length, 1,
    'the failure must not be credited twice');
});

test('a name with no corresponding case is unmatched', () => {
  const junit = [mk('test_a', 'passed')];
  const r = matchCases(['test_a', 'completely_unrelated'], junit);
  assert.equal(r[0].matched, true);
  assert.equal(r[1].matched, false);
});

// --- narrowing safety ------------------------------------------------------
//
// Narrowing runs only the cases a pull request adds. The danger is a filter
// that matches nothing: the run succeeds, a report exists, and it says
// nothing about the tests in question. That is indistinguishable from a real
// result unless something checks, which is what these cover.

import { coversAny, hasLoadError } from '../src/cases.js';

test('coversAny is true when the report includes an added case', () => {
  const cases = [mk('rejects divide by zero', 'failed', 'failure'), mk('unrelated', 'passed')];
  assert.equal(coversAny(cases, ['rejects divide by zero']), true);
});

test('coversAny is false when the filter matched nothing', () => {
  // The report is full of OTHER tests. Without this check the verdict would
  // be built from tests the pull request never touched.
  const cases = [mk('something else entirely', 'passed'), mk('and another', 'passed')];
  assert.equal(coversAny(cases, ['rejects divide by zero']), false);
});

test('coversAny is false for an empty report', () => {
  assert.equal(coversAny([], ['anything']), false);
});

test('coversAny is false when nothing was added', () => {
  assert.equal(coversAny([mk('a', 'passed')], []), false);
});

test('hasLoadError distinguishes never-ran from ran-and-failed', () => {
  // Decides whether falling back to the whole file could tell us anything
  // new. A suite that will not load will not load any slower.
  assert.equal(hasLoadError([mk('a', 'failed', 'error')]), true);
  assert.equal(hasLoadError([mk('a', 'failed', 'failure')]), false);
  assert.equal(hasLoadError([mk('a', 'passed')]), false);
  assert.equal(hasLoadError([]), false);
});
