import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addsInlineTests, findTestBlocks, spliceTestBlocks } from '../src/inline.js';

// Rust puts unit tests inside the file they test. Overlaying that file would
// bring the fix along with the test, so the test would be run against the
// code it is supposed to be judging — and every verdict would be a lie in the
// most flattering direction.
//
// Before this existed, a plain Rust crate with a real fix and a new #[test]
// reported `not-applicable (no-test-files)`: postflight silently did nothing
// for the majority of Rust projects.

const BASE = `pub fn divide(a: i32, b: i32) -> Option<i32> {
    Some(a / b)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn divides() {
        assert_eq!(divide(6, 2), Some(3));
    }
}
`;

const HEAD = `pub fn divide(a: i32, b: i32) -> Option<i32> {
    if b == 0 { return None; }
    Some(a / b)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn divides() {
        assert_eq!(divide(6, 2), Some(3));
    }
    #[test]
    fn rejects_zero() {
        assert_eq!(divide(1, 0), None);
    }
}
`;

test('an added #[test] marks the file as carrying tests', () => {
  assert.equal(addsInlineTests(['    #[test]', '    fn rejects_zero() {']), true);
  assert.equal(addsInlineTests(['#[cfg(test)]', 'mod tests {']), true);
  assert.equal(addsInlineTests(['    if b == 0 { return None; }']), false);
  assert.equal(addsInlineTests([]), false);
});

test('the splice keeps base code and takes head tests', () => {
  // The whole point. If the guard came across with the test, the test would
  // pass and postflight would call it proven when it proved nothing.
  const spliced = spliceTestBlocks(BASE, HEAD);
  assert.ok(!spliced.includes('if b == 0'),
    "base's unfixed divide() must survive — otherwise the fix is under test");
  assert.ok(spliced.includes('fn rejects_zero'), "head's new test must be present");
  assert.ok(spliced.includes('fn divides'), 'and its siblings');
});

test('a file with no test block yet gets head tests appended', () => {
  // The common case for a pull request adding the first test to a file.
  const base = 'pub fn divide(a: i32, b: i32) -> i32 { a / b }\n';
  const spliced = spliceTestBlocks(base, HEAD);
  assert.ok(spliced.startsWith('pub fn divide(a: i32, b: i32) -> i32 { a / b }'));
  assert.ok(spliced.includes('fn rejects_zero'));
  assert.ok(!spliced.includes('if b == 0'));
});

test('head with no tests returns null so the caller falls back', () => {
  assert.equal(spliceTestBlocks(BASE, 'pub fn x() {}\n'), null);
});

test('braces inside strings and comments do not truncate the module', () => {
  // Getting this wrong cuts the module mid-function, the file will not
  // compile, and the result reads as "the test could not run against base" —
  // a plausible-looking lie rather than an obvious failure.
  //
  // The sentinel is the whole point. An earlier version of this test asserted
  // only that the captured text ended in `}` and contained the assertion —
  // both of which are TRUE of a block truncated at the inner function's
  // closing brace, because a `}` is a `}`. It passed against deliberately
  // broken brace matching. Something that can only appear after the tricky
  // code, and before the module's own brace, is the assertion that bites.
  const head = `pub fn f() {}

#[cfg(test)]
mod tests {
    #[test]
    fn braces_in_strings() {
        let s = "}{ unbalanced }";
        let r = r#"a quote " then } } } unbalanced"#;
        let c = '}';
        // a comment with }
        /* nested /* block } } */ with } */
        assert_eq!(s.len() + r.len() + 1, s.len() + r.len() + 1);
    }

    #[test]
    fn sentinel_after_the_tricky_one() {}
}
`;
  const blocks = findTestBlocks(head);
  assert.equal(blocks.length, 1);
  const captured = head.slice(blocks[0].start, blocks[0].end);
  assert.ok(captured.includes('sentinel_after_the_tricky_one'),
    'the block was truncated: brace matching stopped inside the first test');
  assert.ok(captured.includes('assert_eq!'), 'and it must contain the whole test');
  assert.equal(blocks[0].end, head.lastIndexOf('}') + 1,
    "the block must end at the MODULE's closing brace, not an inner one");
});

test('several test modules in one file are all carried over', () => {
  const head = `pub fn a() {}
#[cfg(test)]
mod first { #[test] fn one() {} }
pub fn b() {}
#[cfg(test)]
mod second { #[test] fn two() {} }
`;
  assert.equal(findTestBlocks(head).length, 2);
  const spliced = spliceTestBlocks('pub fn a() {}\npub fn b() {}\n', head);
  assert.ok(spliced.includes('fn one'));
  assert.ok(spliced.includes('fn two'));
});

test('base keeps its non-test code when replacing several blocks', () => {
  const base = `pub fn a() {}
#[cfg(test)]
mod first { #[test] fn stale() {} }
pub fn b() {}
#[cfg(test)]
mod second { #[test] fn also_stale() {} }
pub fn c() {}
`;
  const head = `pub fn a() {}
#[cfg(test)]
mod tests { #[test] fn fresh() {} }
`;
  const spliced = spliceTestBlocks(base, head);
  for (const kept of ['pub fn a()', 'pub fn b()', 'pub fn c()']) {
    assert.ok(spliced.includes(kept), `${kept} must survive`);
  }
  assert.ok(spliced.includes('fn fresh'));
  assert.ok(!spliced.includes('fn stale'), "base's old tests must not linger");
  assert.ok(!spliced.includes('fn also_stale'));
});

test('an attribute with odd spacing is still recognised', () => {
  // rustfmt does not produce these, but people do.
  for (const attribute of ['#[cfg(test)]', '#[ cfg( test ) ]', '# [cfg(test)]']) {
    const source = `pub fn a() {}\n${attribute}\nmod t { #[test] fn x() {} }\n`;
    assert.equal(findTestBlocks(source).length, 1, `should match: ${attribute}`);
  }
});

test('a malformed block is skipped rather than guessed at', () => {
  // An unclosed module means the file does not parse; splicing something
  // half-formed would turn that into a confusing verdict.
  assert.deepEqual(findTestBlocks('#[cfg(test)]\nmod t { #[test] fn x() {}'), []);
  assert.deepEqual(findTestBlocks('#[cfg(test)]'), []);
});
