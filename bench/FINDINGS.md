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
