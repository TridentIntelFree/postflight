// redgreen — prove a pull request's new tests actually fail without its fix.
//
//   1. find the test files this pull request touches
//   2. build the base commit's source with those tests laid over it
//   3. run them
//   4. say what that proved, and how strongly

import { input, boolInput, listInput, setOutput, summary, log, eventPayload } from './core.js';
import { DEFAULT_PATTERNS, selectTestFiles } from './detect.js';
import { assertHistory, changedFiles, buildBaseWorktree } from './worktree.js';
import { runTests, collectJUnit } from './run.js';
import { classify, OUTCOME } from './classify.js';
import { buildReport, postComment } from './report.js';

const POLICY = { fail: 'fail', warn: 'warn', pass: 'pass' };

async function main() {
  const testCommand = input('test-command');
  if (!testCommand) throw new Error('`test-command` is required.');

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
      note: 'redgreen compares against a pull request base; this run has none.',
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

  const built = await buildBaseWorktree({
    baseSha,
    headSha,
    testFiles: files,
    linkPaths: listInput('link-paths', ['node_modules']),
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

    const startedAt = Date.now();
    log.info(`Running the touched tests against base ${baseSha.slice(0, 8)}…`);
    const run = await runTests({
      command: testCommand,
      files: built.overlaid,
      cwd: built.worktree,
    });

    const junitXml = await collectJUnit(
      listInput('junit-paths', ['.']),
      built.worktree,
      startedAt
    );

    const verdict = classify(run, junitXml);
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
  const headline = `redgreen: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`;

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
