# redgreen

**A test that passes before your fix isn't testing your fix.**

redgreen checks out your pull request's base commit, lays your new test files
over it, and runs them. If they still pass against the unfixed code, they
aren't testing what you changed.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0          # both sides of the comparison must be present

- uses: TridentIntelFree/redgreen@v1
  with:
    test-command: npx jest {files}
```

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

| Outcome | Meaning |
|---|---|
| ✅ **Proven** | A touched test failed an assertion on base. It ran against the old code, observed it, and disagreed. |
| ❌ **Not proven** | Every touched test also passes on base. Whatever they check, it isn't what this PR changed. |
| ⚠️ **Inconclusive** | The tests couldn't run on base at all — they reference code this PR introduces. Nothing proven either way. |
| ➖ **Not applicable** | No test files touched. |

### The distinction that makes this trustworthy

The naive version of this check is worse than useless, and it's worth being
precise about why.

Almost every new test fails against base. Import a function the fix
introduced, and the test file cannot even load — so it "fails", and a naive
tool calls that proof. It proves only that the test mentions new code, which
is true of nearly any new test. [This exact trap has bitten people building it
by hand](https://github.com/charlieanna/autocode/issues/299).

So redgreen separates *failed an assertion* from *never ran*:

- **Assertion failure** — the test executed against the old code and
  disagreed with it. Real evidence.
- **Load error** — the test never executed. Weak: equally consistent with a
  test that checks everything and one that checks nothing.

Where your runner emits JUnit XML, that distinction is read straight from it —
`<failure>` versus `<error>` is precisely this difference, so nothing is
inferred. Without a report, redgreen falls back to recognising runner output,
and when it recognises nothing it says *inconclusive* rather than guessing.
Claiming proof it doesn't have is the one failure this tool must not have.

## Configuration

| Input | Default | |
|---|---|---|
| `test-command` | — | **Required.** `{files}` is replaced with the touched test files. |
| `test-pattern` | common conventions | Globs identifying test files, one per line. |
| `junit-paths` | `.` | Where to look for JUnit XML the run produced. |
| `setup-command` | — | Run in the base worktree before the tests. |
| `link-paths` | `node_modules` | Reuse an installed dependency tree instead of rebuilding it. |
| `on-green` | `fail` | What to do when tests pass on base: `fail`, `warn`, `pass`. |
| `on-unrunnable` | `pass` | What to do when they can't run on base. |
| `comment` | `true` | Post the result to the PR, updating in place. |
| `base` | PR base | Override the comparison point. |

Outputs: `outcome`, `tested-files`, `report`.

### Examples

```yaml
# Python
- uses: TridentIntelFree/redgreen@v1
  with:
    test-command: pytest {files} --junitxml=report.xml

# Go — the runner can't be scoped to a file list, so just run the package
- uses: TridentIntelFree/redgreen@v1
  with:
    test-command: go test ./...

# Start advisory while you see what it finds on your codebase
- uses: TridentIntelFree/redgreen@v1
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
4. Run the tests. Classify. Report. Remove the worktree.

## Limits

Worth knowing before you turn it on:

- **Flaky tests produce false "proven".** A test that fails intermittently
  fails on base too, and redgreen can't tell that from real evidence.
- **Refactors and docs PRs** have nothing to prove. They report *not
  applicable* rather than passing judgement.
- **Expensive suites** cost an extra run. Scope `test-command` with `{files}`
  where your runner allows it.
- **A proven test is not a good test.** It demonstrates the test observes the
  change. It says nothing about whether the change is correct, or whether the
  test covers the important case.
- Shallow clones don't work. `fetch-depth: 0`.

## Related

[Mutation testing](https://stryker-mutator.io/) asks a different question —
whether your suite would catch a hypothetical mutation — and is language-bound
and comparatively expensive. redgreen asks whether *this* pull request
contains a test that captures the change, costs one test run, and doesn't care
what language you're in. They complement each other.

## Development

```sh
npm test
```

No dependencies, no build step, no bundled `dist/`. This runs inside other
people's CI, so it should be auditable by reading it.

MIT.
