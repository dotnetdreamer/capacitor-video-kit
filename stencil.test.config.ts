import type { Config } from '@stencil/core';

import { config as buildConfig } from './stencil.config';

/**
 * What `npm test` compiles with: the published build's config with every output target taken out.
 *
 * `stencil-test` runs a Stencil build of its own before it hands the sources to Vitest, and that
 * build is not the published one: it never reaches `scripts/module-type.mjs`, which is what renames
 * Stencil's ESM `dist/index.js` to `dist/index.mjs` and writes the package.json in each emitted
 * directory saying which module system it holds. Run against the real config, it therefore left
 * `./ui` and `./loader` in the exports map pointing at two files that no longer existed, and every
 * `import` condition of the package readable by Node only as CommonJS. In a checkout an app is
 * linked to, which is how this package is developed, that broke the app until the next full build.
 *
 * Emitting nothing is what makes that impossible rather than merely repaired afterwards: a test run
 * that writes no part of the published tree cannot leave it half written, however it exits, and a
 * cancelled run is no different from a finished one. The tests do not read `dist/` in any case;
 * they import components and modules from `src/`, and Vitest transforms those itself.
 *
 * Everything else is shared with the real config rather than repeated, so the two cannot drift in
 * the settings that decide whether a component compiles at all.
 */
export const config: Config = {
  ...buildConfig,
  /*
   * One target, into a directory nothing publishes or reads, because no targets at all is not the
   * same thing: Stencil answers an empty list with its default `www` target, which in `--prod`
   * asks for a workbox install it does not have and fails the build before a single test runs.
   *
   * This is the cheapest of the real targets to produce and the only one the editor's own compile
   * needs to be exercised end to end. The directory is in .gitignore and in `npm run clean`.
   */
  outputTargets: [
    {
      type: 'dist-custom-elements',
      dir: '.stencil-test-build',
      customElementsExportBehavior: 'single-export-module',
      externalRuntime: false,
    },
  ],
};
