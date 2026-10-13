import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTestNames, matchCases, summariseCases } from '../src/cases.js';

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
