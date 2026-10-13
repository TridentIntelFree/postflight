# Findings

A running log of what has been measured, and what turned out not to work.
Each nightly session starts with no memory, so this file is the only thing
stopping the same dead end being explored twice. Append; don't rewrite.

---

## 2026-10-13 — first measurements (express/mocha, click/pytest)

### Bugs only real history exposed

Every one of these passed the unit tests while being broken in the field.
This is the reason `bench/` exists.

| Bug | How it showed up |
|---|---|
| Mocha output entirely unrecognised | `/\bFAIL\b/` does not match `1 failing`. Real assertion failures on base were reported inconclusive. 3 of 25 verdicts wrong. |
| Renamed tests counted as new | A commit fixing a typo in a test *title* was accused of "not proven". Fixed by counting net additions minus removals. |
| Refactors reported as findings | 9 of 24 express commits asserted nothing new. Now `not-applicable`. |
| Command-not-found reported as a verdict | The base worktree has no virtualenv, so `.venv/bin/python` returned 127 and postflight called it "inconclusive" — hiding a setup error behind a judgement about the author's tests. Every non-Node project hits this. |
| Comments-only source change | A commit whose entire source diff was JSDoc got "not proven". Nothing a test can observe had changed. Now `not-applicable`. |

### Verdict distributions

**express (mocha), 24 commits touching `lib/` and `test/`:**

```
not-applicable  46%   proven  38%   inconclusive  12%   not-proven  4%
```

**click (pytest), 29 commits touching `src/` and `tests/`:**

```
not-proven  45%   proven  28%   not-applicable  17%   inconclusive  10%
```

Median run: ~1s on express, ~1-3s on click, on top of the job's own test run.

**The rates differ by an order of magnitude and that is not a bug.** click's
recent history is largely deprecations, typing changes and refactors, where
tests legitimately pass on base. Do not try to "fix" the rate; fix precision.

### Hand-verified verdicts

A rate is not evidence. These were read by hand:

- **TRUE finding** — click `71f2bafa5` "Strip all ANSI sequences". Broadens
  `_ansi_re` from an SGR pattern to the full ECMA-48 CSI grammar so foreign
  sequences (true-colour, mouse reporting) are stripped. The two added tests
  assert that every sequence *Click itself emits* is stripped, and that the new
  pattern is a superset of the old. Both pass on base. **Nothing in the diff
  tests the newly-stripped sequences.** A real review finding in a
  well-maintained project.

- **Accurate but unhelpful** — express `6cd404eb2` "fix: enhance
  req.acceptsCharsets". The entire source change is JSDoc. The added test
  passed on base because no behaviour changed. The verdict was correct and
  blocking it would still have been wrong. This drove `on-green` to default to
  `warn`, and later the comments-only gate which now classifies it
  `not-applicable`.

### Harness pitfalls

- **Dependency era matters enormously.** Testing commits spanning ~10 years
  against one `npm install` produced 20/25 `load-error` — express 4.x needed
  `array-flatten`, which 5.x does not. Pick commits from a single dependency
  era, or install per commit. The first express run looked like total failure
  and was entirely this.
- `LINKS=".venv" ./run.sh …` for Python, or the worktree has no interpreter.
- Mocha needs `--reporter xunit --reporter-option output=…`; pytest needs
  `--junitxml=…`. Without structured output the heuristics decide, and they
  are the fragile path.

### Open questions

- click's 45% not-proven rate was only spot-checked. How many of those 13 are
  true findings? Per-test-case granularity (roadmap item 1) would likely
  answer this and reduce the noise at once.
- No runner beyond mocha and pytest has ever been tried. Both broke on first
  contact. Assume the next one will too.

---

## 2026-10-13 — per-test-case verdicts (roadmap item 1)

The verdict used to be about the whole test FILE: any test in a touched file
failing on base made the pull request "proven". That is both imprecise and
**wrong**, because it credits the author for tests they did not write.

Now the verdict is about the cases the pull request actually adds. Names are
extracted from the diff (`src/cases.js`) and matched against per-case JUnit
results; when nothing matches, it falls back to file-level rather than
inventing a verdict.

### Measured

**express (mocha), 24 commits:** no verdict changed, **0 unmatched names**.
Where file-level was already right, per-case agrees exactly. This is the
control, and it is the reason to believe the click numbers below.

**click (pytest), 29 commits:** 7 verdicts changed, all `red` -> `green-on-base`.

```
red             8  ->  1
green-on-base  13  -> 20
```

Every one of those seven was a **false credit**. Verified by hand:

- `1f9cd54f6` "Close the pager temp file before unlinking it" adds exactly one
  test, `test_tempfile_pager_closes_file_before_unlink`, which PASSES on base.
  The two tests that failed on base are pre-existing and unrelated. File-level
  scoring told the author their test had teeth when it did not.
- `3495fba16` "Warn when an argument name collides" adds five tests, all of
  which pass on base. Confirmed independently by building the base worktree by
  hand and running pytest directly, rather than trusting postflight's own
  matcher.

So file-level was over-crediting by 7/29 — **24% of pull requests were told
their tests captured the change when they did not.** That is the worst class
of error this tool can make, and it was invisible until case-level granularity
existed to expose it.

### Note on what "passes on base" can mean

`1f9cd54f6` is a Windows-specific bug: you can unlink an open file on Linux,
so the test cannot fail on a Linux runner no matter how good it is. postflight
can only prove what the CI platform can observe. The verdict is accurate and
the cause is the platform, not the test.

### Still open

- Execution is still per FILE; only the verdict is per case. Narrowing the run
  itself (`pytest -k`, `mocha --grep`) is the remaining half of roadmap item 1
  and would make it faster, not just more precise.
- Loose name matching is bidirectional substring. It has not misfired in 53
  commits (0 unmatched, 0 observed mismatches), but a short test name that is
  a substring of another could in principle match the wrong case.

---

## 2026-10-13 — scored matching, and runner auto-detection (roadmap item 2)

### Scored one-to-one matching

Name matching was first-match-wins over a bidirectional substring test, which
pairs `test_parse` with `test_parse_unicode` whenever the latter is listed
first. Candidates are now scored (exact > parameterised > suite-prefixed >
substring) and assigned one case to one name.

**Verdict-neutral across all 53 benchmark commits.** This closed a latent
failure mode rather than an observed one, and that is worth stating plainly:
it is not an improvement anyone can measure, it is a trap removed.

Worth recording: one test here did not test what it claimed. "two overlapping
names do not claim the same reported case" used names with distinct exact
matches, so removing the one-to-one constraint changed nothing and the test
passed against broken code. Found by mutating the source. The fix is to make
both names compete for a *single* reported case — the only shape that
exercises the constraint.

### Runner auto-detection

`test-command` is now optional. The runner is detected from `package.json`
(declared test script first, dependencies second), `pyproject.toml`,
`pytest.ini`, `setup.cfg`, `go.mod`, `Cargo.toml`, `build.gradle`, `pom.xml`
and `Gemfile`, and told to emit JUnit XML where it has a built-in reporter.

**Measured with no `test-command` configured at all:**

| | verdicts differing from hand-configured |
|---|---|
| express (mocha), 24 commits | **0** |
| click (pytest), 29 commits | **0** |

Detection returns null rather than guessing when nothing is recognised.
Guessing wrong is how the tool previously produced a confident verdict about a
command that never ran.

Runners with no built-in JUnit reporter — jest (needs the separate jest-junit
package), go, cargo, node:test, rspec — are declared `junit: false` rather than
left absent, and postflight says so in the log. Those fall back to output
heuristics, which is the fragile path and should be treated as the next thing
to fix.

---

## 2026-10-13 — structured output for node:test and Go (roadmap item 3)

Two runners previously fell back to reading prose. Both turned out to have
structured output that was simply not being used.

**node:test** has had a JUnit reporter since Node 20
(`--test-reporter=junit --test-reporter-destination=<file>`). It can emit the
report to a file and the human-readable spec output to stdout at the same
time, so nothing is lost. `junit: false` -> `junit: postflight-report.xml`.

**Go** has no JUnit reporter but `go test -json` is an event stream, which is
better than a report for this purpose: it gives per-test results *and* keeps
build failures at the package level, where they cannot be mistaken for a test
that ran and disagreed. `src/gotest.js` converts it to the same case shape the
JUnit parser produces, so nothing downstream knows the difference.

### Verified against real captured output

The fixtures in `test/fixtures/` are real `go test -json` streams, produced by
compiling and running actual Go code. They are committed deliberately: every
heuristic bug this project has had came from *imagining* a runner's output
instead of looking at it.

| Input | Parsed as |
|---|---|
| test ran and failed | `failure`, message `a_test.go:6: want 3, got 2` |
| package did not compile | `error`, message `undefined: undefinedFunction` |
| not a json stream | `null`, so the caller falls back |

Go reports compile problems as `build-output` / `build-fail` actions, not as
ordinary output. Inferring the build failure from a later `[build failed]`
line worked but reported a useless banner as the message; handling the actions
explicitly surfaces the actual compile error.

### End-to-end, zero configuration

A node:test repo with a real fix and two added tests, no `test-command` set:

```
Detected node-test; running: node --test --test-reporter=junit …
| ✅ | rejects divide by zero | failed — captures the change |
| ⚠️ | still divides evenly   | passed — proves nothing     |
```

No regressions: express and click both unchanged (0 verdict differences).

### Remaining on heuristics

jest (needs the separate jest-junit package), cargo and rspec. jest is the
most used of the three and so the most worth solving; `--json --outputFile`
is structured but is not JUnit, so it needs its own small parser like Go's.

---

## 2026-10-13 — jest via its own --json report

jest has no JUnit output without the separate jest-junit package, which cannot
be assumed present. Its `--json` report is structured and sufficient, and it
draws the needed distinction cleanly:

- a suite that **ran** has entries in `assertionResults`, each with a status
- a suite that **never loaded** has `assertionResults: []` plus a `message`,
  and is counted in `numRuntimeErrorTestSuites`

So an import error cannot be read as a test that ran and disagreed. Verified
against real captured reports in `test/fixtures/jest-*.json` — produced by
installing jest and running it against genuinely failing and genuinely
unloadable code, not written from memory.

A broken suite does **not** swallow the results of suites that did run; that
is pinned by a test, because it would be an easy and silent way to lose cases.

The report is written to a file rather than stdout, since jest interleaves
progress output. `readReport()` in main.js now handles all three shapes —
stdout stream (go), report file (jest), JUnit search (everything else) — and
falls back to the JUnit search when a runner's own report is missing or
unparseable.

### Reliability by runner, after this change

```
JUnit XML        vitest, mocha, node-test, pytest, gradle, maven
structured       jest, go
heuristics       cargo, rspec
```

8 of 10 no longer guess. A log line now states which tier is in use, and only
the heuristics tier is a warning — the previous message claimed jest was being
read from output even after it was being parsed, which was simply wrong.

No regressions: express and click unchanged, 0 verdict differences.

---

## 2026-10-13 — narrowing the run to the added cases (roadmap item 1, second half)

The `filter` functions had been declared for every runner since detection
landed and were **never called**. Dead code in a tool people put in CI is a
defect; the choice was to wire them or delete them.

Wired, with a mandatory fallback: if the filter matches none of the added
cases, the whole file is run instead. Name patterns differ per runner and per
project, and a silent miss would turn a real verdict into "inconclusive" with
nobody the wiser. The fallback is not optional and not configurable.

### Measured, narrowed vs whole-file, 53 commits

| | time | verdict differences |
|---|---|---|
| click (pytest) | 29.9s -> 17.1s (**43% faster**) | **0** |
| express (mocha) | 19.2s -> 19.6s (**2% slower**) | **0** |

**The express result is not a win and is reported as one of nothing.** Its
test files are small enough that running the whole file costs little, and
three commits fall back, paying for two runs. At that size the difference is
noise.

So narrowing helps where a suite is large relative to the tests a pull request
adds, and costs nothing measurable where it is not. Default on, because the
upside scales with suite size and the downside does not.

### The fallback fires, and it fires for a reason

On the first measurement click fell back 3 times, all on `load-error`
commits: the suite cannot load, so no added case appears in the report, so
`coversAny` is false. Running the whole file then establishes the same thing
more slowly.

Skipping the fallback when the narrowed run *already* reported a load error
took click from 39% to 43% faster and its fallbacks from 3 to 0.

Express still falls back 3 times, and that is left alone deliberately: mocha
writes **no report at all** when a file will not load, which is
indistinguishable from a filter that matched nothing. Guessing between them
to save 2% would trade the safety net for noise.

### Note

`coversAny` and `hasLoadError` started life inside main.js, where nothing
could import them and so nothing could test them. Moved to `cases.js`.
Mutating them both — accepting every filter miss, and confusing a failure
with an error — turns the suite red.

---

## 2026-10-13 — diagnosing *why* a test could not run on base

Started as "handle dependency drift". Measuring first changed the shape of
it: only 3 of 6 inconclusive commits touched a dependency file at all, and
diagnosing one that did not (click `22177f857`) turned up
`ModuleNotFoundError: No module named 'typing_extensions'` — a dev dependency
missing from the benchmark venv. Not drift. So the gap was broader than the
feature: **every load error said the same unhelpful thing**, whether the cause
was a missing package, a real drift, or the benign case where a test imports
code the pull request introduces.

Four reasons now, in precedence order (`src/diagnose.js`):

```
references-new-code   benign; reported as "➖ Nothing to prove yet"
dependency-drift      the PR moves the package that went missing
missing-dependency    absent from the base worktree, in either commit
unknown               reported unchanged rather than guessed at
```

### The precision that mattered, and it was not the one expected

The first version called it drift whenever a manifest changed. Measured
against express that was **wrong 3 times out of 7** — in every case the
manifest moved a *different* package than the one that went missing:

| commit | missing | manifest actually moved |
|---|---|---|
| `e5feb9fcc` | `utils-merge` | `merge-descriptors` |
| `4d713d2b7` | `utils-merge` | `fresh` |
| `c96c690dc` | `array-flatten` | `encodeurl` |

All three would have told the author their dependency change was to blame and
sent them to look at a file that is fine — the exact failure one of this
module's own unit tests warns about, showing up in real data within an hour.
Drift now requires the missing name to appear in the dependency diff, with `-`
and `_` treated as interchangeable (`typing_extensions` / `typing-extensions`).

Where the evidence is there, it is kept: click `3b16957cb` ("Make typing work
without runtime `typing_extensions`") *removes* that dependency, the matcher
finds it in the diff, and drift is exactly right. A prediction that it would
demote was wrong; the tool was right.

Where there is no name to check, drift is still the call — a fresh base
checkout against head's installed tree is the most common cause in real CI —
but the wording says so plainly rather than asserting a finding it does not
have.

### A false "✅ Proven", found by running it end to end

This is the one the unit tests could not catch, and it is the worst thing this
tool can do.

A two-commit repo: base exports `divide`, the pull request adds `modulo` and a
test importing it. The file cannot be imported at base. postflight reported:

```
### ✅ postflight — Proven
It ran against the unfixed code, observed it, and disagreed
```

**node:test's JUnit reporter never emits `<error>`.** A file that failed to
import comes out as a `<failure type="testCodeFailure">` named after the file:

```xml
<testcase name="test/a.test.js" classname="test" failure="test failed">
  <failure type="testCodeFailure" message="test failed">
    [Error: test failed] { code: 'ERR_TEST_FAILURE', cause: 'test failed', … }
```

Byte-for-byte the shape of a real assertion failure. The JUnit distinction the
whole tool rests on was simply absent, and `<failure>` was trusted because the
format is supposed to be the reliable tier.

Corrected in `src/junit.js` on two marks together — the case is named after a
file, *and* the cause is the bare string `'test failed'` rather than an
AssertionError. Either alone could misfire; both together are node:test's
specific shape. The real report is committed as
`test/fixtures/nodetest-import-failure.xml`, containing an unimportable file
and a genuine assertion failure in the same run, so the narrowing is pinned
from both sides.

Verified after the fix, end to end:

- new export + test importing it → `inconclusive (references-new-code)`,
  "➖ Nothing to prove yet", naming `modulo`
- real fix + test using only pre-existing exports → `✅ Proven`, per-case
  table intact

Worth stating: the earlier "end-to-end, zero configuration" node:test demo in
this log passed because its test failed an *assertion*. It never exercised the
import-failure path, so the bug sat under a green demo.

### `unrecognised` is diagnosed too

express `f9256ef36` produced `unrecognised` — mocha crashed before starting,
so there was no report at all. Reporting a runner that never ran as a
judgement about the author's tests is the same error as the old
command-not-found bug. Diagnosis now runs on `unrecognised` as well, keeping
that label when it learns nothing (it is already the more specific of the two).

### No regressions

| | verdict differences |
|---|---|
| express (mocha), 29 commits | **0** |
| click (pytest), 30 commits | **0** |

Outcome distributions unchanged; only the reasons are sharper. 97 tests.
Every mutation of `diagnose.js` turns the suite red — suppressing
`references-new-code` (3 fail), dropping the drift name requirement (1),
removing the `-`/`_` loosening (1), emptying `missingNames` (6), suppressing
`missing-dependency` (2).

### Still open

- `references-new-code` **never fired across 59 real commits**, and only
  showed up in a purpose-built repo. Mature projects rarely add a test that
  imports a brand-new module; they extend existing ones. It is the right
  behaviour to have, but its value is for new/greenfield work, not for
  express-shaped history. Do not read the unit tests as evidence it is common.
- `missing-dependency` advises `link-paths` or `setup-command`. When the cause
  is actually a *base-era* package (express 4.x needing `array-flatten` while
  the tree is 5.x), the honest advice is "install as of the base commit".
  Distinguishing that needs reading the base manifest, which is not done.
- cargo and rspec are still on output heuristics. node:test was supposedly on
  the *reliable* tier and still got this wrong, so assume the heuristic tier
  is worse than it looks.
- **The lesson to carry forward:** for every runner, test the import-failure
  path specifically. It is the one case where being wrong produces false
  proof, and three runners in a row have gotten it wrong in three different
  ways (mocha writes no report, jest uses an empty `assertionResults`,
  node:test mislabels it `<failure>`).

---

## 2026-10-13 — the mutation harness had quietly stopped checking

Found by looking at CI instead of trusting it. **The mutation job had been red
since PR #4, and four pull requests were merged through it**, including by me.
Self-check was green the whole time, which made the red easy to wave at.

The cause is worse than a red build. Mutation 3 targeted:

```bash
sed -i "s|  if (junitXml) {|  if (false) {|" src/classify.js
```

`junitXml` was renamed to `hasReport` in PR #5, when `classify()` learned to
accept already-parsed cases. From that commit on the sed **matched nothing**:
the source was untouched, the suite passed, and the harness concluded
"mutation survived". So the job was simultaneously failing CI *and* testing
nothing — and the property it was supposed to pin (structured evidence
preferred over output heuristics) had no mutation coverage for four PRs.

A mutation harness that decays silently as the code moves is worse than none,
because it is trusted. **A mutation that does not apply is now a hard
failure**, with its own message, distinct from one that survives:

```
::error::Mutation did not apply: <label>
The pattern matched nothing, so this mutation tested nothing.
```

Mutations now cover `junit.js` and `diagnose.js` as well as `classify.js` —
the false-proof bug lived in `junit.js`, which had no mutation coverage at all.
Five, all verified to apply and to be caught by running the workflow block
locally rather than pushing and hoping:

```
caught: load-error reported as proof
caught: exit-0-with-no-tests reported as a pass
caught: structured evidence ignored
caught: node:test import failure read as proof
caught: drift blamed without evidence
```

### What probing node:test revealed about yesterday's fix

A sixth mutation — widening the filename check in `neverRan()` to always true
— **survived**, which sent me to find out what `cause: 'test failed'` really
means. It is not "failed to import". It is node:test's catch-all for any
failure it cannot attribute to a named test. Probed directly, at least three
things produce a byte-identical entry:

| Shape | Did the code run? |
|---|---|
| unimportable file | no — must not count as proof |
| top-level assertion outside any `test()` | **yes, and it disagreed** |
| async throw after a test returned | the named test is reported **passed** |

So the correction is conservative, not precise, and the comment in `junit.js`
claimed something narrower than the truth. Corrected to say what it does.

Reading all three as "could not run" is still right: the bias costs a true
finding at worst. In practice the second and third cannot reach a verdict
anyway — neither contributes a name `countAddedTestCases` would count, and the
async case's own test keeps its reported status. Both are now pinned by
`test/fixtures/nodetest-unattributable.xml`, including the one that matters
most: **a test node:test reports as passed must stay passed even when its file
carries a failure entry.**

The surviving mutation is left out of CI deliberately. No real node:test
output puts `cause: 'test failed'` on a case not named after a file, so
catching it would need a fixture invented rather than captured — the exact
mistake every heuristic bug in this log came from. The code comment says the
filename check is belt-and-braces rather than an independent guard, which is
the honest description.

### Lesson

Two in one night, same shape: **a check that passes is not a check that
works.** The project's whole thesis, found twice in its own CI — once in a
test that didn't test what it claimed (PR #4), once in a mutation that didn't
mutate. Verify the harness, not just the result. Run the CI block locally
before pushing.

---

## 2026-10-13 — rspec via its own JSON formatter

Driven by the previous entry's lesson: **for every runner, test the
import-failure path specifically.** cargo and rspec were the two left guessing
from prose. rspec first, because its JSON formatter is built in and stable —
no extra gem, unlike `rspec_junit_formatter`.

Everything below was captured by installing rspec and running it against real
Ruby code. Three fixtures committed.

### What rspec's JSON gives, for free

```
errors_outside_of_examples_count   a spec file could not be loaded
examples[].status                  passed / failed / pending
examples[].exception.class         WHY it failed — the whole judgement
```

**rspec aborts the entire run on any load error.** `example_count` is 0 even
for spec files that were perfectly loadable — unlike jest, which runs the
healthy suites anyway. That makes rspec the one runner so far that *cannot*
produce the mixed report that caught both jest and node:test, because a real
result never sits beside a load error.

### The judgement that matters, and it is not the load error

rspec reports a Ruby exception raised **inside** an example as
`status: "failed"`, identical to a failed expectation. So "failed" alone
cannot be read as proof — this runner's version of the node:test bug.

`exception.class` settles it, and the list has to be named rather than a
catch-all, because both directions are costly:

| Exception | Verdict | Why |
|---|---|---|
| `RSpec::Expectations::ExpectationNotMetError` | failure | ran and disagreed |
| `ZeroDivisionError`, `TypeError`, `RuntimeError` | failure | code exists and misbehaved — a real observation |
| `NoMethodError`, `NameError`, `LoadError` | error | the name is not there |

**`NoMethodError` sits on both sides of that line**, and the message says
which. Verified, not assumed:

```
undefined method `modulo' for module Calc   the method is not there
undefined method `fetch' for nil            the code RAN and hit a nil
```

The second is the classic Ruby bug a fix like this captures. Reading it as
"could not run" would discard a true finding, so a nil receiver stays a
failure. A blanket "any Ruby exception is a load error" rule would have been
wrong on exactly the commits worth catching.

### End to end, zero configuration

A real rspec repo, no `test-command`, three separate runs:

| Pull request | Verdict |
|---|---|
| real fix + test using existing methods | `✅ Proven`, narrowed to the 1 added case |
| test calling a method the PR adds | `➖ Nothing to prove yet (references-new-code)` |
| spec file that will not load | `⚠️ inconclusive (load-error)` |

Four mutations caught, two added to CI: treating every rspec failure as
missing code, and the reverse. Both are one-line changes that would silently
invert the verdict on real Ruby pull requests.

### Two bugs in yesterday's work, found only by running this

`diagnose.js` returned `unknown` for a plainly new Ruby method. Two gaps,
neither visible from the unit tests:

- `missingNames()` had no pattern for Ruby's `undefined method` wording — it
  only knew `uninitialized constant`.
- `introducedByPullRequest()` matched `def modulo` but not `def self.modulo`,
  which is how Ruby declares the module method an example reaches for.

So **`references-new-code` has now fired on a real project**, not only the
purpose-built JS repo. That closes one of the three "could not verify" items
from PR #8 — and it closed by finding two defects, which is the usual way.

### Still on heuristics

cargo alone. On stable Rust, `cargo test -- --format json` needs
`-Z unstable-options`, so libtest results are prose; `--message-format json`
does give structured **build** diagnostics, which is the compile-failure case
— i.e. exactly the dangerous one. Worth doing next on that basis alone, and
worth being honest that it will be a partial conversion rather than a clean
one like this.

---

## 2026-10-13 — tests that sample: postflight's verdict assumed determinism

Asked for "utility for quantum computing". The useful reading turned out to be
a gap in the tool's central claim rather than a quantum feature:
**"this test failed on base, therefore it captures your change" assumes the
test is deterministic.** A sampled test can fail on base by luck, and then the
claim is simply false. Quantum is the sharpest instance, not the only one.

### Measured first, with real Qiskit

Installed qiskit 2.5.2 and ran the same shot-based assertion 400 times each:

| | assertion held |
|---|---|
| unseeded, loose bound, 100 shots | 2.5% |
| unseeded, tight bound, 100 shots | **31.8%** |
| unseeded, tight bound, 1024 shots | 12.5% |
| seeded, same seed, 50 runs | **1 distinct result** |

A 32% flip rate makes the verdict close to a coin toss. **Seeding removes it
entirely.** That one table determined the whole design: the valuable thing is
to notice and tell the author, not to engineer around it.

### Confirmations cannot rescue it, and the numbers say so plainly

postflight re-runs a RED verdict N times. At the measured 68% base-failure
rate, 200k trials:

```
confirmations=0:  a non-reproducible RED survives 68.1%
confirmations=1:                                  46.2%
confirmations=3:                                  21.5%
confirmations=6:                                   6.8%
```

Seven times the cost to still be wrong 1 in 15. So re-running is a backstop
and the report says so in those words. Default raised 1 -> 3 for detected
sampling; deliberately not higher, because a check that costs seven runs gets
turned off.

### The real finding: green-on-base was never confirmed

Only RED was ever re-run, on the reasoning that it is "the verdict that
asserts something". That reasoning was wrong, and quantum made it impossible
to miss. **`green-on-base` is the verdict that ACCUSES the author**, and an
unseeded test that passes on base by luck produces a false accusation exactly
as readily as a false credit.

Measured on a Qiskit pull request whose added test passes on base ~80% of the
time (base applies no bias; the PR fixes that; the assertion sits near the
50-shot boundary):

| | verdict across 6 runs |
|---|---|
| before | `green-on-base` **6/6** — accused the author every time, never re-run |
| after | `not-reproducible` **5/6**, `green-on-base` 1/6 |

And on the mirror-image commit, where the test fails on base ~60% of the time:
`not-reproducible` 4/6, `red` 2/6. Both directions now get checked; neither is
fully solved, which the report states rather than hides.

This asymmetry had been in the tool since confirmations were added. It was not
a quantum bug. Quantum was just the first case where the flip rate was large
enough to see.

### Detection is about the added LINES, not the manifest

A Qiskit repo is full of perfectly deterministic tests — `assert
circuit.depth() == 3` samples nothing. So a sampling library in the manifest
is explicitly **not** sufficient; the judgement reads the lines the pull
request adds. Pinned by a test, because getting this wrong would fire the
warning on every pull request in a quantum repo, and a warning that fires
everywhere is one nobody reads.

Two details worth keeping:

- **`seed=None` is not a seed**, and neither is a bare `default_rng()`. They
  are the explicit request for fresh randomness. Treating them as seeded would
  silence the warning exactly where it belongs.
- My own seeding pattern had this bug: `default_rng\(\s*\S` matches the
  closing paren, so `default_rng()` read as *seeded*. Caught by the test
  written for it, which is the only reason it is not in the shipped code.

### A stray `.pyc` could silence the whole check

Found while building the Qiskit lab. A committed
`tests/__pycache__/test_bell.cpython-311.pyc` matched the broad `**/tests/**`
catch-all, pytest errored on the whole run, and the verdict came back
`unrecognised`. One build artifact should not be able to turn the check off,
so `selectTestFiles` now excludes `__pycache__`, `node_modules`, `.venv`,
`dist`/`build`/`target`/`coverage`, `__snapshots__`, and compiled extensions.

That was my lab's fault and a real postflight defect at the same time.

### No regressions

express (29 commits) and click (30 commits): **0 verdict differences**. The
determinism analysis reports `risk: none` throughout, which is the control
that makes the quantum numbers above believable.

123 tests. Five mutations caught; the two that decide whether a verdict is
evidence or a coin toss are in CI.

### Still open

- The flip-rate measurements come from circuits I wrote. Qiskit's own test
  suite is the obvious next benchmark — it is pytest-based and clonable — and
  would answer how often real quantum projects add unseeded sampled tests. Not
  done; the numbers above are about the *mechanism*, not about prevalence.
- Shot-count heuristics are absent: a test with `shots=1_000_000` and a loose
  bound is effectively deterministic, and is currently warned about anyway.
  Reading the bound would need to understand the assertion, which is a much
  larger job than reading the call.
- cargo remains the last runner on output heuristics.

---

## 2026-10-13 — auditing every runner before adding anything

"Before we add, let's test what we have." The right instinct: **three of the
ten runners had never been run at all**, and the README called them the
*reliable* tier — which is the tier node:test was in when it was handing out
false proof.

Every toolchain was available in the sandbox, so all four gaps were testable.
Each runner got a two-commit lab and the one case that produces false proof: a
test referencing code the pull request introduces.

| Runner | Evidence before | Case B result |
|---|---|---|
| mocha, pytest | 59 real commits | ✅ safe |
| jest, go, node:test, rspec | fixtures + end to end | ✅ safe |
| cargo | **none** | ✅ safe — `inconclusive` |
| maven | **none** | ✅ safe verdict, wrong diagnosis |
| gradle | **none** | ✅ safe verdict, could not run at all |
| **vitest** | **none** | ❌ **`red` — "✅ Proven"** |

### vitest: false proof, and the cause is a bundler

```
| ✅ | modulo is non-negative | failed — captures the change |
```

The test never executed. esbuild rewrites a named import to a property
access, so a missing export **never surfaces as an import error** — it becomes
`undefined`, and the only symptom is at the call site:

```xml
<testsuites tests="3" failures="1" errors="0">
  <failure message="(0 , modulo) is not a function" type="TypeError">
```

`errors="0"`. There is nothing in the output to recognise, and vitest is not
wrong — from its point of view a call returned the wrong thing. This is the
third runner in a row to defeat the JUnit `<failure>`/`<error>` distinction,
in a third different way (mocha: no report; jest: empty `assertionResults`;
node:test: mislabelled `<failure>`; vitest: no error at all).

**So the fix is not another message pattern.** Pattern-matching cannot settle
it, because the identical `TypeError` is a genuine observation when the code
does exist. What settles it is evidence already to hand: **does this pull
request DECLARE the name that went missing?** If so, base cannot have had it.

That is runner-agnostic, and deliberately so — the next runner to do this is
already covered. It is also destructive, since it discards a RED, so:

- applied **per proven case**: one case failing for want of new code must not
  discard a sibling that genuinely disagreed with base;
- fires only on positive evidence (`references-new-code`), never on `unknown`,
  `missing-dependency` or `dependency-drift`;
- **measured: fired 0 times across 59 real commits** of express and click, 0
  verdict and 0 reason differences. That control is what makes it trustworthy.

A second bug fell out: the per-case table still printed "failed — captures the
change" under a headline saying nothing was proven. Downgrading now moves the
case out of `proven`.

### maven: the diagnosis blamed the wrong thing

Verdict was safe but it said `missing-dependency` for a method the pull
request plainly added. Two gaps:

- javac prints `cannot find symbol` and `symbol: method modulo(int,int)` on
  separate lines, further apart than the old 80-character window allowed.
- **the C family declares a method with a return type and no keyword** —
  `public static int modulo(int a, int b)` — so none of the
  function/def/fn/func patterns saw it.

The C-family pattern needs a statement-keyword guard or an ordinary
`return modulo(a, b);` reads as a declaration. Pinned by a test both ways.

### gradle: could not check a project without a committed wrapper

`command: './gradlew test'` was hardcoded. A project without a committed
wrapper reported `command-unavailable` and stopped — it could never be checked
at all. Now prefers `./gradlew` when present and falls back to `gradle`.

The wrapper preference is right when it exists, since it pins the version;
hardcoding it was the bug.

### cargo was fine, and is worth saying

`error[E0432]: unresolved import` is caught by the existing load-error
markers, so the verdict was correct without any change. Only the *diagnosis*
needed cargo's actual wording — which is `unresolved import`, not the
`cannot find function` the first guess assumed.

### After

All ten runners verified on the false-proof case. 130 tests. Eleven mutations
in CI. express and click: 0 differences.

### Lesson

**An unverified claim in a table is a claim.** The README listed vitest,
gradle and maven in the most-reliable tier purely because their reporter was
supposed to emit JUnit XML — the exact assumption that was already known to be
false for node:test, written down in this file, and still repeated. Checking
runners one at a time as they come up means the tenth is trusted for nine
releases. Audit the whole table.
