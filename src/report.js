// Turning a verdict into something a reviewer — or an agent — can act on.

import { OUTCOME } from './classify.js';
import { determinismAdvice } from './nondeterminism.js';

const PRESENTATION = {
  [OUTCOME.RED]: {
    icon: '✅',
    title: 'Proven',
    lead: 'A test in this pull request fails on the base commit and passes here.',
    detail:
      'It ran against the unfixed code, observed it, and disagreed — so it ' +
      'captures the change rather than merely covering it.',
  },
  [OUTCOME.GREEN_ON_BASE]: {
    icon: '⚠️',
    title: 'Not proven',
    lead: 'The tests added here also pass on the base commit.',
    detail:
      'They run happily against the old code, so they do not capture any ' +
      'behaviour change. If this pull request fixes a bug, nothing here ' +
      'would have caught it.\n\n' +
      'This is information, not an accusation. A test written for behaviour ' +
      'that already worked is a perfectly good test and looks identical from ' +
      'here — only you know which this is.',
  },
  [OUTCOME.INCONCLUSIVE]: {
    icon: '⚠️',
    title: 'Inconclusive',
    lead: 'The tests could not run against the base commit, so nothing was proven either way.',
    detail:
      'They failed to load rather than failing an assertion — usually because ' +
      'they reference code this pull request introduces. That is expected for ' +
      'a new feature, and it is also what a test that checks nothing looks ' +
      'like. To get a real signal, a test needs to exercise the old code path ' +
      'and disagree with it.',
  },
  [OUTCOME.NOT_APPLICABLE]: {
    icon: '➖',
    title: 'No tests to check',
    lead: 'There is nothing for this check to prove.',
    detail:
      'Either no test files were touched, or the changes to them renamed, ' +
      'moved or removed tests without adding any. A pull request that ' +
      'asserts nothing new has nothing to disprove.',
  },
  [OUTCOME.ERROR]: {
    icon: '🔥',
    title: 'Check failed',
    lead: 'postflight could not complete.',
    detail: 'This is a problem with the check, not with the pull request.',
  },
};

const MARKER = '<!-- postflight-report -->';

export function buildReport(result) {
  let p = PRESENTATION[result.outcome] ?? PRESENTATION[OUTCOME.ERROR];
  if (result.diagnosis?.kind === 'references-new-code') {
    p = {
      ...p,
      icon: '➖',
      title: 'Nothing to prove yet',
      lead: 'These tests exercise code this pull request introduces.',
      // Deliberately short: the diagnosis below names what was missing, and
      // saying it twice in different words reads like the check is padding.
      detail: 'That is the normal shape of new work, not a fault.',
    };
  }

  // not-applicable otherwise explains that nothing was added, which is the
  // wrong story for a pull request that added tests and said what they are.
  if (result.reason === 'characterization') {
    p = {
      ...p,
      icon: '\u2713',
      title: 'Characterization tests',
      lead: 'Every test this pull request adds is marked as characterizing existing behaviour.',
      detail:
        'So there is nothing for this check to prove, and that is the ' +
        'author\u2019s call rather than a judgement: a test written for ' +
        'behaviour that already works is indistinguishable from an untested ' +
        'fix, and only the author knows which it is.',
    };
  }

  // "Inconclusive" otherwise explains a load error, which is the wrong story
  // for a result that ran fine twice and disagreed with itself.
  if (result.reason === 'not-reproducible') {
    p = {
      ...p,
      icon: '🎲',
      title: 'Not reproducible',
      lead: 'The same test gave two different answers on the same base commit.',
      detail:
        'So there is nothing to conclude from it, in either direction — a ' +
        'result that will not repeat is not evidence that a test captures the ' +
        'change, nor that it fails to.',
    };
  }
  const lines = [];

  lines.push(MARKER);
  lines.push(`### ${p.icon} postflight — ${p.title}`);
  lines.push('');
  lines.push(`**${p.lead}**`);
  lines.push('');
  lines.push(p.detail);

  // The per-case breakdown is the actionable part: "adds 3, 2 proven, 1
  // passes on base" tells a reviewer where to look, which a single word never
  // does. Shown above the file list because it matters more.
  const c = result.cases;
  if (c && c.total) {
    lines.push('');
    lines.push(`This pull request adds **${c.total}** test ${c.total === 1 ? 'case' : 'cases'}:`);
    lines.push('');
    lines.push('| | Test | On base |');
    lines.push('|---|---|---|');
    const row = (icon, name, note) =>
      lines.push(`| ${icon} | \`${String(name).replace(/\|/g, '\\|')}\` | ${note} |`);
    for (const r of c.proven) row('✅', r.name, 'failed — captures the change');
    for (const r of c.passed) row('⚠️', r.name, 'passed — proves nothing');
    for (const r of c.loadErrors) row('⚠️', r.name, 'could not run');
    for (const r of c.unmatched) row('❔', r.name, 'not found in the report');
  }

  if (result.files?.length) {
    lines.push('');
    lines.push(`<details><summary>Tests evaluated (${result.files.length})</summary>`);
    lines.push('');
    lines.push('```');
    lines.push(result.files.join('\n'));
    lines.push('```');
    lines.push('</details>');
  }

  // The diagnosis, when there is one, is the actionable part: it says which
  // of the three "could not run" situations this is and what to do, which a
  // stack trace does not.
  if (result.diagnosis) {
    lines.push('');
    lines.push(result.diagnosis.explanation);
  }

  // Marked cases are excluded from the verdict, so they have to be named.
  // A marker that silently suppresses the check is a hole in the check, and
  // a reviewer cannot notice what they are not shown.
  if (result.marked?.length) {
    const n = result.marked.length;
    lines.push('');
    lines.push(`${n === 1 ? 'One case is' : `${n} cases are`} marked ` +
      '`postflight: characterization` and excluded from the verdict:');
    lines.push('');
    for (const name of result.marked) lines.push(`- \`${name}\``);
  }

  // A sampled, unseeded test makes everything above probabilistic, so say so
  // next to the verdict rather than in a footnote. The author is the only one
  // who can fix it.
  const advice = determinismAdvice(result.determinism || {});
  if (advice) {
    lines.push('');
    lines.push(advice);
  }

  if (result.evidence) {
    lines.push('');
    lines.push('<details><summary>What the base run reported</summary>');
    lines.push('');
    lines.push('```');
    lines.push(clip(result.evidence, 4000));
    lines.push('```');
    lines.push('</details>');
  }

  if (result.error) {
    lines.push('');
    lines.push('```');
    lines.push(clip(result.error, 2000));
    lines.push('```');
  }

  // A compact machine-readable block. The whole point of this Action is to
  // feed a decision; an agent reading the thread should not have to parse
  // prose to find the verdict.
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({
    tool: 'postflight',
    outcome: result.outcome,
    reason: result.reason ?? null,
    base: result.baseSha?.slice(0, 12) ?? null,
    head: result.headSha?.slice(0, 12) ?? null,
    filesEvaluated: result.files?.length ?? 0,
    cases: c ? {
      added: c.total,
      proven: c.proven.length,
      passedOnBase: c.passed.length,
      couldNotRun: c.loadErrors.length,
      unmatched: c.unmatched.length,
      provenNames: c.proven.map((r) => r.name),
      passedOnBaseNames: c.passed.map((r) => r.name),
    } : null,
  }, null, 2));
  lines.push('```');

  return lines.join('\n');
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/**
 * Post the report, replacing postflight's previous comment rather than adding
 * to a pile of them. Never throws: losing the comment must not lose the
 * verdict, which is also an output and a job summary.
 */
export async function postComment({ token, repo, prNumber, body, log }) {
  if (!token || !prNumber || !repo) return false;

  const api = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  try {
    const existing = await fetch(`${api}?per_page=100`, { headers });
    if (existing.ok) {
      const comments = await existing.json();
      const mine = comments.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
      if (mine) {
        const res = await fetch(
          `https://api.github.com/repos/${repo}/issues/comments/${mine.id}`,
          { method: 'PATCH', headers, body: JSON.stringify({ body }) }
        );
        if (res.ok) return true;
      }
    }

    const res = await fetch(api, { method: 'POST', headers, body: JSON.stringify({ body }) });
    if (!res.ok) {
      log?.warn(`Could not post the report (${res.status}). The verdict is in the job summary.`);
      return false;
    }
    return true;
  } catch (err) {
    log?.warn(`Could not post the report: ${err.message}`);
    return false;
  }
}

export const _internal = { MARKER, PRESENTATION };
