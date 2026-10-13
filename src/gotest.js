// Reading `go test -json`.
//
// Go has no JUnit reporter, but it does have a structured event stream, which
// is strictly better than reading its prose. Parsing it gives per-test results
// and — the part that matters here — distinguishes a test that ran and failed
// from a package that never compiled. That distinction is the whole basis of
// this tool's verdicts, and inferring it from output text is how it has broken
// on every runner met so far.
//
// Events are newline-delimited JSON:
//   {"Action":"run","Package":"p","Test":"TestX"}
//   {"Action":"output","Package":"p","Test":"TestX","Output":"..."}
//   {"Action":"fail","Package":"p","Test":"TestX","Elapsed":0.01}
// A build failure appears as package-level output with no Test field.

const BUILD_FAILURE = /\[build failed\]|cannot find package|undefined:|syntax error|expected declaration|undeclared name/i;

/**
 * Convert a `go test -json` stream into the same case shape the JUnit parser
 * produces, so everything downstream is unchanged.
 */
export function parseGoJson(output) {
  const tests = new Map();     // "pkg.Test" -> case
  const packageOutput = [];    // lines with no Test attached
  const buildOutput = [];      // compile diagnostics, which arrive separately
  let buildFailed = false;
  let sawEvent = false;

  for (const line of String(output).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let e;
    try { e = JSON.parse(trimmed); } catch { continue; }
    if (!e.Action) continue;
    sawEvent = true;

    // Compile diagnostics come as their own actions, before any test exists.
    // Handled explicitly rather than inferred from the text of a later line,
    // so the reported message is the actual compile error.
    if (e.Action === 'build-output' && e.Output) { buildOutput.push(e.Output); continue; }
    if (e.Action === 'build-fail') { buildFailed = true; continue; }

    if (!e.Test) {
      if (e.Action === 'output' && e.Output) packageOutput.push(e.Output);
      continue;
    }

    const key = `${e.Package || ''}.${e.Test}`;
    if (!tests.has(key)) {
      tests.set(key, {
        name: e.Test,
        classname: e.Package || '',
        status: 'passed',
        type: null,
        message: '',
        output: [],
      });
    }
    const c = tests.get(key);

    if (e.Action === 'output' && e.Output) c.output.push(e.Output);
    else if (e.Action === 'fail') c.status = 'failed';
    else if (e.Action === 'skip') c.status = 'skipped';
    else if (e.Action === 'pass') c.status = 'passed';
  }

  if (!sawEvent) return null;   // not a -json stream; let the caller fall back

  const cases = [];
  for (const c of tests.values()) {
    const text = c.output.join('');
    if (c.status === 'failed') {
      // A test that ran and reported a failure is an assertion. Go surfaces
      // compile problems at the package level, not here, so anything that got
      // this far genuinely executed.
      c.type = 'failure';
      c.message = firstMeaningfulLine(text);
    }
    delete c.output;
    cases.push(c);
  }

  // Nothing ran because the package did not compile. Report it as an error
  // case so it classifies as "could not run" rather than as proof.
  if (cases.length === 0) {
    const text = buildOutput.join('') || packageOutput.join('');
    if (buildFailed || BUILD_FAILURE.test(text)) {
      return [{
        name: '(build)',
        classname: '',
        status: 'failed',
        type: 'error',
        message: firstMeaningfulLine(text),
      }];
    }
  }

  return cases;
}

function firstMeaningfulLine(text) {
  // Package banners like "# gt [gt.test]" are noise; the line after is the
  // diagnostic a reader actually wants.
  const skip = /^(=== RUN|=== PAUSE|=== CONT|--- PASS|#\s|\s*$)/;
  for (const line of text.split('\n')) {
    if (line.trim() && !skip.test(line)) return line.trim().slice(0, 500);
  }
  return '';
}
