// Checking that a verdict reproduces before standing behind it.
//
// A test that fails on base intermittently fails on base for reasons of its
// own, and crediting that as evidence is the most damaging thing this check
// can get wrong: it tells you a test has teeth when it does not.
//
// This lives in its own module for one reason. The logic began inside main(),
// where nothing could import it and therefore nothing could test it — and it
// carried a real bug for four releases: the verdict can come from the
// narrowed run OR from the whole-file fallback, and confirmation re-ran
// `narrowing || testCommand` regardless. After a fallback it compared the
// full run's verdict against the narrowed run's and called the difference
// "not reproducible", destroying 4 true findings in 30 cobra commits.
//
// Mutation testing found the gap before this move: reintroducing the wrong
// command survived the whole suite, because the suite could not reach it.

import { OUTCOME } from './classify.js';

/**
 * Which verdicts are worth paying a second run for.
 *
 * RED always: it is the verdict that claims something. GREEN_ON_BASE only
 * when the test samples without seeding — normally it costs a run on every
 * pull request that has nothing wrong with it, but an unseeded test that
 * passed on base by luck produces a false ACCUSATION just as readily as a
 * sampled failure produces false credit.
 */
export function shouldConfirm(outcome, determinismRisk) {
  if (outcome === OUTCOME.RED) return true;
  return outcome === OUTCOME.GREEN_ON_BASE && determinismRisk === 'unseeded';
}

/**
 * Re-run a verdict and keep it only if it holds.
 *
 * @param {object}   options
 * @param {object}   options.verdict       The verdict to check.
 * @param {string}   options.command       The command that PRODUCED it. Not
 *   "the narrowed command" and not "the configured command" — the one that
 *   actually ran, or this compares two different things.
 * @param {number}   options.confirmations How many repeats must agree.
 * @param {Function} options.rerun         `(command) => Promise<verdict>`.
 *   Takes the command so the caller cannot quietly substitute another, and
 *   so this is testable without running anything.
 * @param {object}   [options.log]
 */
export async function confirmVerdict({ verdict, command, confirmations, rerun, log }) {
  if (!(confirmations > 0) || !command) return verdict;

  const expected = verdict.outcome;
  for (let i = 1; i <= confirmations; i++) {
    log?.info?.(`Confirming the result is reproducible (${i}/${confirmations})…`);
    const repeat = await rerun(command);
    if (repeat.outcome !== expected) {
      log?.warn?.(`The base result did not reproduce (${expected} then ${repeat.outcome}).`);
      return {
        outcome: OUTCOME.INCONCLUSIVE,
        reason: 'not-reproducible',
        evidence:
          `The tests reported ${expected} against base on the first run and ` +
          `${repeat.outcome} on a repeat. A result that does not reproduce is ` +
          'not evidence either way, in either direction.',
      };
    }
  }
  return verdict;
}
