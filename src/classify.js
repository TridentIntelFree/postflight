// Deciding what a base-commit test run actually proved.
//
// The naive version of this check — "did the test fail on the old code?" — is
// worse than no check at all, because nearly every new test fails on base.
// Import a function the fix introduced and the test cannot even load, so it
// "fails", and a naive tool calls that proof. It proves only that the test
// touches new code, which is true of almost any new test.
//
// So the question is not whether the test failed on base, but WHY:
//
//   assertion failure  The test ran against the old code, observed it, and
//                      disagreed. This is the real signal.
//   load error         The test never ran. Weak: consistent with capturing a
//                      bug, and equally consistent with capturing nothing.
//   passed             The test runs fine against the unfixed code and is
//                      happy with it. Whatever it tests, it is not the thing
//                      this pull request changed.

import { parseJUnit, summarise } from './junit.js';

export const OUTCOME = {
  RED: 'red',
  WEAK: 'weak',
  GREEN_ON_BASE: 'green-on-base',
  NOT_APPLICABLE: 'not-applicable',
  ERROR: 'error',
};

/**
 * Markers that mean "the test never got to run". Kept per-ecosystem and
 * deliberately specific — a loose pattern here silently downgrades genuine
 * assertion failures to "weak" and hides the signal we exist to find.
 */
const LOAD_ERROR_MARKERS = [
  // Python
  /\bModuleNotFoundError\b/, /\bImportError\b/, /^E\s+ImportError/m,
  /errors? during collection/i, /\bERROR collecting\b/,
  // JS / TS
  /Cannot find module/i, /Cannot find name/i, /\bERR_MODULE_NOT_FOUND\b/,
  /error TS\d+/, /Must use import to load ES Module/i,
  // Go
  /undefined: /, /cannot find package/i, /\[build failed\]/i,
  // Java / Kotlin
  /cannot find symbol/i, /Unresolved reference/i,
  /compilation failed/i, /COMPILATION ERROR/i,
  // Rust
  /error\[E0\d+\]/, /could not compile/i,
  // Ruby
  /\bLoadError\b/, /uninitialized constant/i,
  // C#
  /error CS\d+/,
];

/**
 * Markers that mean a test ran and disagreed. Checked first: a run can emit
 * both (one file fails to import while another genuinely fails), and a real
 * assertion anywhere is the stronger claim.
 */
const ASSERTION_MARKERS = [
  /\bAssertionError\b/, /\bassert\w*\s+failed/i,
  /^\s*FAILED\s/m, /\bFAIL\b/, /✕/, /✗/,
  /expect\(.*\)\..*(?:failed|to (?:be|equal|have))/i,
  /Expected .*(?:but|received|to be)/i,
  /\bAssertionFailedError\b/, /\bComparisonFailure\b/,
  /panic: .*\btest\b/i, /--- FAIL:/,
  /assertion `?left/,
];

/**
 * Classify one base run.
 *
 * @param {object} run           Result of running the tests against base.
 * @param {number} run.exitCode
 * @param {string} run.output    Combined stdout + stderr.
 * @param {string} [junitXml]    Report content, when the runner produced one.
 */
export function classify(run, junitXml) {
  // Structured evidence wins: JUnit XML already separates the two cases, so
  // there is nothing to infer.
  if (junitXml) {
    const s = summarise(parseJUnit(junitXml));
    if (s.total > 0) {
      if (s.hasAssertionFailure) {
        return verdict(OUTCOME.RED, 'assertion', s, junitEvidence(s.failures));
      }
      if (s.hasLoadError) {
        return verdict(OUTCOME.WEAK, 'load-error', s, junitEvidence(s.errors));
      }
      return verdict(OUTCOME.GREEN_ON_BASE, 'passed', s, '');
    }
    // An empty report means the runner collected nothing; fall through to the
    // output heuristics rather than claim the suite passed.
  }

  const output = run.output || '';

  if (run.exitCode === 0) {
    // Guard against a runner that exits 0 having collected no tests at all —
    // that is not the suite passing, it is the suite not running.
    if (/no tests ran|collected 0 items|0 passing|no test files/i.test(output)) {
      return verdict(OUTCOME.WEAK, 'no-tests-collected', null,
        'The runner exited successfully but reported running no tests.');
    }
    return verdict(OUTCOME.GREEN_ON_BASE, 'passed', null, '');
  }

  const assertion = ASSERTION_MARKERS.find((re) => re.test(output));
  if (assertion) {
    return verdict(OUTCOME.RED, 'assertion', null, excerpt(output, assertion));
  }

  const loadError = LOAD_ERROR_MARKERS.find((re) => re.test(output));
  if (loadError) {
    return verdict(OUTCOME.WEAK, 'load-error', null, excerpt(output, loadError));
  }

  // Non-zero exit, nothing recognisable. Say so rather than pick a side:
  // claiming proof we do not have is the one failure this tool must not have.
  return verdict(OUTCOME.WEAK, 'unrecognised', null, excerpt(output));
}

function verdict(outcome, reason, junit, evidence) {
  return { outcome, reason, junit, evidence };
}

function junitEvidence(cases) {
  return cases.slice(0, 5)
    .map((c) => `${c.classname ? c.classname + '.' : ''}${c.name}\n  ${firstLine(c.message)}`)
    .join('\n');
}

function firstLine(text) {
  return (text || '').split('\n').find((l) => l.trim()) || '';
}

/** A readable slice of output around the matched marker. */
function excerpt(output, re = null, radius = 12) {
  const lines = output.split('\n');
  let centre = 0;
  if (re) {
    const idx = lines.findIndex((l) => re.test(l));
    centre = idx === -1 ? 0 : idx;
  } else {
    centre = Math.max(0, lines.length - radius);
  }
  const start = Math.max(0, centre - 3);
  return lines.slice(start, start + radius).join('\n').trim();
}
