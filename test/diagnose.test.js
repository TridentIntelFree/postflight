import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseLoadError, missingNames, changesDependencies } from '../src/diagnose.js';

// "Could not run" covers three situations needing completely different
// responses, and one of them is not a problem at all. Conflating them is how
// a check gets ignored.

test('extracts the missing name from each ecosystem', () => {
  const cases = [
    ["ModuleNotFoundError: No module named 'typing_extensions'", 'typing_extensions'],
    ["ImportError: cannot import name 'divide' from 'calc'", 'divide'],
    ["Error: Cannot find module '../src/nowhere'", '../src/nowhere'],
    ["SyntaxError: The requested module './calc.js' does not provide an export named 'modulo'", 'modulo'],
    ['./main.go:5:3: undefined: helperFunc', 'helperFunc'],
    ['NameError: uninitialized constant Widget', 'Widget'],
    ["NoMethodError: undefined method `modulo' for module Calc", 'modulo'],
  ];
  for (const [message, expected] of cases) {
    assert.ok(missingNames(message).includes(expected),
      `should extract ${expected} from: ${message.slice(0, 40)}`);
  }
});

test('a test importing code the PR adds is benign, not a problem', () => {
  // The normal state of affairs for a new feature. Reporting it like a fault
  // trains people to ignore the check.
  const d = diagnoseLoadError({
    message: "SyntaxError: does not provide an export named 'modulo'",
    addedSourceLines: ['export function modulo(a, b) {', '  return a % b;'],
    changedFiles: ['src/calc.js', 'test/calc.test.js'],
  });
  assert.equal(d.kind, 'references-new-code');
  assert.match(d.explanation, /expected for new work/);
  assert.match(d.explanation, /nothing needs fixing/);
});

test('a Ruby module method the PR adds is recognised as new code', () => {
  // Found by running postflight against a real rspec project: the diagnosis
  // came back "unknown" for a plainly new method, because `def self.modulo`
  // puts a receiver between the keyword and the name.
  const d = diagnoseLoadError({
    message: "NoMethodError: undefined method `modulo' for module Calc",
    addedSourceLines: ['  def self.modulo(a, b)', '    ((a % b) + b) % b'],
    changedFiles: ['lib/calc.rb', 'spec/calc_spec.rb'],
  });
  assert.equal(d.kind, 'references-new-code');
  assert.deepEqual(d.names, ['modulo']);
});

test('a new source FILE also counts as introduced by the PR', () => {
  const d = diagnoseLoadError({
    message: "Error: Cannot find module '../src/widget'",
    addedSourceLines: [],
    changedFiles: ['src/widget.js'],
  });
  assert.equal(d.kind, 'references-new-code');
});

test('a lockfile that moves the missing package is dependency drift', () => {
  const d = diagnoseLoadError({
    message: "ModuleNotFoundError: No module named 'anyio'",
    addedSourceLines: [],
    changedFiles: ['pyproject.toml', 'uv.lock', 'src/click/core.py'],
    dependencyDiff: ['-    "anyio>=3.0",', '+    "anyio>=4.2",'],
  });
  assert.equal(d.kind, 'dependency-drift');
  assert.match(d.explanation, /setup-command/);
});

test('a manifest change that never mentions the package is not drift', () => {
  // Real case from the benchmark: click 3b16957cb edits pyproject.toml, and
  // the package that went missing is a dev dependency the diff never touches.
  // Calling that drift points the author at a file that is not the problem.
  const d = diagnoseLoadError({
    message: "ModuleNotFoundError: No module named 'typing_extensions'",
    addedSourceLines: [],
    changedFiles: ['pyproject.toml', 'src/click/termui.py'],
    dependencyDiff: ['-requires-python = ">=3.9"', '+requires-python = ">=3.10"'],
  });
  assert.equal(d.kind, 'missing-dependency');
});

test('a package name is matched across - and _ spellings', () => {
  // The importable module and the distribution are routinely spelled
  // differently, and failing to connect them would reject true drift.
  const d = diagnoseLoadError({
    message: "ModuleNotFoundError: No module named 'typing_extensions'",
    addedSourceLines: [],
    changedFiles: ['pyproject.toml'],
    dependencyDiff: ['+    "typing-extensions>=4.0",'],
  });
  assert.equal(d.kind, 'dependency-drift');
});

test('a manifest change with no name to check at all is still drift', () => {
  // Nothing better is available: the manifest moved and the runner said
  // nothing useful, so drift is the most likely explanation and the advice
  // (install inside the base worktree) is right either way.
  const d = diagnoseLoadError({
    message: 'Error: Cannot find module',
    addedSourceLines: [],
    changedFiles: ['package.json', 'package-lock.json'],
    dependencyDiff: ['-    "array-flatten": "1.1.1",'],
  });
  assert.equal(d.kind, 'dependency-drift');
});

test('a third-party package missing entirely is an environment problem', () => {
  // The real case from the benchmark: a dev dependency never installed.
  // Neither drift nor new code — the environment is simply incomplete.
  const d = diagnoseLoadError({
    message: "ModuleNotFoundError: No module named 'typing_extensions'",
    addedSourceLines: ['def convert(self, value):'],
    changedFiles: ['src/click/types.py', 'tests/typing/typing_path.py'],
  });
  assert.equal(d.kind, 'missing-dependency');
  assert.match(d.explanation, /link-paths|setup-command/);
  assert.match(d.explanation, /typing_extensions/);
});

test('new code outranks dependency drift when both are present', () => {
  // If the PR introduces the missing name, that explains the error fully.
  // Blaming the lockfile would send someone to fix a thing that is not wrong.
  const d = diagnoseLoadError({
    message: "cannot import name 'modulo' from 'calc'",
    addedSourceLines: ['def modulo(a, b):'],
    changedFiles: ['package.json', 'src/calc.py'],
    dependencyDiff: ['+    "modulo": "^1.0.0",'],
  });
  assert.equal(d.kind, 'references-new-code');
});

test('an unrecognised error is reported as unrecognised, not guessed at', () => {
  const d = diagnoseLoadError({
    message: 'Killed',
    addedSourceLines: [],
    changedFiles: ['src/a.js'],
  });
  assert.equal(d.kind, 'unknown');
  assert.match(d.explanation, /not recognisable/);
});

test('dependency files are recognised across ecosystems', () => {
  const yes = [
    'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'uv.lock',
    'poetry.lock', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
    'Gemfile.lock', 'pom.xml', 'build.gradle.kts', 'app/build.gradle',
  ];
  for (const f of yes) {
    assert.ok(changesDependencies([f]), `${f} should count as a dependency file`);
  }
  assert.equal(changesDependencies(['src/package.js', 'README.md']), false);
});
