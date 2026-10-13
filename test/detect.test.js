import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  globToRegExp, selectTestFiles, DEFAULT_PATTERNS,
  countAddedTestCases, isTestDeclaration,
} from '../src/detect.js';

// A bug in here does not announce itself: postflight reports "no test files
// touched", the check goes green, and it looks like it is working. That silent
// no-op is the worst failure this tool can have, so the matcher is pinned down
// harder than its size suggests.

test('glob: * does not cross a path separator', () => {
  const re = globToRegExp('*.test.js');
  assert.ok(re.test('a.test.js'));
  assert.ok(!re.test('src/a.test.js'));
});

test('glob: ** crosses separators', () => {
  const re = globToRegExp('**/*.test.js');
  assert.ok(re.test('a.test.js'), 'matches at the root');
  assert.ok(re.test('src/a.test.js'));
  assert.ok(re.test('src/deep/nested/a.test.js'));
});

test('glob: trailing ** matches a subtree', () => {
  const re = globToRegExp('**/test/**');
  assert.ok(re.test('src/test/java/Foo.java'));
  assert.ok(re.test('test/a.py'));
  assert.ok(!re.test('src/testing/a.py'), 'must not match a merely similar directory');
});

test('glob: braces offer alternatives', () => {
  const re = globToRegExp('**/*.{spec,test}.ts');
  assert.ok(re.test('x.spec.ts'));
  assert.ok(re.test('a/b/x.test.ts'));
  assert.ok(!re.test('x.other.ts'));
});

test('glob: dots are literal, not wildcards', () => {
  const re = globToRegExp('*.test.js');
  assert.ok(!re.test('axtestxjs'), 'a dot must not behave as regex "any character"');
});

test('selection finds the conventions of each ecosystem', () => {
  const changed = [
    'src/calc.js',                       // source, not a test
    'src/calc.test.js',
    'tests/test_calc.py',
    'pkg/calc_test.go',
    'src/test/java/app/CalcTest.java',
    'spec/calc_spec.rb',
    'app/src/test/java/app/x/CalcTest.kt',
    'README.md',
  ];
  const found = selectTestFiles(changed, DEFAULT_PATTERNS);
  assert.deepEqual(found, [
    'app/src/test/java/app/x/CalcTest.kt',
    'pkg/calc_test.go',
    'spec/calc_spec.rb',
    'src/calc.test.js',
    'src/test/java/app/CalcTest.java',
    'tests/test_calc.py',
  ]);
});

test('selection excludes source files that merely sit near tests', () => {
  const found = selectTestFiles(['src/calc.js', 'src/testUtils.js'], DEFAULT_PATTERNS);
  assert.deepEqual(found, []);
});

test('selection is sorted and de-duplicated by path shape', () => {
  // Stability matters: the PR comment is rewritten in place on every re-run,
  // and an unstable order makes identical results look like changes.
  const a = selectTestFiles(['b.test.js', 'a.test.js'], DEFAULT_PATTERNS);
  const b = selectTestFiles(['a.test.js', 'b.test.js'], DEFAULT_PATTERNS);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['a.test.js', 'b.test.js']);
});

test('selection normalises Windows separators and ./ prefixes', () => {
  const found = selectTestFiles(['.\\src\\a.test.js', './src/b.test.js'], DEFAULT_PATTERNS);
  assert.deepEqual(found, ['src/a.test.js', 'src/b.test.js']);
});

test('a custom pattern replaces the defaults rather than adding to them', () => {
  const changed = ['src/a.test.js', 'weird/thing.checks.js'];
  const found = selectTestFiles(changed, ['**/*.checks.js']);
  assert.deepEqual(found, ['weird/thing.checks.js']);
});

// --- net new test cases -----------------------------------------------------
//
// This gate is what stops the check accusing innocent pull requests. Measured
// against 24 real commits of an established project it turned nine false
// alarms into silence, so it is pinned down accordingly.

test('recognises a test declaration in each ecosystem', () => {
  const decls = [
    "  it('does a thing', () => {",
    '  test("does a thing", async () => {',
    '    describe("a group", function () {',
    '    def test_divides(self):',
    '    func TestDivide(t *testing.T) {',
    '    @Test',
    '    #[test]',
    '    [Fact]',
  ];
  for (const d of decls) assert.ok(isTestDeclaration(d), `should recognise: ${d.trim()}`);
});

test('does not mistake ordinary code for a test declaration', () => {
  const notTests = [
    '  const result = divide(6, 2);',
    '  // it is important to handle zero',
    '  return items.filter(x => x.test);',
    '  await submit(form);',
  ];
  for (const line of notTests) {
    assert.ok(!isTestDeclaration(line), `should NOT match: ${line.trim()}`);
  }
});

test('a genuinely added test counts', () => {
  const added = ["  it('rejects divide by zero', () => {", '    assert.throws(fn);'];
  assert.equal(countAddedTestCases(added, []), 1);
});

test('a RENAMED test counts as nothing new', () => {
  // The case that mattered: renaming a test title adds one declaration and
  // removes one. Counting only additions fires "not proven" at someone who
  // fixed a typo.
  const added = ["  it('should pass-through middleware', function (done) {"];
  const removed = ["  it('should pass-though middleware', function (done) {"];
  assert.equal(countAddedTestCases(added, removed), 0);
});

test('a deleted test counts as nothing new', () => {
  const removed = ["  it('no longer relevant', () => {"];
  assert.equal(countAddedTestCases([], removed), 0);
});

test('adding two while removing one counts as one', () => {
  const added = ["it('a', () => {", "it('b', () => {"];
  const removed = ["it('old', () => {"];
  assert.equal(countAddedTestCases(added, removed), 1);
});

test('never returns a negative count', () => {
  const removed = ["it('a', () => {", "it('b', () => {"];
  assert.equal(countAddedTestCases([], removed), 0);
});
