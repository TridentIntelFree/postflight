# Benchmark harness

Measures postflight against real project history, so claims about it are
numbers rather than opinions. Every published figure came from here.

The method: take commits that changed both source and tests, treat each as
`base = commit^`, `head = commit`, and run the action exactly as CI would.

```sh
# Node / mocha
git clone --filter=blob:none https://github.com/expressjs/express.git
(cd express && npm install)
./pick.py express 'test/.*\.js$' 'lib/.*\.js$' > /tmp/list.txt
./run.sh express "npx mocha --require test/support/env --reporter xunit \
    --reporter-option output=pf-report.xml {files}" /tmp/list.txt out.csv

# Python / pytest
git clone --filter=blob:none https://github.com/pallets/click.git
(cd click && python3 -m venv .venv && .venv/bin/pip install -e . pytest)
./pick.py click 'tests/.*\.py$' 'src/.*\.py$' > /tmp/list.txt
LINKS=".venv" ./run.sh click ".venv/bin/python -m pytest {files} -q \
    --junitxml=pf-report.xml" /tmp/list.txt out.csv
```

## What it has caught

Every one of these was invisible to unit tests and only appeared against real
history:

| | |
|---|---|
| Mocha output unrecognised | `/\bFAIL\b/` does not match `1 failing`, so real assertion failures were reported inconclusive |
| Renamed tests counted as new | a typo fix in a test title was reported "not proven" |
| Refactors reported as findings | 9 of 24 commits asserted nothing new |
| Command-not-found reported as a verdict | every non-Node project hit this, since the base worktree has no virtualenv |

## Reading the results

`green-on-base` is the only verdict that can accuse anyone, so its precision
is the number that matters. Verify them by hand before trusting a rate — the
tool cannot know intent, and a test written for behaviour that already worked
is indistinguishable from an untested fix.

Rates vary enormously by project: 4% green-on-base on express, 45% on click,
whose history is largely deprecations and typing changes where tests
legitimately pass on base.
