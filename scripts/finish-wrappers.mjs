import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Makes the three framework wrappers readable as subpaths of this package rather than as the three
 * separate packages they used to be.
 *
 * They are built from `packages/<framework>` by three different tools - ng-packagr, tsc and Rollup -
 * and each writes into `<framework>/` at the root here, which `exports` offers as
 * `capacitor-video-kit/<framework>`. What each tool writes beside the code is what this script
 * normalises, because none of them knows it is no longer producing a package of its own.
 *
 * `type: module` is the part that is load bearing. Every one of these emits ES modules, two of them
 * as `.js`, and this package root declares no `type`, because Capacitor's tooling and every legacy
 * `require` of it expect the CommonJS default. Without a marker Node reads `react/index.js` and
 * `vue/index.js` as CommonJS and refuses them with `SyntaxError: Unexpected token 'export'`. It is
 * the same rule `scripts/module-type.mjs` exists for, and that script's verifier walks these
 * directories too - it is what fails if this one ever stops running.
 *
 * `sideEffects: false` is the second half, and it is carried per directory rather than in the root
 * `sideEffects` array so that a bundler resolving a wrapper module finds the answer at the nearest
 * package.json, which is where webpack looks.
 *
 * ng-packagr also writes a full manifest of its own - name, version, peerDependencies, an `exports`
 * map - describing a package that is no longer published. Left in place it is a second, contradictory
 * description of this directory sitting one level below the real one. It is replaced rather than
 * merged, for the same reason the LICENSE and README it copies are removed: the root has them, and
 * `files` ships `angular/` whole.
 *
 * `--scaffold` is the same script run at the other end of the build, and it exists because of an
 * ordering the wrappers cannot escape. They are generated from the components, so `build:ui` has to
 * run before them; but `build:ui` is Stencil, and Stencil validates this package.json against the
 * disk as it builds, and fails on a `files` entry naming a directory that is not there yet:
 *
 *   [ ERROR ]  Package Json: Unable to find "angular/" within the package.json "files" array.
 *
 * So `build:package` creates the three directories with their markers already in them, and
 * `build:wrappers` later fills them and runs this script again without the flag, which is the run
 * that checks the builds actually produced what `exports` promises. A scaffolded directory that
 * never gets filled is caught there rather than shipped empty.
 */
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What `exports` in the root package.json offers, and what each build is expected to have left there. */
const WRAPPERS = [
  ['angular', ['index.d.ts', 'fesm2022']],
  ['react', ['index.js', 'index.d.ts']],
  ['vue', ['index.js', 'index.d.ts']],
];

/**
 * Copied in by ng-packagr. The LICENSE and README duplicate the root's, which `files` already ships;
 * the `.npmignore` is a rule for publishing a package that no longer exists, and it excludes exactly
 * the nested package.json this script writes.
 */
const STRAY = ['LICENSE', 'README.md', '.npmignore'];

/** What every one of these directories carries, whether it has been filled yet or not. */
const MANIFEST = `${JSON.stringify({ type: 'module', sideEffects: false }, null, 2)}\n`;

const scaffolding = process.argv.includes('--scaffold');

for (const [framework, expected] of WRAPPERS) {
  const dir = join(packageDir, framework);

  if (scaffolding) {
    mkdirSync(dir, { recursive: true });
  } else {
    if (!isDirectory(dir)) {
      throw new Error(`${framework}/ is not in the build, so \`npm run build:wrappers\` did not finish`);
    }
    for (const entry of expected) {
      if (!exists(join(dir, entry))) {
        throw new Error(`${framework}/${entry} is missing, and the exports map for ./${framework} names it`);
      }
    }
    for (const entry of STRAY) rmSync(join(dir, entry), { force: true });
  }

  writeFileSync(join(dir, 'package.json'), MANIFEST);
}

const names = WRAPPERS.map(([name]) => name).join(', ');
console.log(scaffolding ? `finish-wrappers: ${names} scaffolded` : `finish-wrappers: ${names} marked as ES modules`);

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}
