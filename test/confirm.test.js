import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmVerdict, shouldConfirm } from '../src/confirm.js';
import { OUTCOME } from '../src/classify.js';

// This logic carried a real bug for four releases and the suite could not
// reach it, because it lived inside main() where nothing could import it.
// Mutation testing proved that: reintroducing the wrong command survived the
// whole suite. Moving it here is the fix for the gap, not just the bug.

const red = { outcome: OUTCOME.RED, reason: 'assertion' };
const green = { outcome: OUTCOME.GREEN_ON_BASE, reason: 'passed' };

test('confirmation re-runs exactly the command it was given', () => {
  // The bug: the verdict can come from the narrowed run or from the
  // whole-file fallback, and confirmation always re-ran `narrowing ||
  // testCommand`. After a fallback that compares two different commands and
  // calls the difference "not reproducible" — which destroyed 4 true
  // findings in 30 cobra commits.
  const used = [];
  return confirmVerdict({
    verdict: red,
    command: 'pytest tests/a.py',
    confirmations: 2,
    rerun: async (command) => { used.push(command); return red; },
  }).then((v) => {
    assert.deepEqual(used, ['pytest tests/a.py', 'pytest tests/a.py']);
    assert.equal(v.outcome, OUTCOME.RED, 'a result that holds is kept');
  });
});

test('a verdict that does not reproduce is neither credited nor an accusation', async () => {
  const v = await confirmVerdict({
    verdict: red,
    command: 'x',
    confirmations: 1,
    rerun: async () => green,
  });
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(v.reason, 'not-reproducible');
  assert.match(v.evidence, /red.*first run/);
  assert.match(v.evidence, /not evidence either way, in either direction/);
});

test('an accusation that does not reproduce is dropped too', async () => {
  // The direction that was missing until sampled tests made it obvious:
  // green-on-base is the verdict that accuses the author.
  const v = await confirmVerdict({
    verdict: green,
    command: 'x',
    confirmations: 1,
    rerun: async () => red,
  });
  assert.equal(v.outcome, OUTCOME.INCONCLUSIVE);
  assert.equal(v.reason, 'not-reproducible');
});

test('it stops at the first disagreement rather than running them all', async () => {
  let runs = 0;
  await confirmVerdict({
    verdict: red,
    command: 'x',
    confirmations: 5,
    rerun: async () => { runs += 1; return green; },
  });
  assert.equal(runs, 1);
});

test('no command means nothing to re-run, not a silent full-suite run', async () => {
  // Guarding the shape of the bug: if the caller cannot say which command
  // produced the verdict, confirming is not possible and inventing one would
  // reintroduce exactly the defect this module exists to prevent.
  let ran = false;
  const v = await confirmVerdict({
    verdict: red, command: null, confirmations: 3,
    rerun: async () => { ran = true; return green; },
  });
  assert.equal(ran, false);
  assert.equal(v, red);
});

test('zero confirmations is honoured', async () => {
  let ran = false;
  const v = await confirmVerdict({
    verdict: red, command: 'x', confirmations: 0,
    rerun: async () => { ran = true; return green; },
  });
  assert.equal(ran, false);
  assert.equal(v, red);
});

test('which verdicts are worth a second run', () => {
  assert.equal(shouldConfirm(OUTCOME.RED, 'none'), true, 'RED claims something');
  assert.equal(shouldConfirm(OUTCOME.GREEN_ON_BASE, 'none'), false,
    'an ordinary pass costs a run on every clean pull request');
  assert.equal(shouldConfirm(OUTCOME.GREEN_ON_BASE, 'unseeded'), true,
    'a sampled accusation can be luck');
  assert.equal(shouldConfirm(OUTCOME.INCONCLUSIVE, 'unseeded'), false);
  assert.equal(shouldConfirm(OUTCOME.NOT_APPLICABLE, 'unseeded'), false);
});
