// Reading `cargo test` output.
//
// cargo was the last runner with no per-case verdicts, which matters more
// than it sounds: without them the verdict falls back to FILE level, and
// file-level scoring was measured over-crediting 24% of pull requests on
// click — crediting an author for failures in tests they did not write.
//
// There is no stable structured output to use. libtest's `--format json`
// needs `-Z unstable-options`, which is nightly only. But libtest's prose is
// strictly formatted and has been for years:
//
//   running 2 tests
//   test tests::passes_positives_through ... ok
//   test tests::clamps_negatives_to_zero ... FAILED
//
//   ---- tests::clamps_negatives_to_zero stdout ----
//   assertion `left == right` failed
//     left: -5
//    right: 0
//
// Rust also makes the distinction this tool rests on unusually clean. If the
// code a test reaches for does not exist, the crate does not COMPILE — so a
// panic always means the test ran and disagreed, and a compile error always
// means it never ran. No other runner separates them so plainly.

/** `test <name> ... <result>`, with the result words libtest actually emits. */
const CASE = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED|ignored)\b/;
const DETAIL = /^----\s+(\S+)\s+stdout\s+----$/;
const COMPILE_ERROR = /^error(?:\[E\d+\])?:/m;
const COULD_NOT_COMPILE = /^error: could not compile `([^`]+)`/m;

/**
 * Convert `cargo test` output into the same case shape the JUnit parser
 * produces. Returns null when the text is not cargo output, so the caller
 * falls back rather than reporting nonsense.
 */
export function parseCargoTest(text) {
  const output = String(text || '');
  if (!output) return null;

  const lines = output.split('\n');
  const cases = [];
  const messages = collectMessages(lines);

  for (const line of lines) {
    const m = line.match(CASE);
    if (!m) continue;
    const [, name, result] = m;
    const status = result === 'ok' ? 'passed' : result === 'ignored' ? 'skipped' : 'failed';
    cases.push({
      name,
      classname: '',
      status,
      // A panic means the code ran. Only a compile error means it did not,
      // and that never reaches this level.
      type: status === 'failed' ? 'failure' : null,
      message: messages.get(name) || '',
    });
  }

  // The crate did not compile, so nothing ran. Reported as one error case so
  // it classifies as "could not run" and can never be read as proof.
  if (cases.length === 0) {
    if (!COMPILE_ERROR.test(output)) return null;   // not cargo output at all
    const crate = output.match(COULD_NOT_COMPILE);
    return [{
      name: crate ? `${crate[1]} (compile)` : '(compile)',
      classname: '',
      status: 'failed',
      type: 'error',
      message: compileErrors(lines),
    }];
  }

  return cases;
}

/**
 * Pull each failure's detail out of the `---- name stdout ----` blocks.
 *
 * The backtrace is dropped: it is dozens of lines of rustc internals and the
 * assertion is the part a reviewer wants.
 */
function collectMessages(lines) {
  const messages = new Map();
  let current = null;
  let buffer = [];

  const flush = () => {
    if (current) messages.set(current, buffer.join('\n').trim().slice(0, 2000));
    current = null;
    buffer = [];
  };

  for (const line of lines) {
    const start = line.match(DETAIL);
    if (start) {
      flush();
      current = start[1];
      continue;
    }
    if (!current) continue;
    if (/^(failures:|test result:|stack backtrace:)/.test(line.trim())) {
      flush();
      continue;
    }
    // The `panicked at src/lib.rs:16:9:` line is location, not reasoning.
    if (/^thread '.*' .*panicked at /.test(line)) continue;
    buffer.push(line);
  }
  flush();
  return messages;
}

/** The compiler's own errors, without the surrounding noise. */
function compileErrors(lines) {
  const kept = [];
  for (const line of lines) {
    if (/^error(?:\[E\d+\])?:/.test(line) || /^\s*-->/.test(line)) kept.push(line.trimEnd());
    if (kept.length >= 12) break;
  }
  return kept.join('\n').slice(0, 2000);
}
