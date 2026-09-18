import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

/**
 * Says which of the emitted files are ES modules and which are CommonJS, in the one way Node reads.
 *
 * Node decides a `.js` file's module system from the nearest package.json above it and nothing
 * else. This package's own package.json declares no `type`, because Capacitor's tooling and every
 * legacy `require` of it expect the CommonJS default. So without what this script does every `.js`
 * in `plugin/`, `dist/` and `loader/` is CommonJS as far as Node is concerned, including every file
 * the `import` condition of the exports map offers. Node then parses `export * from ...` as a
 * script:
 *
 *   SyntaxError: Unexpected token 'export'
 *
 * That was the shipped state, and it was invisible for two reasons. No bundler asks Node how to
 * read a file, and Node 20.19 and 22.7 added a fallback that reparses an ambiguous file as ESM when
 * the first parse fails, so on a current Node it works. On Node 22.6 every `import` condition of
 * this package failed with the error above, and a package is not allowed to depend on a fallback
 * that a consumer's Node may predate.
 *
 * The answer is a package.json in each emitted directory naming that directory's module type. Two
 * markers cover the plugin half, because `tsc` writes its ESM and its CommonJS into two separate
 * trees. Stencil does not: it writes an ESM `dist/index.js` beside a CommonJS `dist/index.cjs.js`,
 * and a second such pair in `loader/`, and one directory cannot be both types at once.
 *
 * So the directories that hold one kind get a marker, and the three ES modules that share a
 * directory with CommonJS are renamed to `.mjs`, which Node reads as ESM whatever the enclosing
 * type says. It is the ES modules that move rather than the CommonJS files because Stencil's own
 * package.json validator insists `main` reads `dist/index.cjs.js` and warns on every production
 * build if it does not, while nothing validates `module`. The renamed files are reached only
 * through fields this package controls, so no specifier a consumer writes has to change.
 *
 * This is the last step of `build:package`, so every directory it checks has just been written,
 * and it checks all three rather than only the ones it marks. Anything that runs `stencil build` by
 * itself rewrites `dist/` without ever reaching this script and leaves exactly the broken shape
 * above, which is why `prepare` rebuilds the package rather than trying to repair it, and why the
 * test run builds through `stencil.test.config.ts` into a directory nothing publishes or reads.
 * `npm test` used to be the way this happened in practice: it rewrote `dist/` on every run, and in
 * a checkout an app is linked to that broke the app until the next full build. The renames below
 * are safe to repeat regardless.
 */
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The emitted directories that hold one kind of module, and which kind. The first two are the
 * plugin's `tsc` output and the rest are Stencil's.
 *
 * The two CommonJS ones are already CommonJS by the package root's silence, and are marked anyway
 * so that giving this package a `type` one day cannot silently invert them.
 */
const MARKERS = [
  ['plugin/esm', 'module'],
  ['plugin/cjs', 'commonjs'],
  ['dist/esm', 'module'],
  ['dist/components', 'module'],
  ['dist/collection', 'module'],
  ['dist/choisy-video-kit', 'module'],
  ['dist/cjs', 'commonjs'],
];

/**
 * The ES modules Stencil writes into a directory that also holds CommonJS, and what they become.
 *
 * `loader/index.es2017.js` is not reachable through the exports map and is renamed anyway, so that
 * no file in the published tree is a lie about its own contents.
 */
const RENAMES = [
  ['dist/index.js', 'dist/index.mjs'],
  ['loader/index.js', 'loader/index.mjs'],
  ['loader/index.es2017.js', 'loader/index.es2017.mjs'],
];

for (const [dir, type] of MARKERS) {
  writeFileSync(join(packageDir, dir, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
}

for (const [from, to] of RENAMES) {
  const source = join(packageDir, from);
  const target = join(packageDir, to);
  // Already renamed, by an earlier run over the same build. This script runs twice on the way to a
  // publish and has to be safe the second time.
  if (!isFile(source) && isFile(target)) continue;
  if (!isFile(source)) {
    // A build that stopped writing this file has moved out from under this script, and quietly
    // leaving the old name in place is how the syntax error above would come back.
    throw new Error(`neither ${from} nor ${to} is in the build, so there is nothing to rename`);
  }
  rmSync(target, { force: true });
  renameSync(source, target);
}

/*
 * The check, which is the point of the file rather than a nicety: the markers and the renames are
 * correct only for as long as Stencil keeps emitting what it emits today, and the way this failed
 * before was by being wrong while every test still passed.
 *
 * Each file is handed to Node's own parser as a script, which is exactly what Node does with a file
 * it considers CommonJS. One that will not parse that way is an ES module; one that parses and uses
 * `require` or `module.exports` is CommonJS; one that is legal as either is nobody's problem and is
 * skipped rather than guessed at. Then the type Node would apply is worked out the way Node works
 * it out, by extension or by the nearest package.json, and the two have to agree.
 */
let checked = 0;

/*
 * `mcp` is in the list only when it is there. It is the optional half of the package and
 * `build-mcp.mjs` does not always produce it, but when it does it is `tsc` output exactly like
 * `plugin/esm` and has to hold up to the same check.
 */
const TREES = ['plugin', 'dist', 'loader', 'mcp'].filter((dir) => isDirectory(join(packageDir, dir)));

for (const dir of TREES) {
  for (const file of sources(join(packageDir, dir))) {
    const kind = moduleKind(file);
    if (kind === 'either') continue;

    const governing = governingType(file);
    const expected = kind === 'esm' ? 'module' : 'commonjs';
    if (governing !== expected) {
      throw new Error(
        `${relative(packageDir, file)} is ${kind === 'esm' ? 'an ES module' : 'CommonJS'}, but Node ` +
          `would read it as "${governing}" and refuse to load it`,
      );
    }
    checked++;
  }
}

console.log(`module-type: ${MARKERS.length} markers, ${RENAMES.length} renames, ${checked} files agree across ${TREES.join(', ')}`);

function* sources(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(js|mjs|cjs)$/.test(path)) yield path;
  }
}

/**
 * ESM, CommonJS, or legal as either, decided by Node's parser rather than by looking for keywords,
 * because every file here is minified and a regular expression over minified code is a guess.
 *
 * Nothing runs: `new Script` compiles and stops.
 */
function moduleKind(file) {
  const source = readFileSync(file, 'utf8');
  try {
    new Script(source, { filename: file });
  } catch (error) {
    if (error instanceof SyntaxError) return 'esm';
    throw error;
  }
  return /\brequire\s*\(|\bmodule\.exports\b|\bexports\./.test(source) ? 'cjs' : 'either';
}

/** What Node would read the file as, from its extension or the nearest package.json's `type`. */
function governingType(file) {
  if (file.endsWith('.mjs')) return 'module';
  if (file.endsWith('.cjs')) return 'commonjs';

  let dir = dirname(file);
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (isFile(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).type ?? 'commonjs';
    const parent = dirname(dir);
    if (parent === dir) return 'commonjs';
    dir = parent;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
