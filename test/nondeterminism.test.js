import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseDeterminism, samplingFrameworks, confirmationsFor, determinismAdvice,
} from '../src/nondeterminism.js';

// postflight's claim is "this test failed on base, therefore it captures your
// change". That assumes determinism. Measured on a real Qiskit shot-based
// assertion, an unseeded one held 31.8% of 400 runs — so the verdict on such
// a commit is close to a coin toss, and saying nothing about it would be the
// tool overclaiming.

test('a shot-based test with no seed is flagged', () => {
  const d = analyseDeterminism({
    addedTestLines: [
      'def test_bell_state_is_balanced():',
      '    result = sampler.run(circuit, shots=1024).result()',
      "    assert result.get_counts()['00'] > 480",
    ],
    manifestText: 'qiskit==2.5.2\npytest',
  });
  assert.equal(d.risk, 'unseeded');
  assert.ok(d.signals.some((s) => /shots/.test(s)));
  assert.deepEqual(d.frameworks, ['qiskit']);
});

test('the same test with a seed is not flagged', () => {
  // Seeding is the actual fix, so detecting it is what stops the warning
  // becoming noise on well-written tests.
  const d = analyseDeterminism({
    addedTestLines: [
      '    result = sampler.run(circuit, shots=1024, seed_simulator=1234).result()',
    ],
    manifestText: 'qiskit',
  });
  assert.equal(d.risk, 'seeded');
});

test('seed=None is not a seed', () => {
  // It is the explicit request for fresh randomness. Treating it as seeded
  // would silence the warning exactly where it is needed.
  const d = analyseDeterminism({
    addedTestLines: ['    sim = cirq.Simulator(seed=None)', '    sim.sample(circuit)'],
    manifestText: 'cirq',
  });
  assert.equal(d.risk, 'unseeded');
});

test('a bare default_rng() is not a seed either', () => {
  const unseeded = analyseDeterminism({
    addedTestLines: ['    rng = np.random.default_rng()', '    x = np.random.normal(size=10)'],
  });
  assert.equal(unseeded.risk, 'unseeded');

  const seeded = analyseDeterminism({
    addedTestLines: ['    rng = np.random.default_rng(1234)', '    x = np.random.normal(size=10)'],
  });
  assert.equal(seeded.risk, 'seeded');
});

test('np.random.seed is recognised, and is not itself a draw', () => {
  // The sampling pattern must not match the seeding call, or every correctly
  // seeded test would be reported as unseeded.
  const d = analyseDeterminism({
    addedTestLines: ['    np.random.seed(0)', '    assert estimate(np.random.rand(100)) > 0.4'],
  });
  assert.equal(d.risk, 'seeded');
});

test('an ordinary deterministic test is not flagged at all', () => {
  // The most important negative case. A loose pattern here would label normal
  // tests probabilistic, and a warning that fires everywhere gets ignored.
  const d = analyseDeterminism({
    addedTestLines: [
      'def test_divide_by_zero_raises():',
      '    with pytest.raises(ValueError):',
      '        divide(1, 0)',
    ],
    manifestText: 'qiskit\npytest',
  });
  assert.equal(d.risk, 'none');
  assert.deepEqual(d.signals, []);
});

test('a sampling framework in the manifest alone is not enough', () => {
  // A Qiskit project is full of deterministic tests. The judgement is about
  // what the added lines do, not what the project imports.
  const d = analyseDeterminism({
    addedTestLines: ['    assert circuit.depth() == 3'],
    manifestText: 'qiskit\ncirq\npennylane',
  });
  assert.equal(d.risk, 'none');
});

test('frameworks are matched on a boundary, not a substring', () => {
  assert.deepEqual(samplingFrameworks('qiskit-aer==0.15'), ['qiskit']);
  assert.deepEqual(samplingFrameworks('"cirq-core": "^1.0"'), ['cirq']);
  assert.deepEqual(samplingFrameworks('myqiskitwrapper'), []);
  assert.deepEqual(samplingFrameworks('requests\nflask'), []);
});

test('hypothesis counts: property-based tests are sampled too', () => {
  // The problem is not quantum-specific, and neither is the remedy.
  const d = analyseDeterminism({
    addedTestLines: ['@given(st.integers())', 'def test_roundtrip(n):'],
    manifestText: 'hypothesis',
  });
  assert.equal(d.risk, 'unseeded');
});

test('unseeded sampling raises confirmations but not absurdly', () => {
  // Re-running is a backstop, not a fix: at the measured 68% base-failure
  // rate, even six extra runs let a non-reproducible result through 6.8% of
  // the time. Going high would cost a run every time for very little.
  assert.equal(confirmationsFor('unseeded', 1), 3);
  assert.equal(confirmationsFor('unseeded', 5), 5, 'never lowers what was configured');
  assert.equal(confirmationsFor('seeded', 1), 1);
  assert.equal(confirmationsFor('none', 0), 0);
});

test('the advice says re-running cannot fix it, and names the remedy', () => {
  const advice = determinismAdvice({
    risk: 'unseeded',
    signals: ['runs a circuit for a number of shots'],
    frameworks: ['qiskit'],
  });
  assert.match(advice, /probabilistic/);
  assert.match(advice, /re-running cannot remove it/);
  assert.match(advice, /seed_simulator/);
  // Both directions of the error, because only naming one is half the story.
  assert.match(advice, /credit it with capturing a change it did not observe/);
  assert.match(advice, /accuse an author whose test is fine/);
});

test('no advice when there is nothing to advise', () => {
  assert.equal(determinismAdvice({ risk: 'none', signals: [], frameworks: [] }), '');
  assert.equal(determinismAdvice({ risk: 'seeded', signals: ['x'], frameworks: [] }), '');
  assert.equal(determinismAdvice({}), '');
});
