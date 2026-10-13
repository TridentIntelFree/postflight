// Does a diff actually change behaviour?
//
// A pull request whose source change is comments, blank lines or formatting
// has changed nothing a test could observe. Reporting "your test does not
// prove anything" against it is true and useless — measured against real
// history, that was the last surviving false alarm: a commit whose entire
// source change was JSDoc.
//
// This is a heuristic and deliberately a conservative one. It only ever
// SILENCES the check, so a wrong answer here costs a missed finding, never a
// false accusation.

/** Line prefixes that begin a whole-line comment, across common languages. */
const COMMENT_PREFIXES = [
  '//',     // C, Java, JS, Go, Rust, Kotlin, Swift
  '/*', '*/', '*',  // block comments and their continuation lines
  '#',      // Python, Ruby, Shell, YAML, Perl
  '--',     // SQL, Haskell, Lua
  ';',      // Lisp, assembly, ini
  '%',      // Erlang, LaTeX
  '"""', "'''",     // Python docstring delimiters
];

/**
 * Is this line incapable of changing behaviour on its own?
 * Blank lines, whole-line comments, and lone braces.
 */
export function isNonBehavioural(line) {
  const t = line.trim();
  if (t === '') return true;
  // A lone delimiter moving around is formatting, not behaviour.
  if (/^[{}()[\];,]+$/.test(t)) return true;
  return COMMENT_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * Given the lines a pull request changed in its NON-test files, decide
 * whether any of them could alter behaviour.
 *
 * Returns false only when there were source changes and every one of them was
 * inert — never for an empty diff, which means something else is going on and
 * is not ours to interpret.
 */
export function changesBehaviour(added, removed) {
  const lines = [...added, ...removed];
  if (lines.length === 0) return true;
  return lines.some((line) => !isNonBehavioural(line));
}
