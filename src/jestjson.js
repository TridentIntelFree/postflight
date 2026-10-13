// Reading jest's `--json` report.
//
// jest has no JUnit reporter without the separate jest-junit package, which
// cannot be assumed present. Its own `--json` output is structured and
// sufficient, and it draws the distinction this tool rests on clearly:
//
//   a suite that RAN      has entries in assertionResults, each with a status
//   a suite that NEVER    has assertionResults: [] and a message explaining
//     loaded                why, counted in numRuntimeErrorTestSuites
//
// So an import error cannot be mistaken for a test that ran and disagreed,
// which is the mistake that makes a tool like this worse than useless.

import { basename } from 'node:path';

/**
 * Convert a jest `--json` report into the same case shape the JUnit parser
 * produces. Returns null when the text is not a jest report, so the caller
 * can fall back rather than report nonsense.
 */
export function parseJestJson(text) {
  let report;
  try {
    report = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!report || !Array.isArray(report.testResults)) return null;

  const cases = [];

  for (const suite of report.testResults) {
    const file = suite.name ? basename(suite.name) : '';
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];

    // No assertions and a failed suite means the file never ran. Reported as
    // one error case so it classifies as "could not run", never as proof.
    if (assertions.length === 0) {
      if (suite.status === 'failed' || suite.message) {
        cases.push({
          name: file || '(suite)',
          classname: '',
          status: 'failed',
          type: 'error',
          message: cleanMessage(suite.message),
        });
      }
      continue;
    }

    for (const a of assertions) {
      const status = normaliseStatus(a.status);
      cases.push({
        name: a.fullName || a.title || '(unnamed)',
        classname: (a.ancestorTitles || []).join(' ') || file,
        status,
        // A failing assertion is the only thing jest reports at this level;
        // anything that prevented the file running was handled above.
        type: status === 'failed' ? 'failure' : null,
        message: cleanMessage((a.failureMessages || []).join('\n')),
      });
    }
  }

  return cases;
}

function normaliseStatus(status) {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  return 'skipped';   // pending, todo, disabled
}

/** Strip ANSI colour and the leading bullet jest decorates messages with. */
function cleanMessage(message) {
  if (!message) return '';
  return String(message)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*●\s*/, '').trimEnd())
    .filter((l) => l.trim())
    .join('\n')
    .slice(0, 2000);
}
