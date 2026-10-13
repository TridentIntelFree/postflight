// Identifying the test cases a pull request adds, and what became of each
// one against the base commit.
//
// Two reasons this matters more than it looks.
//
// Precision: a verdict over a whole file is not actionable. A pull request
// that adds three tests where two capture the change and one does not should
// say exactly that, not "proven" — which is what file-level reporting gives
// you, because any failure anywhere in the file wins.
//
// Correctness: scoring the whole file also credits the pull request for tests
// it did not write. An unrelated pre-existing test that happens to fail on
// base is not evidence that the author's new test has teeth.

/**
 * Patterns that name a test on the line that declares it.
 * Each must expose the name as capture group 1.
 */
const INLINE_NAME = [
  // JS/TS: it('name'), test("name"), it.each(...)('name'), describe(`name`)
  /\b(?:it|test|specify)\s*(?:\.\s*\w+\s*(?:\([^)]*\)\s*)?)?\(\s*(['"`])(.+?)\1/,
  // Ruby/RSpec: it 'name' do
  /\b(?:it|scenario)\s+(['"])(.+?)\1/,
];

/** Patterns where the whole match after the keyword is the name. */
const DECLARED_NAME = [
  /\bdef\s+(test_\w+)/,                                   // Python
  /\bfunc\s+((?:Test|Benchmark|Fuzz|Example)\w*)\s*\(/,    // Go
];

/**
 * Annotations that mark the NEXT function declaration as a test. The name
 * lives on a later line, so these require a forward scan.
 */
const ANNOTATIONS = [/@Test\b/, /#\[(?:test|tokio::test)\]/, /\[(?:Fact|Theory)\]/];

/** A function declaration whose name we can take, used after an annotation. */
const FUNCTION_NAME =
  /\b(?:fn|fun|void|public\s+void|private\s+void|internal\s+void|async\s+Task)\s+(\w+)\s*\(/;

/**
 * Extract the names of test cases declared in a set of added diff lines.
 * Order is preserved and duplicates are dropped.
 */
export function extractTestNames(addedLines) {
  const names = [];
  const seen = new Set();
  const push = (n) => {
    const name = (n || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  for (let i = 0; i < addedLines.length; i++) {
    const line = addedLines[i];

    let matched = false;
    for (const re of INLINE_NAME) {
      const m = line.match(re);
      if (m) { push(m[2]); matched = true; break; }
    }
    if (matched) continue;

    for (const re of DECLARED_NAME) {
      const m = line.match(re);
      if (m) { push(m[1]); matched = true; break; }
    }
    if (matched) continue;

    // An annotation names the function that follows it. Scan a few lines on;
    // modifiers and parameters often sit between the two.
    if (ANNOTATIONS.some((re) => re.test(line))) {
      for (let j = i + 1; j < Math.min(i + 5, addedLines.length); j++) {
        const m = addedLines[j].match(FUNCTION_NAME);
        if (m) { push(m[1]); break; }
      }
    }
  }

  return names;
}

const normalise = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Pair the names a pull request added with the results the runner reported.
 *
 * Matching is deliberately loose in both directions: runners decorate names
 * differently — mocha prefixes the suite, pytest appends parameters — and a
 * missed match silently drops a case from the verdict.
 */
export function matchCases(addedNames, junitCases) {
  const results = [];

  for (const name of addedNames) {
    const n = normalise(name);
    const hit = junitCases.find((c) => {
      const cn = normalise(c.name);
      const full = normalise(`${c.classname} ${c.name}`);
      return cn === n || cn.includes(n) || n.includes(cn) || full.includes(n);
    });

    results.push({
      name,
      matched: !!hit,
      status: hit ? hit.status : 'unknown',
      type: hit ? hit.type : null,
      message: hit ? hit.message : '',
    });
  }

  return results;
}

/**
 * Summarise per-case results into the shape a verdict needs.
 *
 * `proven` counts only assertion failures. A case that could not load proves
 * nothing, and lumping the two together is the mistake this whole tool exists
 * to avoid.
 */
export function summariseCases(results) {
  const proven = results.filter((r) => r.type === 'failure');
  const loadErrors = results.filter((r) => r.type === 'error');
  const passed = results.filter((r) => r.matched && r.status === 'passed');
  const unmatched = results.filter((r) => !r.matched);

  return {
    total: results.length,
    proven,
    loadErrors,
    passed,
    unmatched,
    // Without a single match there is nothing to say at case level, and the
    // caller should fall back to judging the file rather than invent a verdict.
    usable: results.length > 0 && unmatched.length < results.length,
  };
}
