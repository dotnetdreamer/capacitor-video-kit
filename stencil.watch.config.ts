import type { Config } from '@stencil/core';

import { config as published } from './stencil.config';

/**
 * The watch build, `npm run watch`, for working on a component with a host app running against it.
 *
 * It is the published config with three settings changed, rather than a config of its own, because
 * the host imports `dist/components` and the wrappers: anything this file left out is something the
 * app would be resolving from the last full build while you edited the source of it.
 *
 * `stencil.dev.config.ts` is the other watch in this repository and does not overlap. That one
 * serves a component on its own at localhost:3333 and writes only `www`; this one writes the same
 * directories `npm run build` does, so a linked app picks them up.
 */

/**
 * `hashFileNames: false` is the setting the whole file exists for.
 *
 * A production build names every shared chunk after a hash of its contents, so each rebuild writes
 * `p-<new hash>.js` and rewrites the component that imports it. A bundler watching the package sees
 * the rewritten component first and fails on an import of a chunk that is written a moment later,
 * and it stays failed, because the file it would need to notice is one it has never read. Stable
 * names mean the file the host is looking for is always on disk.
 */
export const config: Config = {
  ...published,
  hashFileNames: false,
  minifyJs: false,
  sourceMap: true,
  /*
   * The readme writer, dropped. It rewrites a file per component on every rebuild, which shows up
   * as a dirty working tree for as long as the watch runs. `npm run build` writes them.
   */
  outputTargets: published.outputTargets?.filter((target) => target.type !== 'docs-readme'),
};
