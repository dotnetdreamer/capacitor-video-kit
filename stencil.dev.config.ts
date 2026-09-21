import type { Config } from '@stencil/core';

/**
 * The development harness: `npm run dev`, then open `http://localhost:3333/?tag=ve-slider`.
 *
 * A second config rather than a few more lines in `stencil.config.ts`, because that file is the
 * published build and everyone working in this repository shares it. It carries the three wrapper
 * generators, the readme writer and an asset copy whose destination the tarball's layout depends
 * on, none of which a page on localhost has any use for and all of which would be rebuilt on every
 * keystroke of a watch run.
 *
 * `src/index.html` says what the page itself does.
 */

/** Everything the dev server serves, and the only directory this config writes to. */
const SERVED_DIR = 'www';

export const config: Config = {
  namespace: 'capacitor-video-kit',
  /* The same tsconfig the published build compiles with, so the harness cannot pass what it fails. */
  tsconfig: 'tsconfig.stencil.json',
  /*
   * `@preact/signals-core` is deliberately not external here, which is the one place this config
   * disagrees with the published one. A browser cannot resolve a bare specifier without an import
   * map, and rollup gives the whole build a single copy of the library, which is what the store the
   * page builds and the components reading it have to be looking at.
   */
  outputTargets: [
    /*
     * A `dist` target rather than the `www` one a Stencil starter uses, because the page needs more
     * than the components: it builds an `EditorStore`, an `EditorMedia` and an `OverlayBitmaps` to
     * hand down as `ctx`, and `dist` is the only output target that compiles `src/index.ts`, the
     * package's `ui` entry where all three live, into something a browser can import. It lands
     * beside the lazy component bundle as `capacitor-video-kit/index.esm.js` and shares its chunks.
     *
     * Adding the `www` target as well would emit a second copy of the components, and whoever
     * loaded both would be running two Stencil runtimes and two copies of the signal library
     * against one store: the failure that never throws and simply stops every repaint.
     */
    {
      type: 'dist',
      dir: SERVED_DIR,
      /*
       * Both destinations are written from one directory up, because a `dist` target resolves a
       * copy against the bundle directory it writes the components into rather than against `dir`.
       * Spelled without the `..` they land in `www/capacitor-video-kit/`, where the page is not served
       * from and the assets are one segment from where it says they are.
       */
      copy: [
        /*
         * The page, at the root the dev server serves, so everything it imports is one path segment
         * down. It is watched like any other source file, so saving it is copied again without the
         * server being restarted.
         */
        { src: 'index.html', dest: '../index.html' },
        /*
         * The 34 stickers and the 32 font files, at the base the page passes to
         * `setEditorAssetPath()`. Stencil's own copy of them goes into `collection/assets`, which
         * this target only writes in a production build and which is not where the page looks.
         */
        { src: 'assets', dest: '../assets' },
      ],
    },
  ],
  devServer: {
    root: SERVED_DIR,
    /*
     * Left to open by hand. The harness shows one component at a time and takes the tag from the
     * query string, so a tab landing on the bare page is one navigation short of useful, and an
     * agent running the server in the background has no browser to open at all.
     */
    openBrowser: false,
  },
};
