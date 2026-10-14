// Working out how to run a project's tests, so `test-command` can be optional.
//
// Two things are being solved here, and the second matters more.
//
// The obvious one is setup burden: a required `test-command` is a thing to get
// wrong, and getting it wrong used to produce a confident verdict about a
// command that never ran.
//
// The real one is structured output. Classification is reliable when the
// runner writes JUnit XML and guesswork when it does not — every runner met so
// far has broken the output heuristics on first contact. A detected runner can
// be told to emit a report, so the reliable path becomes the default instead
// of something a user has to know to ask for.

import { readFile, access } from 'node:fs/promises';
import { parseGoJson } from './gotest.js';
import { parseJestJson } from './jestjson.js';
import { parseRspecJson } from './rspec.js';
import { join } from 'node:path';

const REPORT = 'postflight-report.xml';
const JSON_REPORT = 'postflight-report.json';

const exists = async (dir, name) => {
  try { await access(join(dir, name)); return true; } catch { return false; }
};

const readJson = async (dir, name) => {
  try { return JSON.parse(await readFile(join(dir, name), 'utf8')); } catch { return null; }
};

const readText = async (dir, name) => {
  try { return await readFile(join(dir, name), 'utf8'); } catch { return ''; }
};

/**
 * Each runner declares how to run named files and, where it can, how to write
 * a JUnit report.
 *
 * `junit: false` is honest rather than absent: those runners have no built-in
 * report, so classification falls back to reading their output, and saying so
 * is better than pretending the reliable path is available.
 */
const RUNNERS = {
  vitest: {
    command: `npx vitest run {files} --reporter=junit --outputFile=${REPORT}`,
    junit: REPORT,
    filter: (names) => `-t ${quote(names.join('|'))}`,
  },
  jest: {
    // No JUnit without the separate jest-junit package, which cannot be
    // assumed present — but jest's own --json report is structured and draws
    // the run/never-ran distinction clearly. Written to a file so jest's
    // progress output can still go to the terminal.
    command: `npx jest {files} --ci --json --outputFile=${JSON_REPORT}`,
    junit: false,
    reportFile: JSON_REPORT,
    parse: parseJestJson,
    filter: (names) => `-t ${quote(names.join('|'))}`,
  },
  mocha: {
    command: `npx mocha {files} --reporter xunit --reporter-option output=${REPORT}`,
    junit: REPORT,
    filter: (names) => `--grep ${quote(names.join('|'))}`,
  },
  'node-test': {
    // Node's own JUnit reporter, available since Node 20. Writing it to a
    // file keeps the human-readable output on stdout.
    command:
      `node --test --test-reporter=junit --test-reporter-destination=${REPORT} ` +
      '--test-reporter=spec --test-reporter-destination=stdout {files}',
    junit: REPORT,
    filter: (names) => `--test-name-pattern ${quote(names.join('|'))}`,
  },
  pytest: {
    command: `python -m pytest {files} -q --junitxml=${REPORT}`,
    junit: REPORT,
    filter: (names) => `-k ${quote(names.join(' or '))}`,
  },
  go: {
    // `go test` takes packages, not files. It has no JUnit reporter, but its
    // event stream is structured, which is better: it says per test what
    // happened, and keeps build failures at the package level where they
    // cannot be mistaken for a test that ran and disagreed.
    command: 'go test -json ./...',
    junit: false,
    parse: parseGoJson,
    filter: (names) => `-run ${quote(`^(${names.join('|')})$`)}`,
  },
  cargo: {
    command: 'cargo test',
    junit: false,
    // `cargo test a b` is a usage error — cargo takes at most one TESTNAME.
    // Several filters have to go past it to the test binary, which does
    // accept them. Verified against real cargo; the old form was invalid for
    // any pull request adding more than one test, which is most of them.
    filter: (names) => `-- ${names.map(quote).join(' ')}`,
  },
  gradle: {
    // Gradle writes JUnit XML under build/test-results by default.
    command: './gradlew test',
    junit: 'build/test-results',
    filter: (names) => names.map((n) => `--tests ${quote(`*${n}`)}`).join(' '),
  },
  maven: {
    command: 'mvn -B test',
    junit: 'target/surefire-reports',
    // Surefire's `-Dtest` takes class patterns, not bare method names, and a
    // bare one is a HARD ERROR: "No tests matching pattern were executed!".
    // So narrowing never worked for maven — it errored, then fell back, and
    // the fallback hid it. `*#method` selects the method in any class, and
    // the flag turns a genuine no-match into an empty report so the fallback
    // happens cleanly instead of via a failure. Verified against real maven.
    filter: (names) => `-Dtest=${quote(names.map((n) => `*#${n}`).join(','))}`
      + ' -Dsurefire.failIfNoSpecifiedTests=false',
  },
  rspec: {
    // No JUnit without the separate rspec_junit_formatter gem, which cannot
    // be assumed present — but rspec's own JSON formatter is built in and
    // names the run/never-ran distinction outright
    // (`errors_outside_of_examples_count`). Written to a file so rspec's
    // progress output can still go to the terminal.
    command: `bundle exec rspec {files} --format json --out ${JSON_REPORT} --format progress`,
    junit: false,
    reportFile: JSON_REPORT,
    parse: parseRspecJson,
    filter: (names) => names.map((n) => `-e ${quote(n)}`).join(' '),
  },
};

/**
 * Shell-quote a filter argument.
 *
 * The allowlist is the set of characters that are genuinely inert to the
 * shell, and nothing else. It previously included `^ $ ( ) |`, every one of
 * which the shell acts on — so a filter built from them was emitted raw:
 *
 *   go       -run ^(TestAlpha|TestBeta)$      bash: syntax error near `('
 *   vitest   -t TestAlpha|TestBeta            a pipe into `TestBeta`
 *
 * Five of the ten runners were affected, and the symptom was not a wrong
 * verdict but a dead one: the pipeline's exit status is the last command's
 * 127, so postflight reported `error (command-unavailable)` on an ordinary
 * pull request. Go hit it always; the JS runners hit it whenever the added
 * test names contained no spaces, which is why it survived four releases —
 * every test name in every lab and benchmark happened to contain a space.
 */
function quote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Identify the test runner a repository uses.
 * Returns null when nothing is recognised, so the caller can ask the user
 * rather than guess.
 */
export async function detectRunner(dir = process.cwd()) {
  const pkg = await readJson(dir, 'package.json');
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const script = String(pkg.scripts?.test || '');

    // The declared test script is the strongest signal available: it is what
    // the project itself says the command is.
    if (/\bvitest\b/.test(script) || deps.vitest) return named('vitest');
    if (/\bjest\b/.test(script) || deps.jest) return named('jest');
    if (/\bmocha\b/.test(script) || deps.mocha) return named('mocha');
    if (/node\s+--test|node:test/.test(script)) return named('node-test');
  }
  if (await exists(dir, 'vitest.config.ts') || await exists(dir, 'vitest.config.js')) return named('vitest');
  if (await exists(dir, 'jest.config.js') || await exists(dir, 'jest.config.ts')) return named('jest');
  if (await exists(dir, '.mocharc.json') || await exists(dir, '.mocharc.yml')) return named('mocha');

  const pyproject = await readText(dir, 'pyproject.toml');
  if (/\bpytest\b/.test(pyproject)
      || await exists(dir, 'pytest.ini')
      || await exists(dir, 'tox.ini')
      || /\bpytest\b/.test(await readText(dir, 'setup.cfg'))) {
    return named('pytest');
  }

  if (await exists(dir, 'go.mod')) return named('go');
  if (await exists(dir, 'Cargo.toml')) return named('cargo');
  if (await exists(dir, 'build.gradle') || await exists(dir, 'build.gradle.kts')) {
    // The wrapper is the right thing to use when the project commits one,
    // because it pins the Gradle version. Many do not, and hardcoding
    // `./gradlew` meant those projects could never be checked at all — the
    // run reported `command-unavailable` and stopped. Found by auditing the
    // runners against real projects rather than assuming.
    const wrapper = await exists(dir, 'gradlew');
    return { ...named('gradle'), command: `${wrapper ? './gradlew' : 'gradle'} test` };
  }
  if (await exists(dir, 'pom.xml')) return named('maven');
  if (/\brspec\b/.test(await readText(dir, 'Gemfile'))) return named('rspec');

  return null;
}

function named(name) {
  return { name, ...RUNNERS[name] };
}

export const KNOWN_RUNNERS = Object.keys(RUNNERS);
export { RUNNERS, REPORT, JSON_REPORT };
