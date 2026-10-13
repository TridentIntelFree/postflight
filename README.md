# postflight

**A test that passes before your fix isn't testing your fix.**

postflight checks out your pull request's base commit, lays your new test files
over it, and runs them. If they still pass against the unfixed code, they
aren't testing what you changed.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0          # both sides of the comparison must be present

- uses: TridentIntelFree/postflight@v1
```

That is the whole configuration. The runner is detected from your
repository — `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
`build.gradle`, `pom.xml`, `Gemfile` — and told to write a JUnit report where
it can, because reading a report beats guessing at output. Measured across 53
commits of two projects in two languages, detection produced **identical
verdicts to a hand-written command**.

Set `test-command` yourself when you need to; it always wins. If nothing is
recognised, postflight says so and asks, rather than guessing at a command and
reporting a confident verdict about something that never ran.

## Why

Coverage tells you a line was executed. It cannot tell you whether anything
would have noticed if that line were wrong. So the usual signals — green CI,
coverage up, tests added — are all satisfied by a test that asserts nothing
meaningful.

This matters more than it used to. Tests are increasingly written quickly,
often by an agent, and the characteristic failure isn't a test that fails —
it's a test that passes for a reason unrelated to the thing it claims to
check. It runs, it asserts, it goes green, and it is worth nothing.

There is one honest way to know a test captures a bug: run it against the code
that had the bug and watch it fail. That is all this does.

## What it reports

The verdict is about **the test cases your pull request adds**, not the files
they live in. A PR that adds three tests gets told which of the three actually
capture the change:

| | Test | On base |
|---|---|---|
| ✅ | `rejects divide by zero` | failed — captures the change |
| ⚠️ | `divides cleanly` | passed — proves nothing |

File-level scoring is not just vaguer, it is wrong: any failure anywhere in a
touched file credits the pull request, including pre-existing tests the author
never wrote. Measured against click, that over-credited **24% of pull
requests** — telling authors their tests had teeth when they did not.


| Outcome | Meaning |
|---|---|
| ✅ **Proven** | A touched test failed an assertion on base. It ran against the old code, observed it, and disagreed. |
| ❌ **Not proven** | Every touched test also passes on base. Whatever they check, it isn't what this PR changed. |
| ⚠️ **Inconclusive** | The tests couldn't run on base at all. Nothing proven either way — but postflight says *why*, and one of the reasons isn't a problem. |
| 🎲 **Not reproducible** | The same test gave two different answers on the same base commit. See [tests that sample](#tests-that-sample-quantum-monte-carlo-property-based). |
| ➖ **Not applicable** | No test files touched, or every added case is marked [characterization](#when-a-test-is-deliberately-covering-what-already-works). |

### "Couldn't run" is four different things

Reporting them as one verdict is how a check gets ignored, because the most
common of them is not a fault at all:

| Reason | What it means | What to do |
|---|---|---|
| **references new code** | The test uses something this PR introduces, so it could not exist at base. | Nothing. This is the normal shape of new work, and postflight reports it as ➖ *Nothing to prove yet* rather than a warning. |
| **dependency drift** | The PR moves a package in its manifest, so the installed tree belongs to head. Named only when the missing package is one the PR actually moved. | `setup-command: npm ci` |
| **missing dependency** | A package the project needs isn't in the base worktree, which is a fresh checkout. | `link-paths:` it, or install it with `setup-command` |
| **unrecognised** | The runner said nothing postflight can read. | The raw output is reported unchanged rather than summarised into a guess. |

The distinction between the middle two matters more than it looks. A PR that
bumps `encodeurl` while `array-flatten` is what actually went missing will be
told its dependency change is to blame — and sent to look at a file that is
fine. Measured against express, that was 3 of 7 inconclusive pull requests.

### The distinction that makes this trustworthy

The naive version of this check is worse than useless, and it's worth being
precise about why.

Almost every new test fails against base. Import a function the fix
introduced, and the test file cannot even load — so it "fails", and a naive
tool calls that proof. It proves only that the test mentions new code, which
is true of nearly any new test. [This exact trap has bitten people building it
by hand](https://github.com/charlieanna/autocode/issues/299).

So postflight separates *failed an assertion* from *never ran*:

- **Assertion failure** — the test executed against the old code and
  disagreed with it. Real evidence.
- **Load error** — the test never executed. Weak: equally consistent with a
  test that checks everything and one that checks nothing.

How that distinction is established depends on the runner, and postflight says
in the log which applies:

| | Runners |
|---|---|
| **JUnit XML** — read directly, nothing inferred | vitest\*, mocha, node:test\*, pytest, gradle, maven |
| **The runner's own structured format** — parsed | jest (`--json`), go (`test -json`), rspec (`--format json`) |
| **Reading output** — the fragile path | cargo |

Only the third guesses, and when it recognises nothing it reports
*inconclusive* rather than picking a side. Claiming proof it doesn't have is
the one failure this tool must not have.

### When a test is deliberately covering what already works

A test written for behaviour that already worked is **indistinguishable** from
an untested fix. No analysis can separate them — and this is not a rare case.
Of the four pull requests postflight accused across cobra's recent history,
two were explicitly "add tests for existing functions" commits. The verdict
was accurate both times, and blocking either would have been wrong.

You know which it is, so say so:

```js
// postflight: characterization
test('divides negatives the way it always has', () => { … })
```

That case is excluded from the verdict. `characterisation`, `ignore` and
`skip` all work, with `//`, `#`, `--` or `/* */`.

Two rules keep it honest:

- **It is read from the lines your pull request adds**, so the marker has to
  be part of the change. An existing marker elsewhere in the file cannot
  silence a new test.
- **Marked cases are always listed in the report.** A marker that suppresses
  the check invisibly is a hole in the check, and a reviewer cannot notice
  what they are not shown.

If every case you add is marked, postflight reports ✓ *Characterization
tests* and stops — plainly, rather than as a pass it did not earn.

### Tests that sample: quantum, Monte Carlo, property-based

The verdict above assumes the test is **deterministic**. A test that samples
can fail on base by luck, and then "it captures your change" is simply false.

This is not a corner case. Measured on a real Qiskit shot-based assertion,
400 runs each:

| | assertion held |
|---|---|
| unseeded, tight bound, 100 shots | **31.8%** of runs |
| unseeded, tight bound, 1024 shots | 12.5% |
| seeded, same seed, 50 runs | 1 distinct result |

At a 32% flip rate the verdict is close to a coin toss. So postflight reads
the lines your PR adds, and when they sample without seeding it:

1. **says so, next to the verdict** — because seeding is the only real fix and
   only you can apply it;
2. raises `confirmations` to 3;
3. **also re-runs a `not proven` result**, which it otherwise never does.

That third point is the one quantum made obvious. `not proven` is the verdict
that *accuses* an author, and an unseeded test that passed on base by luck
produces a false accusation exactly as readily as a false credit. Measured on
a Qiskit PR whose test passes on base ~80% of the time: the old behaviour
emitted that accusation on **100%** of runs and never re-ran it; now 5 of 6
runs report 🎲 *Not reproducible* instead.

**Re-running mitigates, it does not fix.** At the measured 68% base-failure
rate, even six extra runs let a non-reproducible result through 6.8% of the
time, for seven times the cost. The number that matters is in the advice.

Recognised: `qiskit`, `cirq`, `pennylane`, `pytket`, `braket`, `qutip`,
`strawberryfields`, `pyquil`, `projectq`, `qsharp`, `hypothesis`, `faker`,
plus unseeded `numpy.random` / `random` / `torch` / `tf.random` in any project.
A sampling library in your manifest is **not** enough on its own — the
judgement is about what the added test lines do, since a Qiskit repo is full
of perfectly deterministic tests.

### When a runner calls a load error a failure

Two of the ten do, in different ways, and both were found by running
postflight against real projects rather than reasoning about the report
format. Both produced a false **✅ Proven** for a test that never executed —
the worst error this tool can make.

**vitest** is the subtler one, and the cause is a bundler rather than the
reporter. esbuild rewrites a named import to a property access, so a missing
export never surfaces as an import error: it silently becomes `undefined` and
the only symptom is `TypeError: (0 , modulo) is not a function` at the call
site, reported as `errors="0" failures="1"`. There is nothing in the output to
recognise, and vitest is not lying — from its point of view a call returned
the wrong thing.

So postflight does not pattern-match the message. It uses evidence already to
hand: **does this pull request declare the name that went missing?** If it
does, the base commit cannot have had it, so nothing was observed and the
verdict is downgraded. That reasoning is runner-agnostic, which is the point —
the next runner to do this is covered too.

The guard matters as much as the rule. A `TypeError` about code the base
commit *does* have is a real observation of old behaviour, and discarding it
would throw away a true finding. Measured across 59 real commits of express
and click, the downgrade fired **zero** times.

\* node:test emits JUnit XML but does not use `<error>` at all. Any failure it
cannot pin on a named test — an unimportable file, a top-level assertion, an
async throw after a test returned — arrives as a `<failure>` named after the
*file*, carrying `cause: 'test failed'`. All three are byte-identical in the
report, so postflight reads them all as "could not run": right for the first,
and deliberately conservative for the others, since that bias costs a true
finding at worst while the opposite hands out false credit. Pinned by two real
captured reports in [`test/fixtures/`](test/fixtures/).

## Measured on real history

Run against 24 consecutive commits of [express](https://github.com/expressjs/express)
that changed both source and tests:

| Verdict | | |
|---|---:|---|
| ➖ Not applicable | 46% | Renames, deletions, dependency swaps, refactors — nothing asserted, so nothing to disprove |
| ✅ Proven | 38% | A test failed an assertion on base |
| ⚠️ Inconclusive | 12% | Mostly merge commits and dependency drift |
| ⚠️ Not proven | 4% | One commit |

Median run: **1 second** on top of the job's existing test run.

That one "not proven" is the honest part. It was a pull request whose source
change turned out to be **pure JSDoc** — the added test passed on base because
no behaviour had changed. The verdict was accurate, and blocking it would
still have been wrong.

That is why `on-green` defaults to `warn`. Writing a test for behaviour that
already works is normal and good practice, and from here it is indistinguishable
from failing to test a fix. Only the author knows which it is.

Getting to those numbers took three fixes that only real history exposed:

- **Mocha output was unrecognised.** `/\bFAIL\b/` does not match `1 failing`,
  so genuine assertion failures were reported as inconclusive. Emit JUnit XML
  and the guessing stops — which is why the docs lead with it.
- **Renamed tests were counted as new.** A commit fixing a typo in a test
  title was reported as "not proven". Net counting fixed it.
- **Refactors and deletions were reported as findings.** Nine of 24 commits
  asserted nothing new; they are now silent.

## Configuration

| Input | Default | |
|---|---|---|
| `test-command` | detected | `{files}` is replaced with the touched test files. Optional. |
| `test-pattern` | common conventions | Globs identifying test files, one per line. |
| `junit-paths` | `.` | Where to look for JUnit XML the run produced. |
| `narrow` | `true` | Run only the cases the PR adds, not their whole files. |
| `setup-command` | — | Run in the base worktree before the tests. |
| `link-paths` | `node_modules` | Reuse an installed dependency tree instead of rebuilding it. |
| `on-green` | `warn` | What to do when tests pass on base: `warn`, `fail`, `pass`. |
| `on-inconclusive` | `pass` | What to do when they can't run on base. |
| `comment` | `true` | Post the result to the PR, updating in place. |
| `base` | PR base | Override the comparison point. |

Outputs: `outcome`, `tested-files`, `report`.

### Examples

**Emit JUnit XML wherever your runner can.** It is the difference between
reading the verdict and guessing at it: `<failure>` versus `<error>` is exactly
the assertion-vs-never-ran distinction, and output heuristics miss real
failures in runners they were not written for.

```yaml
# Python
- uses: TridentIntelFree/postflight@v1
  with:
    test-command: pytest {files} --junitxml=report.xml

# Go — the runner can't be scoped to a file list, so just run the package
- uses: TridentIntelFree/postflight@v1
  with:
    test-command: go test ./...

# Start advisory while you see what it finds on your codebase
- uses: TridentIntelFree/postflight@v1
  with:
    test-command: npm test -- {files}
    on-green: warn
```

## How it works

1. Diff `base...head` (merge base, so unrelated commits landing on the base
   branch aren't mistaken for your work) and keep the test files.
2. Create a detached `git worktree` at base. Your job's checkout is never
   touched, so a crashed run can't strand the workspace on the wrong commit.
3. Write the head version of each test file into it, symlinking `node_modules`
   and friends so the dependency tree isn't installed twice.
4. Run **only the cases the pull request adds**, where the runner can be told
   to (`pytest -k`, `mocha --grep`, `jest -t`, `go test -run`). 43% faster on
   a project with large test files; no measurable difference on one with small
   ones. If the filter matches nothing, the whole file runs instead — a silent
   miss would turn a real verdict into "inconclusive".
5. Classify. Report. Remove the worktree.

## Limits

Worth knowing before you turn it on:

- **Flaky tests produce false "proven".** A test that fails intermittently
  fails on base too, and postflight can't tell that from real evidence.
- **Refactors and docs PRs** have nothing to prove. They report *not
  applicable* rather than passing judgement.
- **Expensive suites** cost an extra run. Scope `test-command` with `{files}`
  where your runner allows it.
- **A proven test is not a good test.** It demonstrates the test observes the
  change. It says nothing about whether the change is correct, or whether the
  test covers the important case.
- **It can only prove what the CI platform can observe.** A fix for a
  Windows-specific bug cannot fail on a Linux runner however good its test is.
- **It cannot know intent.** A test added for behaviour that already works
  looks exactly like a fix with no test. This is why the default is advisory.
- Shallow clones don't work. `fetch-depth: 0`.

## Related

[Mutation testing](https://stryker-mutator.io/) asks a different question —
whether your suite would catch a hypothetical mutation — and is language-bound
and comparatively expensive. postflight asks whether *this* pull request
contains a test that captures the change, costs one test run, and doesn't care
what language you're in. They complement each other.

## Development

```sh
npm test
```

No dependencies, no build step, no bundled `dist/`. This runs inside other
people's CI, so it should be auditable by reading it.

MIT.
