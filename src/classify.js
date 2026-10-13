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
import { matchCases, summariseCases } from './cases.js';

export const OUTCOME = {
  RED: 'red',
  INCONCLUSIVE: 'inconclusive',
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
  // Node ESM's wording when a named export is missing — the single most
  // likely way a test meets a base commit that lacks the code it imports.
  // Found by running the action, not by reasoning about it: the markers
  // above were written from assumption and all missed this.
  /does not provide an export named/, /\bERR_UNKNOWN_FILE_EXTENSION\b/,
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
 * @param {string|object[]} [report] Either JUnit XML, or cases already
 *   parsed from a runner's own structured output. Both arrive here in the
 *   same shape, so nothing downstream needs to know which runner ran.
 * @param {string[]} [addedNames] Names of the test cases this pull request
 *   adds. When these can be matched against the report, the verdict is about
 *   those cases alone — which is both more precise and more correct, since
 *   scoring the whole file credits the author for tests they did not write.
 */
export function classify(run, report, addedNames = []) {
  // Before anything else: did the command run at all? A test runner that was
  // never found says nothing about the tests, and reporting "inconclusive"
  // for it hides a setup problem behind a verdict. This is the first wall
  // every non-Node project hits, because the interpreter or virtualenv the
  // command names is not in the base worktree.
  if (isCommandUnavailable(run)) {
    return verdict(OUTCOME.ERROR, 'command-unavailable', null,
      [
        excerpt(run.output || '', /not found|No such file|cannot execute/i, 6),
        '',
        'The test command could not run inside the base worktree, which is a',
        'fresh checkout and does not inherit the job\'s installed tooling.',
        'Either link what it needs:',
        '',
        '    link-paths: |',
        '      .venv',
        '      node_modules',
        '',
        'or install it there:',
        '',
        '    setup-command: pip install -e .',
      ].join('\n'));
  }

  // Structured evidence wins: JUnit XML already separates the two cases, so
  // there is nothing to infer.
  const hasReport = Array.isArray(report) ? report.length > 0 : !!report;
  if (hasReport) {
    const parsed = Array.isArray(report) ? report : parseJUnit(report);

    // Per-case first: a verdict about the cases the pull request actually
    // added beats one about every test that happens to share their file.
    if (addedNames.length > 0 && parsed.length > 0) {
      const perCase = summariseCases(matchCases(addedNames, parsed));
      if (perCase.usable) return fromCases(perCase);
    }

    const s = summarise(parsed);
    if (s.total > 0) {
      if (s.hasAssertionFailure) {
        return verdict(OUTCOME.RED, 'assertion', s, junitEvidence(s.failures));
      }
      if (s.hasLoadError) {
        return verdict(OUTCOME.INCONCLUSIVE, 'load-error', s, junitEvidence(s.errors));
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
      return verdict(OUTCOME.INCONCLUSIVE, 'no-tests-collected', null,
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
    return verdict(OUTCOME.INCONCLUSIVE, 'load-error', null, excerpt(output, loadError));
  }

  // Non-zero exit, nothing recognisable. Say so rather than pick a side:
  // claiming proof we do not have is the one failure this tool must not have.
  return verdict(OUTCOME.INCONCLUSIVE, 'unrecognised', null, excerpt(output));
}

/**
 * Did the shell fail to find the command, rather than the tests failing?
 * Deliberately narrow: exit 127 is the shell's own "not found" code, and the
 * message patterns are anchored so a test that merely PRINTS "not found"
 * cannot be mistaken for one.
 */
function isCommandUnavailable(run) {
  if (run.exitCode === 127) return true;
  const out = run.output || '';
  return /^[^\n]*(?:command not found|: not found|No such file or directory)\s*$/m.test(out)
    && out.split('\n').filter((l) => l.trim()).length <= 3;
}

/**
 * A verdict built from the pull request's own test cases.
 *
 * One proven case is enough to say the change is captured, but the others are
 * still reported: "adds 3, 2 proven, 1 passes on base" is actionable in a way
 * that a single word never is.
 */
function fromCases(c) {
  const lines = [];
  const list = (label, items) => {
    if (!items.length) return;
    lines.push(`${label}:`);
    for (const r of items) {
      lines.push(`  ${r.name}${r.message ? ` — ${firstLine(r.message)}` : ''}`);
    }
  };

  list('Failed on base (captures the change)', c.proven);
  list('Passed on base (proves nothing)', c.passed);
  list('Could not run on base', c.loadErrors);
  if (c.unmatched.length) {
    lines.push('Not found in the test report:');
    for (const r of c.unmatched) lines.push(`  ${r.name}`);
  }

  const evidence = lines.join('\n');
  const v = (outcome, reason) => ({ outcome, reason, junit: null, evidence, cases: c });

  if (c.proven.length > 0) return v(OUTCOME.RED, 'assertion');
  if (c.passed.length > 0 && c.loadErrors.length === 0) {
    return v(OUTCOME.GREEN_ON_BASE, 'passed');
  }
  if (c.loadErrors.length > 0) return v(OUTCOME.INCONCLUSIVE, 'load-error');
  return v(OUTCOME.INCONCLUSIVE, 'unrecognised');
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
