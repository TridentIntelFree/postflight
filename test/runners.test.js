import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRunner, RUNNERS } from '../src/runners.js';

async function repo(files) {
  const dir = await mkdtemp(join(tmpdir(), 'pf-detect-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
    await writeFile(path, content);
  }
  return dir;
}

const pkg = (o) => JSON.stringify(o);

test('the declared test script outranks a dependency', async () => {
  // A project may have several runners installed. What `npm test` actually
  // runs is what the project itself says it uses.
  const dir = await repo({
    'package.json': pkg({ scripts: { test: 'vitest run' }, devDependencies: { jest: '^29', vitest: '^1' } }),
  });
  assert.equal((await detectRunner(dir)).name, 'vitest');
});

test('detects mocha, jest and node:test from package.json', async () => {
  const mocha = await repo({ 'package.json': pkg({ devDependencies: { mocha: '^11' } }) });
  assert.equal((await detectRunner(mocha)).name, 'mocha');

  const jest = await repo({ 'package.json': pkg({ devDependencies: { jest: '^29' } }) });
  assert.equal((await detectRunner(jest)).name, 'jest');

  const nodeTest = await repo({ 'package.json': pkg({ scripts: { test: 'node --test test/' } }) });
  assert.equal((await detectRunner(nodeTest)).name, 'node-test');
});

test('detects pytest from pyproject, pytest.ini or setup.cfg', async () => {
  const a = await repo({ 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n' });
  assert.equal((await detectRunner(a)).name, 'pytest');

  const b = await repo({ 'pytest.ini': '[pytest]\n' });
  assert.equal((await detectRunner(b)).name, 'pytest');

  const c = await repo({ 'setup.cfg': '[options]\ntests_require = pytest\n' });
  assert.equal((await detectRunner(c)).name, 'pytest');
});

test('detects compiled-language toolchains', async () => {
  assert.equal((await detectRunner(await repo({ 'go.mod': 'module x\n' }))).name, 'go');
  assert.equal((await detectRunner(await repo({ 'Cargo.toml': '[package]\n' }))).name, 'cargo');
  assert.equal((await detectRunner(await repo({ 'pom.xml': '<project/>' }))).name, 'maven');
  assert.equal((await detectRunner(await repo({ 'build.gradle.kts': 'plugins {}' }))).name, 'gradle');
});

test('returns null rather than guessing', async () => {
  // Guessing wrong produces a confident verdict about a command that never
  // ran. Saying "I do not know" lets the caller ask.
  const dir = await repo({ 'index.html': '<!doctype html>', 'README.md': '# a static site' });
  assert.equal(await detectRunner(dir), null);
});

test('a package.json with no runner at all is not a false positive', async () => {
  const dir = await repo({ 'package.json': pkg({ name: 'x', scripts: { build: 'tsc' } }) });
  assert.equal(await detectRunner(dir), null);
});

test('every runner declares a command and a filter', async () => {
  for (const [name, r] of Object.entries(RUNNERS)) {
    assert.ok(r.command, `${name} needs a command`);
    assert.equal(typeof r.filter, 'function', `${name} needs a filter`);
    // `junit: false` is a deliberate statement that the runner has no report,
    // not an oversight — so it must be present either way.
    assert.ok('junit' in r, `${name} must declare whether it writes JUnit`);
  }
});

test('filters quote names that need it', async () => {
  const withSpaces = RUNNERS.mocha.filter(['divides cleanly', 'rejects zero']);
  assert.match(withSpaces, /^--grep /);
  assert.ok(withSpaces.includes("'"), 'a name with spaces must be quoted');

  const pytest = RUNNERS.pytest.filter(['test_a', 'test_b']);
  assert.match(pytest, /-k .*test_a or test_b/);

  const go = RUNNERS.go.filter(['TestA', 'TestB']);
  assert.match(go, /\^\(TestA\|TestB\)\$/, 'go anchors its pattern');
});
