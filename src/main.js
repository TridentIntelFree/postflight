// postflight — prove a pull request's new tests actually fail without its fix.
//
//   1. find the test files this pull request touches
//   2. build the base commit's source with those tests laid over it
//   3. run them
//   4. say what that proved, and how strongly

import { input, boolInput, listInput, setOutput, summary, log, eventPayload } from './core.js';
import { DEFAULT_PATTERNS, selectTestFiles, countAddedTestCases } from './detect.js';
import { extractTestNames } from './cases.js';
import { detectRunner } from './runners.js';
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
    if (!runner.junit) {
      log.info(
        `${runner.name} has no built-in JUnit report, so results are read from its ` +
        'output. Set test-command yourself if you can make it write one.'
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
  const addedNames = extractTestNames(added);
  log.info(`New test cases added: ${newCases}`);
  if (addedNames.length) {
    log.group('Cases this pull request adds', () =>
      addedNames.forEach((n) => log.info(`  ${n}`)));
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
    const startedAt = Date.now();
    log.info(`Running the touched tests against base ${baseSha.slice(0, 8)}…`);
    const run = await runTests({
      command: testCommand,
      files: built.overlaid,
      cwd: built.worktree,
    });

    // A runner that emits its own structured stream is read directly; one
    // that writes JUnit has its report collected. Either way the result
    // arrives in the same shape and nothing downstream cares which.
    const report = runner?.parse
      ? (runner.parse(run.output) ?? await collectJUnit(junitPaths, built.worktree, startedAt))
      : await collectJUnit(junitPaths, built.worktree, startedAt);

    let verdict = classify(run, report, addedNames);

    // Confirm a claim of proof before making it. A flaky test fails on base
    // too, and crediting that as evidence is the most damaging thing this
    // check can get wrong: it tells you a test has teeth when it does not.
    // Only RED is re-run — it is the only verdict that asserts something, and
    // paying the cost on ~a third of pull requests keeps the check cheap.
    const confirmations = Math.max(0, parseInt(input('confirmations', '1'), 10) || 0);
    if (verdict.outcome === OUTCOME.RED && confirmations > 0) {
      for (let i = 1; i <= confirmations; i++) {
        log.info(`Confirming the failure is not flaky (${i}/${confirmations})…`);
        const again = await runTests({
          command: testCommand,
          files: built.overlaid,
          cwd: built.worktree,
          echo: false,
        });
        const againReport = runner?.parse
          ? (runner.parse(again.output) ?? await collectJUnit(junitPaths, built.worktree, startedAt))
          : await collectJUnit(junitPaths, built.worktree, startedAt);
        const repeat = classify(again, againReport, addedNames);
        if (repeat.outcome !== OUTCOME.RED) {
          log.warn('The base failure did not reproduce — treating it as flaky.');
          verdict = {
            outcome: OUTCOME.INCONCLUSIVE,
            reason: 'flaky',
            evidence:
              'The tests failed against base on the first run and did not on a ' +
              'repeat. A test that fails intermittently fails on base too, so ' +
              'this cannot be counted as evidence either way.',
          };
          break;
        }
      }
    }

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
