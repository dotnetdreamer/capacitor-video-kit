/**
 * The one thing `tsc` will not do for an ESM package, done once over the finished `plugin/esm`.
 *
 * A relative specifier in Node ESM has to name a file, extension and all, and `tsc` emits whatever
 * the source wrote. The sources stay extensionless because that is what the editors and the
 * bundlers in this repository read, so the extensions are added here instead, to the emitted
 * JavaScript that Node actually loads.
 *
 * The other half of making this tree loadable, the package.json in each emitted directory saying
 * which module system it holds, is `module-type.mjs`. It marks Stencil's output as well as this
 * one, and it runs last so that it can check the whole published tree at once.
 *
 * The tree to fix up is the first argument, relative to the package root, and defaults to the
 * plugin's. `build-mcp.mjs` passes `mcp`, which is the same `tsc` with the same extensionless
 * sources emitted somewhere else, and so has exactly the same thing wrong with it.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(fileURLToPath(new URL('../', import.meta.url)));
const treeArg = process.argv[2] ?? 'plugin/esm';
const tree = resolve(packageDir, treeArg);

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.js') || path.endsWith('.d.ts')) files.push(path);
  }
})(tree);

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
    throw new Error(`${relative(packageDir, file)} imports '${spec}', which nothing in ${treeArg} answers`);
  });
  if (after !== before) {
    writeFileSync(file, after);
    rewritten++;
  }
}

console.log(`finish-build: added extensions in ${rewritten} files under ${treeArg}`);
