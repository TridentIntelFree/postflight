// Reading rspec's `--format json` report.
//
// rspec has no JUnit output without the separate rspec_junit_formatter gem,
// which cannot be assumed present. Its own JSON formatter is built in, stable,
// and names the distinction this tool rests on outright:
//
//   errors_outside_of_examples_count   a spec file could not be loaded
//   examples[].status                  what each example that ran did
//
// Worth noting: when ANY spec file fails to load, rspec runs nothing at all —
// `example_count` is 0 even for files that were perfectly loadable. That is
// unlike jest, which runs the healthy suites anyway. It makes rspec the one
// runner that cannot produce the mixed report that caught both jest and
// node:test, because there is never a real result sitting beside a load error.
//
// The hard part is not the load error. It is that rspec reports a Ruby
// exception raised INSIDE an example as `status: "failed"`, exactly like a
// failed expectation — so "failed" alone cannot be read as proof. See
// isMissingCode().

/**
 * Convert an rspec `--format json` report into the same case shape the JUnit
 * parser produces. Returns null when the text is not an rspec report, so the
 * caller can fall back rather than report nonsense.
 */
export function parseRspecJson(text) {
  let report;
  try {
    report = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!report || !Array.isArray(report.examples) || typeof report.summary !== 'object'
      || report.summary === null || typeof report.summary.example_count !== 'number') {
    return null;
  }

  const cases = [];

  // Nothing ran because a spec file would not load. Reported as one error
  // case so it classifies as "could not run", never as proof.
  if (report.examples.length === 0) {
    if ((report.summary.errors_outside_of_examples_count || 0) > 0) {
      const messages = (report.messages || []).join('\n');
      cases.push({
        name: loadErrorFile(messages) || '(spec load error)',
        classname: '',
        status: 'failed',
        type: 'error',
        message: clean(messages),
      });
    }
    return cases;
  }

  for (const e of report.examples) {
    const status = normaliseStatus(e.status);
    const exception = e.exception || {};
    cases.push({
      // full_description carries the describe prefix, the way mocha's does;
      // the name matcher already scores a suite-prefixed name.
      name: e.full_description || e.description || '(unnamed)',
      classname: '',
      file: e.file_path || '',
      status,
      type: status !== 'failed' ? null
        : (isMissingCode(exception) ? 'error' : 'failure'),
      message: clean([exception.class, exception.message].filter(Boolean).join(': ')),
    });
  }

  return cases;
}

/**
 * Exceptions that mean the code the example reaches for is not there, as
 * opposed to there and misbehaving.
 *
 * This is the whole judgement for rspec, and getting it backwards in either
 * direction is costly:
 *
 *   too eager   a genuine runtime error the fix addresses — a nil crash, a
 *               division by zero — gets called "could not run", and a true
 *               finding is lost.
 *   too lax     a spec calling a method the pull request introduces gets
 *               called proof, which is the false credit this tool exists to
 *               avoid.
 *
 * So it is a named list, not a catch-all. A Ruby exception from code that
 * EXISTS is a real observation of base behaviour and stays a failure:
 * ZeroDivisionError, TypeError, RuntimeError, a deliberately raised
 * ArgumentError. Only the "that name does not exist" family is an error.
 *
 * NoMethodError sits on both sides of the line, and the message says which.
 * Verified against real rspec output rather than assumed:
 *
 *   undefined method `modulo' for module Calc    the method is not there
 *   undefined method `fetch' for nil             the code RAN and hit a nil,
 *                                                  the classic Ruby bug a fix
 *                                                  like this captures
 *
 * A receiver of nil is therefore kept as a failure. Anything else of that
 * family is an error.
 */
const MISSING_CODE = new Set([
  'NoMethodError', 'NameError', 'LoadError', 'NotImplementedError',
]);

function isMissingCode(exception) {
  const cls = exception.class || '';
  if (!MISSING_CODE.has(cls)) return false;

  // `for nil`, or Ruby 3.4's wording, `for an instance of NilClass`.
  const message = exception.message || '';
  if (/\bfor (?:nil\b|an instance of NilClass\b)/.test(message)) return false;

  return true;
}

function normaliseStatus(status) {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  return 'skipped';   // pending
}

/** rspec names the offending file in its load-error message. */
function loadErrorFile(messages) {
  // The trailing period ends the sentence, so it must not be allowed to eat
  // the file extension: `loading ./spec/a_spec.rb. - Did you mean?`
  const m = String(messages).match(/An error occurred while loading (\S+?)\.(?:\s|$)/);
  return m ? m[1] : '';
}

function clean(message) {
  if (!message) return '';
  return String(message)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .join('\n')
    .slice(0, 2000);
}
