// Spotting tests whose verdict here is a coin toss.
//
// postflight's whole claim is "this test failed against the base commit,
// therefore it captures your change". That claim quietly assumes the test is
// deterministic. A test that samples — quantum shots, Monte Carlo, property
// based generation, anything touching an unseeded RNG — can fail on base by
// luck, and then the claim is false.
//
// This is not a corner case. Measured on a real Qiskit shot-based assertion,
// 400 runs each:
//
//   unseeded, tight bound, 100 shots     held 31.8% of runs
//   unseeded, tight bound, 1024 shots    held 12.5% of runs
//   seeded, same seed, 50 runs           1 distinct result
//
// A 32% flip rate makes the verdict close to a coin toss, and `confirmations`
// cannot rescue it: at the measured 68% base-failure rate, six extra runs
// still let a non-reproducible RED through 6.8% of the time, for seven times
// the cost. Re-running is a backstop, not a fix.
//
// **Seeding is the fix**, and the author is the only one who can apply it. So
// the useful thing this module does is notice and say so.

/**
 * Libraries whose results are sampled by construction. Quantum first, since
 * a circuit measurement is sampling whether the author thinks of it that way
 * or not, but the problem is not quantum-specific and neither is the fix.
 */
const SAMPLING_FRAMEWORKS = [
  'qiskit', 'cirq', 'pennylane', 'pytket', 'amazon-braket-sdk', 'braket',
  'qutip', 'strawberryfields', 'pyquil', 'projectq', 'qsharp',
  'hypothesis', 'faker',
];

/** Does a dependency manifest declare one of them? */
export function samplingFrameworks(manifestText = '') {
  const text = String(manifestText).toLowerCase();
  return SAMPLING_FRAMEWORKS.filter((name) => {
    // Bounded so `qiskit` does not match inside an unrelated word, while
    // still matching `qiskit-aer`, `qiskit==2.5`, `"qiskit"`.
    const re = new RegExp(`(^|[^a-z0-9_-])${name}($|[^a-z0-9_])`);
    return re.test(text);
  });
}

/**
 * Calls whose result differs run to run.
 *
 * Each entry is [pattern, what to call it]. Kept specific: a loose pattern
 * here would label ordinary tests non-deterministic and the warning would be
 * ignored, which is worse than not having it.
 */
const SAMPLING_CALLS = [
  [/\bshots\s*=\s*(?!0\b)\d|\bshots\s*=\s*[a-z_]/i, 'runs a circuit for a number of shots'],
  [/\b(?:AerSimulator|BasicSimulator|qasm_simulator|StatevectorSampler|SamplerV2|EstimatorV2)\b/, 'uses a sampling backend'],
  [/\bcirq\.Simulator\b|\.run_sweep\(|\.sample\(/, 'samples from a simulator'],
  [/\bqml\.sample\b|\bqml\.expval\b.*\bshots\b/, 'samples a PennyLane device'],
  [/\b(?:np|numpy)\.random\.(?!seed\b|default_rng\s*\(\s*\d)/, 'draws from numpy.random'],
  [/(?:^|[^.\w])random\.(?:random|randint|choice|uniform|sample|shuffle|gauss)\s*\(/, 'draws from random'],
  [/\btorch\.(?:rand|randn|randint)\s*\(|\btf\.random\.(?!set_seed)/, 'draws from a tensor RNG'],
  [/@given\b|\bst\.(?:integers|floats|text|lists)\s*\(/, 'generates cases with hypothesis'],
];

/**
 * Things that pin the sequence so the test is reproducible.
 *
 * `seed=None` and a bare `default_rng()` are deliberately NOT seeds — they
 * are the explicit request for fresh randomness, and treating them as seeded
 * would silence the warning exactly where it is needed.
 */
const SEEDING_CALLS = [
  /\bseed_simulator\s*=\s*(?!None\b)\S/,
  /\bseed_transpiler\s*=\s*(?!None\b)\S/,
  /\bseed\s*=\s*(?!None\b)\S/,
  // `[^)\s]` rather than `\S`, because `\S` happily matches the closing
  // paren and would read a bare `default_rng()` — which is unseeded — as
  // seeded, silencing the warning exactly where it belongs.
  /\b(?:np|numpy)\.random\.seed\s*\(\s*[^)\s]/,
  /\bdefault_rng\s*\(\s*[^)\s]/,
  /(?:^|[^.\w])random\.seed\s*\(\s*[^)\s]/,
  /\brandom_state\s*=\s*(?!None\b)\S/,
  /\btorch\.manual_seed\s*\(\s*[^)\s]|\btf\.random\.set_seed\s*\(\s*[^)\s]/,
  /\bderandomize\b|\bdeterministic\s*=\s*True/,
];

/**
 * Judge the test lines a pull request adds.
 *
 * Only the ADDED lines are read, because the question is about the cases this
 * pull request is asking to be judged — not about whatever the rest of the
 * file already does.
 *
 * @returns {{risk: 'none'|'seeded'|'unseeded', signals: string[], frameworks: string[]}}
 */
export function analyseDeterminism({ addedTestLines = [], manifestText = '' } = {}) {
  const frameworks = samplingFrameworks(manifestText);
  const signals = [];

  for (const [re, label] of SAMPLING_CALLS) {
    if (addedTestLines.some((l) => re.test(l)) && !signals.includes(label)) {
      signals.push(label);
    }
  }

  if (signals.length === 0) return { risk: 'none', signals: [], frameworks };

  const seeded = addedTestLines.some((l) => SEEDING_CALLS.some((re) => re.test(l)));
  return { risk: seeded ? 'seeded' : 'unseeded', signals, frameworks };
}

/**
 * How many times to re-run a verdict before trusting it.
 *
 * Deliberately modest. Re-running is a backstop and the measurement says so —
 * going higher buys very little and costs a run every time, which is how a
 * check gets turned off. The number that matters is in the advice, not here.
 */
export function confirmationsFor(risk, configured) {
  if (risk !== 'unseeded') return configured;
  return Math.max(configured, 3);
}

/** What to tell the author, which is the part that can actually fix it. */
export function determinismAdvice({ risk, signals, frameworks }) {
  if (risk !== 'unseeded') return '';

  const what = signals.length === 1 ? signals[0] : `${signals.slice(0, -1).join(', ')} and ${signals[signals.length - 1]}`;
  const seedHint = frameworks.includes('qiskit')
    ? '    sampler.run(circuit, shots=1024, seed_simulator=1234)'
    : frameworks.includes('cirq')
      ? '    cirq.Simulator(seed=1234).run(circuit, repetitions=1024)'
      : '    rng = np.random.default_rng(1234)';

  return [
    `**This test ${what} without seeding, so the verdict above is probabilistic.**`,
    '',
    'A sampled assertion can fail against the base commit by luck, which would',
    'credit it with capturing a change it did not observe — and it can pass by',
    'luck, which would accuse an author whose test is fine. postflight re-ran',
    'the result to reduce that, but re-running cannot remove it: at a 68%',
    'base-failure rate, measured on a real shot-based assertion, six extra runs',
    'still let a non-reproducible result through 6.8% of the time.',
    '',
    'Seeding does remove it, and only you can do that:',
    '',
    seedHint,
  ].join('\n');
}
