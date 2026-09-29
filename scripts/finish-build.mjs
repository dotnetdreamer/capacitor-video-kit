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

/*
 * The one `import()` the CommonJS build has to keep. `labelMedia` in a browser imports MediaPipe's
 * runtime from the URL the host serves it at (`src/video-composer/web/labels.ts`), never through the
 * bundler, and `tsc` with `module: CommonJS` turns every `import()` into a `require()` - here a
 * `require()` of a URL, which no bundler can answer, so a host bundled from the `require` entry was
 * refused as `unsupported` on every call. `tsc` cannot be told to leave one `import()` alone, and the
 * setting that leaves them all (`Node16`) changes the rest of the CommonJS output as well, so that one
 * line is put back here. A real `import()` is legal in a CommonJS file, and Node and every bundler load
 * one from it. The build fails where the line is not found exactly once, rather than shipping a
 * recogniser that refuses every call without a word, when `tsc` or `labels.ts` writes it differently.
 *
 * Only the plugin's build has a CommonJS half; `build-mcp.mjs`'s run over `mcp` has none.
 */
if (treeArg === 'plugin/esm') {
  const labels = resolve(packageDir, 'plugin/cjs/video-composer/web/labels.js');
  const required = 'await Promise.resolve(`${runtimeUrl(url)}`).then(s => __importStar(require(s)))';
  const imported = 'await import(/* @vite-ignore */ /* webpackIgnore: true */ runtimeUrl(url))';
  const source = readFileSync(labels, 'utf8');
  const count = text => source.split(text).length - 1;
  // Run again over a tree it has already finished, it finds the import() it put there and leaves it.
  if (!(count(required) === 0 && count(imported) === 1)) {
    if (count(required) !== 1) {
      throw new Error(`${relative(packageDir, labels)} requires MediaPipe's runtime ${count(required)} times where it should once; see finish-build.mjs`);
    }
    writeFileSync(labels, source.replace(required, imported));
  }
  console.log(`finish-build: kept the import() of MediaPipe's runtime in ${relative(packageDir, labels)}`);
}
