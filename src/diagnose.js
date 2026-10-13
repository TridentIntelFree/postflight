// Working out WHY a test could not run against the base commit.
//
// "Could not run" is currently one verdict covering three situations that
// call for completely different responses:
//
//   references new code   The test imports something this pull request adds.
//                         Expected, benign, and the normal state of affairs
//                         for a new feature. Nothing to do.
//   dependency drift      The pull request changes its dependency manifest,
//                         so the installed tree belongs to head, not base.
//   broken environment    Something the project needs is not installed at
//                         all, in either commit. A setup problem.
//
// Telling someone "inconclusive" and leaving them to read a stack trace is
// how a check gets ignored. The first case in particular is not a problem and
// should not read like one.

/** Dependency manifests and lockfiles, across ecosystems. */
const DEPENDENCY_FILES = [
  /(^|\/)package(-lock)?\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)npm-shrinkwrap\.json$/,
  /(^|\/)requirements[^/]*\.txt$/, /(^|\/)pyproject\.toml$/, /(^|\/)setup\.(py|cfg)$/,
  /(^|\/)Pipfile(\.lock)?$/, /(^|\/)poetry\.lock$/, /(^|\/)uv\.lock$/,
  /(^|\/)go\.(mod|sum)$/,
  /(^|\/)Cargo\.(toml|lock)$/,
  /(^|\/)Gemfile(\.lock)?$/,
  /(^|\/)pom\.xml$/, /(^|\/)build\.gradle(\.kts)?$/, /(^|\/)gradle\.lockfile$/,
  /(^|\/)composer\.(json|lock)$/,
];

export function changesDependencies(changedFiles = []) {
  return changedFiles.some((f) => DEPENDENCY_FILES.some((re) => re.test(f)));
}

export function isDependencyFile(path) {
  return DEPENDENCY_FILES.some((re) => re.test(path));
}

/**
 * Does the dependency diff actually mention this package?
 *
 * A pull request can touch its manifest for reasons unrelated to the package
 * that went missing — bumping a version, adding a classifier, editing build
 * config. Calling that "drift" sends the author to look at a file that is not
 * the problem, which is precisely the failure this module exists to avoid.
 * So the manifest changing is a hint; the name appearing in it is the
 * evidence.
 */
function driftMentions(name, dependencyDiff) {
  const leaf = name.split(/[./\\]/)[0];
  if (!leaf) return false;
  // Package names use - and _ interchangeably with the importable module
  // name (typing_extensions / typing-extensions, PyYAML / yaml).
  const loose = escape(leaf).replace(/[-_]/g, '[-_]');
  const re = new RegExp(`(^|[^\\w-])${loose}($|[^\\w-])`, 'i');
  return dependencyDiff.some((l) => re.test(l));
}

/**
 * Pull the name of whatever could not be found out of a runner's error.
 * Returns an array because a message may name both a module and a symbol.
 */
export function missingNames(message = '') {
  const names = new Set();
  const patterns = [
    /No module named '([^']+)'/g,                       // Python
    /cannot import name '([^']+)'/g,                    // Python
    /Cannot find module '([^']+)'/g,                    // Node CJS
    /does not provide an export named '([^']+)'/g,      // Node ESM
    /Cannot find name '([^']+)'/g,                      // TypeScript
    // A bundler rewrites a named import to a property access, so a missing
    // export never surfaces as an import error at all — it becomes
    // `undefined`, then a TypeError at the call site. This is how vitest
    // reported a test that never ran as an ordinary assertion failure.
    // The trailing `\)?` matters: esbuild's rewrite produces
    // `(0 , modulo) is not a function`, so the name is not adjacent to the
    // phrase. Without it this matched nothing on the output that motivated it.
    /\b(\w+)\)? is not a function/g,                    // JS runtime
    /\b(\w+)\)? is not defined/g,                       // JS runtime
    /Cannot read propert(?:y|ies) of undefined \(reading '([^']+)'\)/g,
    /\bundefined: (\w+)/g,                              // Go
    /cannot find function [`'"]?(\w+)/g,                // Rust
    /cannot find value [`'"]?(\w+)/g,                   // Rust
    // How cargo actually reports it, which is not either of the above:
    //   error[E0432]: unresolved import `cg::modulo`
    /unresolved import [`'"]?(?:[\w]+::)*(\w+)/g,       // Rust
    // javac prints `cannot find symbol` and the detail on a later line, and
    // they are not always within a few characters of each other.
    /cannot find symbol[\s\S]{0,200}?symbol:\s+\w+ (\w+)/g, // Java
    /symbol:\s+(?:method|variable|class) (\w+)/g,       // Java
    /Unresolved reference: (\w+)/g,                     // Kotlin
    /uninitialized constant (\w+)/g,                    // Ruby
    // Ruby's wording for a method that is not there. Found by running
    // postflight against a real rspec project, where the diagnosis came back
    // "unknown" for a plainly new method.
    /undefined method [`'"]?([A-Za-z_]\w*[?!=]?)['"`]? for/g,
  ];
  for (const re of patterns) {
    for (const m of String(message).matchAll(re)) names.add(m[1]);
  }
  return [...names];
}

/**
 * Does the pull request itself introduce this name?
 *
 * Checked against both the paths it adds and the lines it adds, because a
 * missing import may name a module (a new file) or a symbol (a new export).
 */
function introducedByPullRequest(name, { addedSourceLines = [], changedFiles = [] }) {
  const leaf = name.split(/[./\\]/).pop();
  if (!leaf) return false;

  if (changedFiles.some((f) => {
    const base = f.split('/').pop().replace(/\.[^.]+$/, '');
    return base === leaf;
  })) return true;

  const declares = new RegExp(
    // `def self.modulo` and `def Calc.modulo` are how Ruby declares the
    // module method an rspec example reaches for, so the receiver has to be
    // allowed between the keyword and the name.
    `\\b(?:export\\s+)?(?:function|const|let|var|class|def|type|interface|fn|func|struct)\\s+`
    + `(?:[A-Za-z_]\\w*\\.)?${escape(leaf)}\\b`
    + `|\\bexport\\s*\\{[^}]*\\b${escape(leaf)}\\b`
    + `|\\b${escape(leaf)}\\s*[:=]\\s*(?:function|\\(|async)`
  );
  if (addedSourceLines.some((l) => declares.test(l))) return true;

  // The C family declares a method with a return type and no keyword at all —
  // `public static int modulo(int a, int b)` — so none of the above sees it.
  // Found by running postflight against a real Maven project, where the
  // diagnosis blamed a missing dependency for a method the PR plainly added.
  //
  // The leading word is a type, so statement keywords have to be excluded or
  // an ordinary `return modulo(a, b);` would read as a declaration.
  const cFamily = new RegExp(
    `(^|[^.\\w])(?!return\\b|new\\b|if\\b|while\\b|for\\b|switch\\b|catch\\b|throw\\b|else\\b|case\\b)`
    + `[A-Za-z_]\\w*(?:<[^>]*>)?(?:\\[\\])?\\s+${escape(leaf)}\\s*\\(`
  );
  return addedSourceLines.some((l) => cFamily.test(l));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Explain a load error in terms of what the author should do, if anything.
 */
export function diagnoseLoadError({
  message = '',
  addedSourceLines = [],
  changedFiles = [],
  dependencyDiff = [],
}) {
  const names = missingNames(message);
  const introduced = names.filter((n) =>
    introducedByPullRequest(n, { addedSourceLines, changedFiles }));

  if (introduced.length) {
    return {
      kind: 'references-new-code',
      names: introduced,
      explanation:
        `The test could not run against base because it uses ${list(introduced)}, ` +
        'which this pull request introduces. That is expected for new work, and ' +
        'nothing needs fixing — it does mean the test cannot demonstrate a ' +
        'behaviour change, because there was no old behaviour to disagree with.',
    };
  }

  // Drift needs the manifest to have changed AND, when the runner named what
  // went missing, that name to appear in the change. Without the second half
  // this misfires on any pull request that happens to touch its manifest.
  const drift = changesDependencies(changedFiles)
    && (names.length === 0 || names.some((n) => driftMentions(n, dependencyDiff)));

  if (drift) {
    // Say which of the two it is. Naming the package is a finding; not
    // naming it is a likely cause, and dressing the second up as the first
    // is how a check earns distrust.
    const evidence = names.length
      ? `This pull request moves ${list(names)} in its dependency manifest, so the ` +
        'installed packages belong to the head commit and not to base.'
      : 'The runner did not say what was missing, but this pull request changes its ' +
        'dependencies, which is the most common cause.';
    return {
      kind: 'dependency-drift',
      names,
      explanation:
        `${evidence} Install them inside the base worktree to get a real answer:\n\n` +
        '    setup-command: npm ci        # or pip install -e ., bundle install, …',
    };
  }

  if (names.length) {
    return {
      kind: 'missing-dependency',
      names,
      explanation:
        `${list(names)} could not be found in the base worktree, which is a fresh ` +
        'checkout and does not inherit what the job installed. Either link it:\n\n' +
        '    link-paths: |\n      node_modules\n      .venv\n\n' +
        'or install it there with `setup-command`.',
    };
  }

  return {
    kind: 'unknown',
    names: [],
    explanation:
      'The tests did not run against the base commit, and the reason was not ' +
      'recognisable. The output below is reported unchanged rather than ' +
      'summarised into a guess.',
  };
}

function list(names) {
  const quoted = names.map((n) => `\`${n}\``);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}
