// Tests that live inside the file they test.
//
// Rust puts unit tests in the source file, in a `#[cfg(test)] mod tests`
// block. That breaks the central mechanism: postflight proves a test by
// laying the HEAD version of the test file over the BASE source — but here
// they are the same file, so overlaying it would bring the fix along with the
// test and the test would be run against the code it is supposed to be
// judging.
//
// Demonstrated before building: a plain Rust crate with a real fix and a new
// `#[test]` reported `not-applicable (no-test-files)`. postflight silently
// did nothing for the majority of Rust projects, because only integration
// tests under `tests/` were ever recognised.
//
// The answer is to splice rather than overlay: take the head file's test
// blocks and put them into the base file, keeping everything else at base.
// The test is then head's, and the code under it is base's, which is exactly
// the comparison the tool exists to make.

/** Does this diff add a test inside a non-test file? */
export function addsInlineTests(addedLines = []) {
  return addedLines.some((l) => /^\s*#\[\s*test\s*\]|^\s*#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(l));
}

/**
 * Find each `#[cfg(test)]` module in a Rust source file.
 *
 * Returns `{ start, end }` character offsets covering the attribute and its
 * module, so a caller can cut or replace them. Braces are counted rather than
 * matched by regex, because a test module contains arbitrary code — including
 * nested braces, and strings and comments that contain braces of their own.
 */
export function findTestBlocks(source) {
  const text = String(source);
  const blocks = [];
  const attribute = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g;

  let match;
  while ((match = attribute.exec(text)) !== null) {
    const open = text.indexOf('{', match.index);
    if (open === -1) continue;
    const close = matchBrace(text, open);
    if (close === -1) continue;
    blocks.push({ start: match.index, end: close + 1 });
    attribute.lastIndex = close + 1;
  }
  return blocks;
}

/**
 * Walk forward from an opening brace to its partner.
 *
 * Strings, chars, raw strings and both comment forms are skipped, because a
 * brace inside any of them is not a brace. Getting this wrong would truncate
 * a test module mid-function and the file would not compile — which would
 * read as "the test could not run against base", a plausible-looking lie.
 */
function matchBrace(text, open) {
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    const c = text[i];

    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i === -1) return -1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      // Rust block comments nest, so they have to be counted too.
      let nested = 1;
      i += 2;
      while (i < text.length && nested > 0) {
        if (text[i] === '/' && text[i + 1] === '*') { nested += 1; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === '/') { nested -= 1; i += 2; continue; }
        i += 1;
      }
      i -= 1;
      continue;
    }
    if (c === 'r' && (text[i + 1] === '"' || text[i + 1] === '#')) {
      const raw = skipRawString(text, i);
      if (raw > i) { i = raw; continue; }
    }
    if (c === '"') {
      i = skipQuoted(text, i, '"');
      if (i === -1) return -1;
      continue;
    }
    if (c === "'") {
      // Could be a char literal or a lifetime (`'a`). A lifetime is not
      // quoted, so only treat it as a literal when it closes on the same line.
      const closed = skipQuoted(text, i, "'");
      if (closed !== -1 && !text.slice(i, closed).includes('\n')) { i = closed; continue; }
    }

    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Skip a `r"…"` or `r#"…"#` raw string. Returns the closing index, or `from`. */
function skipRawString(text, from) {
  let i = from + 1;
  let hashes = 0;
  while (text[i] === '#') { hashes += 1; i += 1; }
  if (text[i] !== '"') return from;
  const terminator = `"${'#'.repeat(hashes)}`;
  const end = text.indexOf(terminator, i + 1);
  return end === -1 ? from : end + terminator.length - 1;
}

/** Skip a quoted literal, honouring backslash escapes. */
function skipQuoted(text, from, quote) {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === quote) return i;
  }
  return -1;
}

/**
 * Put head's test blocks into base's source.
 *
 * Base keeps everything outside its `#[cfg(test)]` modules — the code being
 * judged — and gets head's test modules in their place. Appended when base
 * has none, which is the common case for a pull request adding the first
 * test to a file.
 *
 * Returns null when head has no test blocks, so the caller can fall back to
 * an ordinary overlay rather than silently splicing nothing.
 */
export function spliceTestBlocks(baseSource, headSource) {
  const headBlocks = findTestBlocks(headSource);
  if (!headBlocks.length) return null;

  const tests = headBlocks.map((b) => String(headSource).slice(b.start, b.end)).join('\n\n');
  const baseBlocks = findTestBlocks(baseSource);

  if (!baseBlocks.length) {
    return `${String(baseSource).replace(/\s*$/, '')}\n\n${tests}\n`;
  }

  // Replace base's blocks with head's, back to front so earlier offsets stay
  // valid, and put the whole set where base's first block was.
  let out = String(baseSource);
  for (let i = baseBlocks.length - 1; i >= 0; i--) {
    const b = baseBlocks[i];
    out = out.slice(0, b.start) + (i === 0 ? tests : '') + out.slice(b.end);
  }
  return out;
}
