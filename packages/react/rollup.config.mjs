import nodeResolve from '@rollup/plugin-node-resolve';
import { dts } from 'rollup-plugin-dts';

/**
 * Why this package is bundled when the Vue one is not.
 *
 * The generated React wrappers import `createComponent` from
 * `@stencil/react-output-target/runtime`. That subpath is 1.2 kB of code, but the package it lives
 * in also holds the generator that wrote the wrappers, and the generator depends on `ts-morph`. A
 * plain `tsc` build leaves the bare specifier in the emitted JavaScript, which makes the whole
 * package a runtime dependency, which puts 18.4 MB across 26 packages into every application that
 * installs `choisy-video-kit-react` - and 12.2 MB of that is `@ts-morph/common`, a TypeScript
 * compiler the application will never run.
 *
 * The output target offers no way to point that import somewhere else, so the specifier is
 * resolved away here instead: Rollup inlines the runtime and the `@lit/react` `createComponent` it
 * calls, and `rollup-plugin-dts` inlines the two types the wrappers name from them. Nothing else
 * is inlined. React stays a peer dependency and `choisy-video-kit` stays a dependency, because
 * a second copy of either is a bug rather than a size problem.
 *
 * `@stencil/react-output-target` is a development dependency after this, and the published package
 * has exactly one runtime dependency.
 */
const external = [/^react($|\/)/, /^react-dom($|\/)/, /^choisy-video-kit($|\/)/];

/**
 * The two packages whose code is pulled in rather than left for the consumer to install. They are
 * named here rather than inferred, so anything else that ever appears in an import is a build
 * failure to look at rather than a surprise in the bundle.
 */
const inlined = ['@stencil/react-output-target', '@lit/react'];

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
    plugins: [nodeResolve({ exportConditions: ['import', 'default'] })],
    output: {
      file: 'dist/index.js',
      format: 'es',
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
    plugins: [dts({ includeExternal: inlined })],
    output: { file: 'dist/index.d.ts', format: 'es' },
  },
];
