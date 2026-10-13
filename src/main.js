// postflight — prove a pull request's new tests actually fail without its fix.
//
//   1. find the test files this pull request touches
//   2. build the base commit's source with those tests laid over it
//   3. run them
//   4. say what that proved, and how strongly

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { input, boolInput, listInput, setOutput, summary, log, eventPayload } from './core.js';
import { DEFAULT_PATTERNS, selectTestFiles, countAddedTestCases } from './detect.js';
import { extractTestNames, characterizationNames, coversAny, hasLoadError } from './cases.js';
import { toCases } from './junit.js';
import { detectRunner } from './runners.js';
import { diagnoseLoadError, isDependencyFile } from './diagnose.js';
import { analyseDeterminism, confirmationsFor } from './nondeterminism.js';
import { confirmVerdict, shouldConfirm } from './confirm.js';
import { assertHistory, changedFiles, changedLines, buildBaseWorktree } from './worktree.js';
import { runTests, collectJUnit } from './run.js';
import { classify, OUTCOME } from './classify.js';
import { changesBehaviour } from './behaviour.js';
import { buildReport, postComment } from './report.js';

const POLICY = { fail: 'fail', warn: 'warn', pass: 'pass' };

async function main() {
  // An explicit command always wins; detection only fills the gap.
  let testCommand = input('test-command');
  let runner = null;
  if (!testCommand) {
    runner = await detectRunner();
    if (!runner) {
      throw new Error(
        'Could not work out how to run this project\'s tests, so `test-command` is required:\n\n' +
        '    with:\n' +
        '      test-command: <your runner> {files}\n\n' +
        'Emit JUnit XML if your runner can — it is the difference between\n' +
        'reading the result and guessing at it.'
      );
    }
    testCommand = runner.command;
    log.info(`Detected ${runner.name}; running: ${testCommand}`);
    // Three tiers, and saying which one applies is the point: a JUnit report,
    // the runner's own structured format, or reading its prose. Only the
    // third is guesswork, and only the third deserves a warning.
    if (runner.junit) {
      log.info(`Results will be read from ${runner.junit}.`);
    } else if (runner.parse) {
      log.info(`Results will be read from ${runner.name}'s own structured output.`);
    } else {
      log.warn(
        `${runner.name} produces no structured report, so results are inferred from ` +
        'its output. That is the least reliable path — set test-command yourself ' +
        'if you can make it emit JUnit XML.'
      );
    }
  }

  const event = await eventPayload();
  const pr = event?.pull_request;

  const baseSha = input('base') || pr?.base?.sha;
  const headSha = pr?.head?.sha || process.env.GITHUB_SHA;

  if (!baseSha) {
    // Outside a pull request there is no "before" to compare against, and
    // guessing one (HEAD~1, the default branch) would quietly measure
    // something other than what the author changed.
    return finish({
      outcome: OUTCOME.NOT_APPLICABLE,
      reason: 'no-base',
      files: [],
      note: 'postflight compares against a pull request base; this run has none.',
    });
  }

  await assertHistory(baseSha, headSha);

  const patterns = listInput('test-pattern', DEFAULT_PATTERNS);
  const changed = await changedFiles(baseSha, headSha);
  const files = selectTestFiles(changed, patterns);

  log.info(`Changed files: ${changed.length}; test files: ${files.length}`);
  if (files.length === 0) {
    return finish({
      outcome: OUTCOME.NOT_APPLICABLE,
      reason: 'no-test-files',
      files: [],
      baseSha,
      headSha,
    });
  }

  log.group('Test files to evaluate', () => files.forEach((f) => log.info(`  ${f}`)));

  // A pull request that only renames, reformats or deletes tests is asserting
  // nothing new, so there is nothing to prove and "not proven" would be a
  // false alarm. Measured against real project history this is the difference
  // between a useful finding and three accusations against innocent commits.
  const { added, removed } = await changedLines(baseSha, headSha, files);
  const newCases = countAddedTestCases(added, removed);
  const allAddedNames = extractTestNames(added);

  // The author can say a test is deliberately characterizing behaviour that
  // already works, which no analysis can tell from an untested fix. Marked
  // cases are excluded from the verdict but always REPORTED — a marker that
  // hides the check would be a hole in the check.
  const marked = characterizationNames(added);
  const addedNames = allAddedNames.filter((n) => !marked.includes(n));

  log.info(`New test cases added: ${newCases}`);
  if (allAddedNames.length) {
    log.group('Cases this pull request adds', () =>
      allAddedNames.forEach((n) =>
        log.info(`  ${n}${marked.includes(n) ? '   [characterization]' : ''}`)));
  }
  if (newCases === 0) {
    return finish({
      outcome: OUTCOME.NOT_APPLICABLE,
      reason: 'no-new-tests',
      files,
      baseSha,
      headSha,
    });
  }

  // Everything this pull request adds is marked, so there is nothing left to
  // judge. Said plainly rather than reported as a pass, and the names are
  // listed so the marker is visible to a reviewer.
  if (addedNames.length === 0 && marked.length > 0) {
    log.info(`All ${marked.length} added cases are marked as characterization tests.`);
    return finish({
      outcome: OUTCOME.NOT_APPLICABLE,
      reason: 'characterization',
      files,
      baseSha,
      headSha,
      marked,
    });
  }

  // A source change of pure comments or formatting has altered nothing a
  // test could observe, so there is no behaviour to capture and "not proven"
  // would be true but useless. Measured against real history this was the
  // last surviving false alarm.
  const sourceFiles = changed.filter((f) => !files.includes(f));
  if (sourceFiles.length) {
    const src = await changedLines(baseSha, headSha, sourceFiles);
    if (!changesBehaviour(src.added, src.removed)) {
      log.info('Source changes are comments or formatting only.');
      return finish({
        outcome: OUTCOME.NOT_APPLICABLE,
        reason: 'no-behaviour-change',
        files,
        baseSha,
        headSha,
      });
    }
  }

  const built = await buildBaseWorktree({
    baseSha,
    headSha,
    testFiles: files,
    linkPaths: listInput('link-paths', ['node_modules', '.venv', 'venv', 'vendor']),
  });

  try {
    if (built.linked.length) log.info(`Reusing: ${built.linked.join(', ')}`);

    const setup = input('setup-command');
    if (setup) {
      log.info(`Setup: ${setup}`);
      const s = await runTests({ command: setup, files: [], cwd: built.worktree });
      if (s.exitCode !== 0) {
        throw new Error(`setup-command failed with exit code ${s.exitCode}.`);
      }
    }

    const junitPaths = listInput('junit-paths', ['.']);

    // Run only the cases this pull request adds, where the runner can be told
    // to. Running the whole file is usually far more work than the question
    // needs, and on a large suite that is the difference between a check
    // people keep and one they turn off.
    const narrowing = boolInput('narrow', true) && runner?.filter && addedNames.length > 0
      ? `${testCommand} ${runner.filter(addedNames)}`
      : null;

    let startedAt = Date.now();
    let run = null;
    let report = null;
    // Which command actually produced the verdict. Confirming has to repeat
    // THAT one: when the narrowed run matched nothing and fell back, the
    // verdict came from the whole-file run, and re-running the narrowed
    // command would compare two different things and call the difference
    // "not reproducible". Measured on cobra, that mislabelled 4 of 30 real
    // commits before this was tracked.
    let verdictCommand = null;

    if (narrowing) {
      log.info(`Running this pull request's ${addedNames.length} added ` +
        `${addedNames.length === 1 ? 'case' : 'cases'} against base ${baseSha.slice(0, 8)}…`);
      run = await runTests({ command: narrowing, files: built.overlaid, cwd: built.worktree });
      report = await readReport(runner, run, built.worktree, junitPaths, startedAt);
      verdictCommand = narrowing;
    }

    // A filter that matched nothing must never stand in for a verdict. Name
    // patterns differ per runner and per project, and a silent miss would
    // turn a real result into "inconclusive" with nobody the wiser.
    // Falling back costs a second full run, so only do it when the wider run
    // could actually say something different. A narrowed run that already
    // reported a load error has established the suite does not load, and
    // running the whole file will establish it again more slowly.
    const narrowFailedToLoad = narrowing && hasLoadError(toCases(report));
    if (narrowFailedToLoad) {
      log.info('The narrowed run could not load the suite; the whole file would not either.');
    }

    if (!narrowing || (!coversAny(toCases(report), addedNames) && !narrowFailedToLoad)) {
      if (narrowing) {
        log.warn('The narrowed run matched none of the added cases; running the whole file.');
      }
      startedAt = Date.now();
      log.info(`Running the touched tests against base ${baseSha.slice(0, 8)}…`);
      run = await runTests({
        command: testCommand,
        files: built.overlaid,
        cwd: built.worktree,
      });
      // A runner that emits its own structured stream is read directly; one
      // that writes JUnit has its report collected. Either way the result
      // arrives in the same shape and nothing downstream cares which.
      report = await readReport(runner, run, built.worktree, junitPaths, startedAt);
      verdictCommand = testCommand;
    }

    let verdict = classify(run, report, addedNames);

    // "Could not run" covers several different situations. Say which, because
    // one of them — a test using code this pull request introduces — is not a
    // problem at all and should not read like one.
    //
    // `unrecognised` is diagnosed too: measured against real history it is
    // where a runner that crashed before starting ends up, and reporting that
    // as a judgement about the author's tests hides a setup problem. But its
    // own label is kept when the diagnosis learns nothing, since
    // "unrecognised" is already the more specific of the two.
    const diagnosable = verdict.outcome === OUTCOME.INCONCLUSIVE
      && (verdict.reason === 'load-error' || verdict.reason === 'unrecognised');

    // What this pull request's non-test files add, and what it did to its
    // dependency manifests. Both verdict corrections below need it, so it is
    // gathered once rather than inside each.
    const needsSourceContext = diagnosable || verdict.outcome === OUTCOME.RED;
    let addedSourceLines = [];
    let dependencyDiff = [];
    if (needsSourceContext) {
      const plainSource = changed.filter((f) => !files.includes(f) && !isDependencyFile(f));
      if (plainSource.length) {
        addedSourceLines = (await changedLines(baseSha, headSha, plainSource)).added;
      }
      const depFiles = changed.filter(isDependencyFile);
      if (depFiles.length) {
        const dep = await changedLines(baseSha, headSha, depFiles);
        dependencyDiff = [...dep.added, ...dep.removed];
      }
    }
    const diagnose = (message) =>
      diagnoseLoadError({ message, addedSourceLines, changedFiles: changed, dependencyDiff });

    if (diagnosable) {
      const d = diagnose(`${verdict.evidence || ''}\n${run.output || ''}`);
      if (d.kind !== 'unknown' || verdict.reason === 'load-error') {
        log.info(`Could not run on base: ${d.kind}`);
        verdict = { ...verdict, reason: d.kind, diagnosis: d };
      }
    }

    // A "failure" that is really the test not reaching code this pull request
    // introduces.
    //
    // Some runners report that as an ordinary assertion failure, because by
    // the time it goes wrong there is nothing left that looks like an import
    // error. vitest is the clearest case: esbuild rewrites a named import to
    // a property access, so a missing export becomes `undefined` and then
    // `TypeError: (0, modulo) is not a function` at the call site — with
    // `errors="0" failures="1"` in the JUnit report. Taken at face value that
    // reads as proof, and vitest is one of the most used runners there is.
    //
    // Pattern-matching the message cannot settle it, because the same
    // TypeError is a genuine observation when the code does exist. What
    // settles it is evidence already to hand: does this pull request DECLARE
    // the name that went missing? If it does, the base commit cannot have had
    // it, so nothing was observed. That reasoning is runner-agnostic, which is
    // the point — the next runner to do this will be covered too.
    if (verdict.outcome === OUTCOME.RED) {
      // Per proven case where possible. One case failing for want of new code
      // must not discard a sibling case that genuinely disagreed with base.
      const provenMessages = verdict.cases?.proven?.length
        ? verdict.cases.proven.map((c) => c.message || '')
        : [`${verdict.evidence || ''}`];
      const diagnoses = provenMessages.map(diagnose);
      if (diagnoses.length && diagnoses.every((d) => d.kind === 'references-new-code')) {
        const names = [...new Set(diagnoses.flatMap((d) => d.names))];
        log.warn(
          `The base "failure" is this pull request's own ${names.join(', ')} ` +
          'being absent, not a test observing the old behaviour.'
        );
        verdict = {
          ...verdict,
          outcome: OUTCOME.INCONCLUSIVE,
          reason: 'references-new-code',
          diagnosis: diagnoses[0],
          // The per-case table is built from this, and leaving the case under
          // `proven` would print "failed — captures the change" directly under
          // a headline saying nothing was proven. It did not run; it belongs
          // with the other things that did not.
          cases: verdict.cases && {
            ...verdict.cases,
            proven: [],
            loadErrors: [...verdict.cases.loadErrors, ...verdict.cases.proven],
          },
        };
      }
    }

    // Does this pull request's own test sample without seeding? If so its
    // verdict is probabilistic, and both of the next two decisions change.
    const determinism = analyseDeterminism({
      addedTestLines: added,
      manifestText: await manifestText(built.worktree, changed),
    });
    if (determinism.risk === 'unseeded') {
      const what = determinism.signals.length > 1
        ? `${determinism.signals.slice(0, -1).join(', ')} and ${determinism.signals.at(-1)}`
        : determinism.signals[0];
      log.warn(
        `These tests ${what}, without seeding, so the verdict is probabilistic. ` +
        'Re-running reduces that; only seeding removes it.'
      );
    }

    // Confirm a verdict before standing behind it. A test that fails on base
    // intermittently fails on base for reasons of its own, and crediting that
    // as evidence is the most damaging thing this check can get wrong: it
    // tells you a test has teeth when it does not.
    //
    // RED is always re-run — it is the verdict that claims something. GREEN
    // ON BASE normally is not, because it costs a run on every pull request
    // that has nothing wrong with it.
    //
    // But a sampled test breaks that reasoning. green-on-base is the verdict
    // that ACCUSES the author, and an unseeded test that passed on base by
    // luck produces a false accusation just as readily as a false credit. So
    // when sampling is detected, both get confirmed. Quantum made this
    // asymmetry impossible to miss; it was always there.
    const configured = Math.max(0, parseInt(input('confirmations', '1'), 10) || 0);
    const confirmations = confirmationsFor(determinism.risk, configured);

    if (shouldConfirm(verdict.outcome, determinism.risk)) {
      verdict = await confirmVerdict({
        verdict,
        // The command that PRODUCED this verdict, which after a fallback is
        // not the narrowed one. Passing it explicitly is the point.
        command: verdictCommand,
        confirmations,
        log,
        rerun: async (command) => {
          const again = await runTests({
            command, files: built.overlaid, cwd: built.worktree, echo: false,
          });
          const againReport = await readReport(runner, again, built.worktree, junitPaths, startedAt);
          return classify(again, againReport, addedNames);
        },
      });
    }

    verdict = { ...verdict, determinism, marked };

    return finish({
      ...verdict,
      files: built.overlaid,
      baseSha,
      headSha,
      exitCode: run.exitCode,
    });
  } finally {
    await built.cleanup();
  }
}

/**
 * Read whichever dependency manifests this project has, so sampling
 * libraries can be recognised. Read from the base worktree rather than the
 * job's checkout, since that is the tree the tests actually ran against.
 */
const MANIFESTS = [
  'pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.cfg',
  'package.json', 'Gemfile', 'Cargo.toml',
];

async function manifestText(cwd, changedFiles = []) {
  const names = new Set([
    ...MANIFESTS,
    // A requirements file under a non-standard name still counts when the
    // pull request itself touched it.
    ...changedFiles.filter((f) => /requirements.*\.txt$/.test(f)),
  ]);
  const parts = [];
  for (const name of names) {
    try {
      parts.push(await readFile(join(cwd, name), 'utf8'));
    } catch { /* not present; that is the common case */ }
  }
  return parts.join('\n');
}

/**
 * Collect whatever structured result the runner produced.
 *
 * Some runners stream it to stdout (go), some write it to a file (jest), and
 * some emit JUnit XML. All three arrive here as the same thing, and anything
 * unreadable falls back to a JUnit search rather than failing outright.
 */
async function readReport(runner, run, cwd, junitPaths, since) {
  if (runner?.parse) {
    let raw = run.output;
    if (runner.reportFile) {
      try {
        raw = await readFile(join(cwd, runner.reportFile), 'utf8');
      } catch {
        raw = run.output;   // the runner never wrote it; try its stdout
      }
    }
    const parsed = runner.parse(raw);
    if (parsed && parsed.length) return parsed;
  }
  return collectJUnit(junitPaths, cwd, since);
}

function policyFor(outcome) {
  if (outcome === OUTCOME.GREEN_ON_BASE) return input('on-green', POLICY.fail);
  if (outcome === OUTCOME.INCONCLUSIVE) return input('on-inconclusive', POLICY.pass);
  return POLICY.pass;
}

async function finish(result) {
  const report = buildReport(result);

  setOutput('outcome', result.outcome);
  setOutput('tested-files', (result.files ?? []).join('\n'));
  setOutput('report', report);
  summary(report);

  if (boolInput('comment', true)) {
    const event = await eventPayload();
    await postComment({
      token: input('github-token'),
      repo: process.env.GITHUB_REPOSITORY,
      prNumber: event?.pull_request?.number,
      body: report,
      log,
    });
  }

  const policy = policyFor(result.outcome);
  const headline = `postflight: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`;

  if (result.outcome === OUTCOME.ERROR || policy === POLICY.fail) {
    log.error(headline);
    process.exitCode = 1;
  } else if (policy === POLICY.warn) {
    log.warn(headline);
  } else {
    log.notice(headline);
  }
}

main().catch(async (err) => {
  log.error(err.message);
  await finish({
    outcome: OUTCOME.ERROR,
    reason: 'exception',
    files: [],
    error: err.stack || err.message,
  });
  process.exitCode = 1;
});
