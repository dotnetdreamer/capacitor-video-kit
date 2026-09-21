import { readFileSync } from 'node:fs';

import nodeResolve from '@rollup/plugin-node-resolve';
import { dts } from 'rollup-plugin-dts';

/** The package the wrappers render, whose specifiers are the ones a consumer has to be able to resolve. */
const core = '@capacitor-video-kit/core';

/**
 * Why this package is bundled when the Vue one is not.
 *
 * The generated React wrappers import `createComponent` from
 * `@stencil/react-output-target/runtime`. That subpath is 1.2 kB of code, but the package it lives
 * in also holds the generator that wrote the wrappers, and the generator depends on `ts-morph`. A
 * plain `tsc` build leaves the bare specifier in the emitted JavaScript, which makes the whole
 * package a runtime dependency, which puts 18.4 MB across 26 packages into every application that
 * installs `@capacitor-video-kit/core/react` - and 12.2 MB of that is `@ts-morph/common`, a TypeScript
 * compiler the application will never run.
 *
 * The output target offers no way to point that import somewhere else, so the specifier is
 * resolved away here instead: Rollup inlines the runtime and the `@lit/react` `createComponent` it
 * calls, and `rollup-plugin-dts` inlines the two types the wrappers name from them. Nothing else
 * is inlined. React stays a peer dependency and `@capacitor-video-kit/core` stays a dependency, because
 * a second copy of either is a bug rather than a size problem.
 *
 * `@stencil/react-output-target` is a development dependency after this, and the published package
 * has exactly one runtime dependency.
 */
const external = [/^react($|\/)/, /^react-dom($|\/)/, new RegExp(`^${core}($|\\/)`)];

/**
 * The two packages whose code is pulled in rather than left for the consumer to install. They are
 * named here rather than inferred, so anything else that ever appears in an import is a build
 * failure to look at rather than a surprise in the bundle.
 */
const inlined = ['@stencil/react-output-target', '@lit/react'];

/**
 * The one specifier the React output target gets wrong, rewritten on the way out.
 *
 * For a component with an `@Event()`, the generator writes
 * `import { type VeAlertCustomEvent } from "@capacitor-video-kit/core"` - the bare package name, hard coded,
 * with no option to point it anywhere else. Its own Angular target writes
 * `@capacitor-video-kit/core/dist/components` for the same type, which is the specifier that is actually
 * right: the `Ve*CustomEvent` interfaces and every type a `@Prop` or an `@Event()` names come out of
 * `dist/components/index.d.ts`, through the `export * from '../types'` at the end of it.
 *
 * The bare name is not just a longer road to the same place. In this package the root is the
 * Capacitor plugin, so `@capacitor-video-kit/core` resolves to `plugin/esm/plugin.d.ts`, which exports none
 * of those types and does statically import `@capacitor/core`. A React host that installed neither
 * Capacitor nor the plugin therefore got five errors out of this package's own declarations: three
 * saying the event types do not exist, and two saying `@capacitor/core` cannot be found. It is
 * invisible from inside this repository, where `tsconfig.json` maps the bare name at the right file
 * so the build passes, and it only appears once a consumer compiles the published `.d.ts`.
 *
 * `output.paths` is the rewrite. The mapping in `tsconfig.json` points at the same file this names,
 * so what the build typechecks against and what a consumer resolves are one declaration file.
 */
const paths = { [core]: `${core}/dist/components` };

/**
 * Every specifier of the core package left in the shipped text, checked before the tarball exists.
 *
 * The rewrite above is one line and would go unnoticed if it stopped working, because nothing in
 * this repository resolves these specifiers the way a consumer does: the wrappers typecheck here
 * through `paths`, the bundle is never imported here, and a wrong specifier costs nothing until
 * someone else installs the tarball. An exports map check alone would not have caught the bug this
 * exists for, either - `.` is a perfectly good entry, it is just the Capacitor plugin - so the bare
 * root is named as its own failure.
 */
const coreExports = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).exports;

/** Node's subpath matching, as much of it as an exports map with one `*` per key needs. */
function exported(subpath) {
  return Object.keys(coreExports).some((key) => {
    if (!key.includes('*')) return key === subpath;
    const [before, after] = key.split('*');
    return subpath.startsWith(before) && subpath.endsWith(after) && subpath.length >= key.length - 1;
  });
}

function checkCoreSpecifiers() {
  return {
    name: 'check-core-specifiers',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const [, specifier] of chunk.code.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
          if (specifier !== core && !specifier.startsWith(`${core}/`)) continue;
          if (specifier === core) {
            this.error(
              `${chunk.fileName} imports "${core}" itself, which is the Capacitor plugin and says nothing ` +
                `about components. The editor's declarations are "${core}/dist/components", and \`paths\` ` +
                'in this file is what redirects the generated wrappers there.',
            );
          }
          if (!exported(`.${specifier.slice(core.length)}`)) {
            this.error(
              `${chunk.fileName} imports "${specifier}", which ${core}'s exports map does not resolve. ` +
                'A consumer installing this package would not be able to compile it.',
            );
          }
        }
      }
    },
  };
}

/**
 * Rollup warns once per generated wrapper that it dropped the file's `'use client'`, which is true
 * and is what the banner below puts back. Left in, the build prints a wall of warnings that read
 * like a bug, so the one it is answering is filtered and everything else still comes through.
 */
function onwarn(warning, warn) {
  if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
  warn(warning);
}

export default [
  {
    input: '.build/index.js',
    external,
    onwarn,
    plugins: [nodeResolve({ exportConditions: ['import', 'default'] }), checkCoreSpecifiers()],
    output: {
      file: '../../react/index.js',
      format: 'es',
      paths,
      /* `files` is `dist/`, so a map here would name a `src/` that no consumer receives. */
      sourcemap: false,
      /*
       * Every wrapper in this package renders a custom element, which no server can render, so the
       * generated sources each carry `'use client'`. Rollup drops a module level directive when it
       * merges modules, so the bundle declares it once for the whole package instead, which is the
       * same statement and what a React Server Components host needs to see.
       */
      banner: "'use client';",
    },
  },
  {
    input: '.build/index.d.ts',
    external,
    plugins: [dts({ includeExternal: inlined }), checkCoreSpecifiers()],
    output: { file: '../../react/index.d.ts', format: 'es', paths },
  },
];
