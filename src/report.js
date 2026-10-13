// Turning a verdict into something a reviewer — or an agent — can act on.

import { OUTCOME } from './classify.js';

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
    icon: '❌',
    title: 'Not proven',
    lead: 'Every test this pull request touches also passes on the base commit.',
    detail:
      'These tests run happily against the unfixed code, so whatever they ' +
      'check, it is not what this pull request changed. If this is a fix, it ' +
      'has no test that would have caught the bug.',
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
    lead: 'This pull request does not touch any test files.',
    detail: 'Nothing to prove, so nothing was run.',
  },
  [OUTCOME.ERROR]: {
    icon: '🔥',
    title: 'Check failed',
    lead: 'redgreen could not complete.',
    detail: 'This is a problem with the check, not with the pull request.',
  },
};

const MARKER = '<!-- redgreen-report -->';

export function buildReport(result) {
  const p = PRESENTATION[result.outcome] ?? PRESENTATION[OUTCOME.ERROR];
  const lines = [];

  lines.push(MARKER);
  lines.push(`### ${p.icon} redgreen — ${p.title}`);
  lines.push('');
  lines.push(`**${p.lead}**`);
  lines.push('');
  lines.push(p.detail);

  if (result.files?.length) {
    lines.push('');
    lines.push(`<details><summary>Tests evaluated (${result.files.length})</summary>`);
    lines.push('');
    lines.push('```');
    lines.push(result.files.join('\n'));
    lines.push('```');
    lines.push('</details>');
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
    tool: 'redgreen',
    outcome: result.outcome,
    reason: result.reason ?? null,
    base: result.baseSha?.slice(0, 12) ?? null,
    head: result.headSha?.slice(0, 12) ?? null,
    testsEvaluated: result.files?.length ?? 0,
  }, null, 2));
  lines.push('```');

  return lines.join('\n');
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/**
 * Post the report, replacing redgreen's previous comment rather than adding
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
