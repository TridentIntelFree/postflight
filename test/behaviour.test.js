import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNonBehavioural, changesBehaviour } from '../src/behaviour.js';

// This gate only ever silences the check, so a wrong answer costs a missed
// finding rather than a false accusation. The tests below pin that asymmetry
// down: anything ambiguous must be treated as behavioural.

test('comments and blank lines cannot change behaviour', () => {
  const inert = [
    '',
    '   ',
    '// a C-style comment',
    '  /* block open',
    '   * continuation',
    '   */',
    '# a Python or shell comment',
    '-- a SQL comment',
    '; a lisp comment',
    '"""',
    "'''",
    '  }',
    '  });',
  ];
  for (const line of inert) {
    assert.ok(isNonBehavioural(line), `should be inert: ${JSON.stringify(line)}`);
  }
});

test('real code is behavioural', () => {
  const live = [
    'const x = 1;',
    '  if (b === 0) throw new RangeError();',
    '  return a / b;  // with a trailing comment',
    '    def divide(a, b):',
    '  x = 1  # trailing comment does not make the line inert',
    'import os',
  ];
  for (const line of live) {
    assert.ok(!isNonBehavioural(line), `should be behavioural: ${JSON.stringify(line)}`);
  }
});

test('a documentation-only change is not behavioural', () => {
  // The real case this exists for: a commit whose whole source diff was
  // JSDoc. The added test passed on base because nothing had changed, and
  // reporting "not proven" was accurate and useless.
  const added = [
    ' * Checks if the specified `charset`s are acceptable.',
    ' * @param {String} ...charset',
    ' *',
  ];
  const removed = [' * Check if the given `charset`s are acceptable.'];
  assert.equal(changesBehaviour(added, removed), false);
});

test('one real line among comments is still behavioural', () => {
  const added = [' * updated the docs', '  if (b === 0) return null;'];
  assert.equal(changesBehaviour(added, []), true);
});

test('an empty source diff is treated as behavioural', () => {
  // Not ours to interpret: something unusual is going on, and the safe
  // direction is to let the check run rather than silently skip it.
  assert.equal(changesBehaviour([], []), true);
});

test('a removal of real code is behavioural', () => {
  assert.equal(changesBehaviour([], ['  return cached;']), true);
});
