/**
 * The two things `tsc` will not do for an ESM package, done once over the finished `dist/esm`.
 *
 * The app compiles this plugin from source through a tsconfig path mapping, and the Karma build it
 * uses for its specs resolves through webpack, which will not map a `./thing.js` specifier back to
 * `./thing.ts`. So the sources stay extensionless and the extensions are added here instead, to the
 * emitted JavaScript that Node actually loads.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));

/**
 * Node decides whether a `.js` file is ESM or CommonJS from the nearest package.json, and this
 * plugin's own package.json declares no `type`, because Capacitor's tooling and every legacy
 * `require` of it expect the CommonJS default. Marking the two output directories instead lets both
 * halves of the dual build load correctly without changing what the package root means.
 */
for (const [dir, type] of [
  ['esm', 'module'],
  ['cjs', 'commonjs'],
]) {
  writeFileSync(join(dist, dir, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
}

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.js') || path.endsWith('.d.ts')) files.push(path);
  }
})(join(dist, 'esm'));

/** `from '<spec>'`, `from "<spec>"` and both quote forms of `import('<spec>')`. */
const specifier = /((?:from|import\()\s*['"])(\.{1,2}\/[^'"]*)(['"])/g;

/*
 * Only relative specifiers are touched. `@capacitor/core` is a bare specifier and is left to the
 * consumer's resolver, which is the whole point of a peer dependency.
 */
let rewritten = 0;
for (const file of files) {
  /* A declaration file names the JavaScript beside it, so both kinds resolve against the same tree. */
  const suffix = file.endsWith('.d.ts') ? '.d.ts' : '.js';
  const before = readFileSync(file, 'utf8');
  const after = before.replace(specifier, (match, open, spec, close) => {
    if (spec.endsWith('.js')) return match;
    const target = resolve(dirname(file), spec);
    if (existsSync(target + suffix)) return `${open}${spec}.js${close}`;
    if (existsSync(join(target, `index${suffix}`))) return `${open}${spec}/index.js${close}`;
    throw new Error(`${file} imports '${spec}', which nothing in dist/esm answers`);
  });
  if (after !== before) {
    writeFileSync(file, after);
    rewritten++;
  }
}

console.log(`finish-build: marked two module types, added extensions in ${rewritten} files`);
