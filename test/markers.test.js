import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterizationNames, extractTestNames } from '../src/cases.js';

// The intent problem cannot be solved by analysis: a test written for
// behaviour that already works is indistinguishable from an untested fix.
// Measured on cobra, TWO of its four accusations are pull requests whose
// stated purpose is adding tests for existing code — "Add tests for funcs in
// cobra.go" and "Add tests for flag completion registration". `green-on-base`
// is accurate for both, and blocking either would be wrong.
//
// So the author gets to say which it is. The marker is read from the lines
// the pull request ADDS, so it must be part of the change.

test('a marker above a test marks that test', () => {
  const marked = characterizationNames([
    '// postflight: characterization',
    "test('divides evenly', () => {",
    '  expect(divide(6, 2)).toBe(3);',
    '});',
  ]);
  assert.deepEqual(marked, ['divides evenly']);
});

test('the three places people actually write it all work', () => {
  const above = characterizationNames([
    '# postflight: characterization',
    'def test_formats_output():',
  ]);
  const sameLine = characterizationNames([
    "test('formats output', () => {   // postflight: characterization",
  ]);
  const inBody = characterizationNames([
    "test('formats output', () => {",
    '  // postflight: characterization',
    '  expect(format(1)).toBe("1");',
  ]);
  for (const [where, got] of [['above', above], ['same line', sameLine], ['in body', inBody]]) {
    assert.equal(got.length, 1, `${where}: expected one marked case, got ${JSON.stringify(got)}`);
  }
});

test('a marker does not reach past the test it sits next to', () => {
  // The whole point is that it is per case. A marker that leaked onto a
  // sibling would silence a test the author never meant to exclude.
  const lines = [
    '// postflight: characterization',
    "test('characterized', () => { expect(a()).toBe(1); });",
    '',
    '',
    '',
    '',
    "test('captures the fix', () => { expect(() => b()).toThrow(); });",
  ];
  assert.deepEqual(characterizationNames(lines), ['characterized']);
  assert.deepEqual(extractTestNames(lines), ['characterized', 'captures the fix']);
});

test('only the marked case is excluded, the rest are still judged', () => {
  const lines = [
    "test('new behaviour', () => { expect(() => f()).toThrow(); });",
    '// postflight: characterization',
    "test('old behaviour, now covered', () => { expect(g()).toBe(1); });",
  ];
  const marked = characterizationNames(lines);
  const judged = extractTestNames(lines).filter((n) => !marked.includes(n));
  assert.deepEqual(marked, ['old behaviour, now covered']);
  assert.deepEqual(judged, ['new behaviour'],
    'a pull request that marks one test must still be judged on the others');
});

test('the spellings people will actually type are accepted', () => {
  const variants = [
    '// postflight: characterization',
    '// postflight: characterisation',
    '# postflight: ignore',
    '-- postflight: skip',
    '// postflight-characterization',
    '/* POSTFLIGHT: CHARACTERIZATION */',
  ];
  for (const marker of variants) {
    assert.deepEqual(
      characterizationNames([marker, "test('x', () => {})"]), ['x'],
      `should accept: ${marker}`);
  }
});

test('an unrelated mention of postflight is not a marker', () => {
  // The word turns up in READMEs, commit messages and the action's own
  // config. Treating any mention as a marker would silence tests by accident.
  for (const line of [
    '// see the postflight docs for details',
    '// uses postflight in CI',
    "test('postflight reports correctly', () => {})",
  ]) {
    assert.deepEqual(characterizationNames([line, "test('x', () => {})"]), [],
      `should not be a marker: ${line}`);
  }
});

test('a marker with no test near it marks nothing', () => {
  assert.deepEqual(characterizationNames(['// postflight: characterization']), []);
  assert.deepEqual(characterizationNames([]), []);
});

test('a marker far from any test does not reach the nearest one', () => {
  // "Nearest declaration wins" alone is not enough: without a distance
  // limit, a marker written anywhere in the diff — in a docstring, a comment
  // block, an unrelated helper — would silence whichever test happened to be
  // closest, however far away. Found by mutation: deleting the window
  // survived the suite, because every other test here has a test nearby.
  const lines = [
    '// postflight: characterization',
    ...Array(20).fill('  // explaining something unrelated'),
    "test('captures the fix', () => { expect(() => f()).toThrow(); });",
  ];
  assert.deepEqual(characterizationNames(lines), [],
    'a marker 21 lines from a test marks nothing');
  assert.deepEqual(extractTestNames(lines), ['captures the fix']);
});
