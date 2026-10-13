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
