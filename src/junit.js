// A small JUnit XML reader.
//
// Why bother: JUnit XML already draws the distinction this whole Action turns
// on. `<failure>` is an assertion that did not hold — the test ran, observed
// the code, and disagreed with it. `<error>` is the test not running at all:
// an import blew up, a fixture raised, the file would not compile.
//
// Scanning stdout for those two cases means guessing from prose that differs
// per runner and per locale. When a report file exists, it is simply told to
// us, so prefer it and fall back to heuristics only when it is absent.

/** Parse one or more JUnit XML documents into a flat list of test cases. */
export function parseJUnit(xml) {
  const cases = [];
  // Matches both `<testcase .../>` and `<testcase ...>…</testcase>`.
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase\s*>)/g;

  let match;
  while ((match = re.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1]);
    const body = match[3] || '';

    let status = 'passed';
    let type = null;
    let message = '';

    if (/<failure\b/.test(body)) {
      status = 'failed';
      type = 'failure';
      message = extractMessage(body, 'failure');
    } else if (/<error\b/.test(body)) {
      status = 'failed';
      type = 'error';
      message = extractMessage(body, 'error');
    } else if (/<skipped\b/.test(body)) {
      status = 'skipped';
    }

    cases.push({
      name: attrs.name || '(unnamed)',
      classname: attrs.classname || '',
      file: attrs.file || '',
      status,
      type,
      message: message.trim(),
    });
  }

  return cases;
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1] ?? m[3];
    const value = m[2] ?? m[4];
    attrs[key] = decodeEntities(value);
  }
  return attrs;
}

function extractMessage(body, tag) {
  const open = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)<\\/${tag}\\s*>)`);
  const m = body.match(open);
  if (!m) return '';
  const attrs = parseAttrs(m[1] || '');
  const inner = stripCdata(m[2] || '');
  // The `message` attribute is the summary; the body is the stack trace.
  return [attrs.message, inner].filter(Boolean).join('\n');
}

function stripCdata(text) {
  return decodeEntities(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&'); // last, so `&amp;lt;` survives as `&lt;`
}

/**
 * Reduce a set of cases to what the check needs: did anything fail, and was
 * it a real assertion or a test that never ran?
 */
export function summarise(cases) {
  const failures = cases.filter((c) => c.type === 'failure');
  const errors = cases.filter((c) => c.type === 'error');
  return {
    total: cases.length,
    passed: cases.filter((c) => c.status === 'passed').length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    failures,
    errors,
    hasAssertionFailure: failures.length > 0,
    hasLoadError: errors.length > 0,
  };
}

/**
 * Accept either JUnit XML or already-parsed cases and return cases.
 *
 * Runners arrive here through different routes — an XML report, their own
 * structured stream — and everything downstream should be able to ignore
 * which.
 */
export function toCases(report) {
  if (!report) return [];
  return Array.isArray(report) ? report : parseJUnit(report);
}
