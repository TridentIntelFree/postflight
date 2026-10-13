// Identifying which changed files are tests.

/**
 * Conventions across the ecosystems people actually use. Deliberately broad:
 * a missed test file makes the check silently say "not applicable", which is
 * worse than evaluating one extra file.
 */
export const DEFAULT_PATTERNS = [
  // JS / TS
  '**/*.test.js', '**/*.test.ts', '**/*.test.jsx', '**/*.test.tsx',
  '**/*.spec.js', '**/*.spec.ts', '**/*.spec.jsx', '**/*.spec.tsx',
  '**/*.test.mjs', '**/*.test.cjs',
  '**/__tests__/**',
  // Python
  '**/test_*.py', '**/*_test.py',
  // Go
  '**/*_test.go',
  // Java / Kotlin
  '**/*Test.java', '**/*Tests.java', '**/*IT.java',
  '**/*Test.kt', '**/*Tests.kt', '**/*Spec.kt',
  // Ruby
  '**/*_spec.rb', '**/*_test.rb',
  // Rust / C#
  '**/tests/**/*.rs',
  '**/*Test.cs', '**/*Tests.cs',
  // Catch-all directories
  '**/test/**', '**/tests/**', '**/spec/**',
];

/**
 * Translate a glob to a RegExp.
 *
 * Supports `*`, `**`, `?` and `{a,b}`. `*` stops at a path separator while
 * `**` crosses them — the distinction that makes `**\/test/**` match a nested
 * `src/test/java/...` but keeps `*.test.js` from matching `a/b.test.js`
 * patterns it shouldn't.
 */
export function globToRegExp(glob) {
  let out = '';
  let i = 0;

  while (i < glob.length) {
    const c = glob[i];

    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may also match zero directories, so `**/x` matches a bare `x`.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }

    if (c === '?') { out += '[^/]'; i += 1; continue; }

    if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end !== -1) {
        const alts = glob.slice(i + 1, end).split(',').map(escapeLiteral);
        out += `(?:${alts.join('|')})`;
        i = end + 1;
        continue;
      }
    }

    out += escapeLiteral(c);
    i += 1;
  }

  return new RegExp(`^${out}$`);
}

function escapeLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalise a repo-relative path for matching. */
function normalise(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Select the test files from a list of changed paths.
 * Returns them sorted, so reports and comments are stable across re-runs.
 */
export function selectTestFiles(changedFiles, patterns = DEFAULT_PATTERNS) {
  const matchers = patterns.map(globToRegExp);
  return changedFiles
    .map(normalise)
    .filter((file) => matchers.some((re) => re.test(file)))
    .sort();
}
