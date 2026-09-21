import type { Config } from '@stencil/core';
import { angularOutputTarget } from '@stencil/angular-output-target';
import { reactOutputTarget } from '@stencil/react-output-target';
import { vueOutputTarget, type ComponentModelConfig } from '@stencil/vue-output-target';

import { requireVueComponentModels } from './build/vue-component-models';

/** The name the generated wrappers import the custom elements from, so it must be what we publish. */
const componentCorePackage = '@capacitor-video-kit/core';

/**
 * Where `dist-custom-elements` writes, repeated on all three wrapper targets because they disagree
 * about it: the React target defaults to `dist/components` while the Vue and Angular targets
 * default to `components`. Left alone, the three wrappers import the same file through three
 * different subpaths and two of them do not resolve.
 *
 * The `dist-custom-elements` target itself is deliberately left on this same default rather than
 * moved to `components`, because @stencil/vitest turns every output directory into a test exclude
 * pattern: a target directory named `components` would silently stop `src/components` being
 * discovered, and the test run would still exit zero.
 */
const customElementsDir = 'dist/components';

/**
 * The one package the editor leaves for the consumer's bundler to resolve rather than inlining.
 *
 * `@preact/signals-core` is a peer dependency and has to stay one. Two copies in a tree do not
 * throw: a computed in one copy simply never sees a signal in the other, and every repaint stops.
 * Bundling a copy in here would guarantee exactly that for any host that also holds signals.
 *
 * The edit contract used to be external too, back when it was a different package. It is `src/editor`
 * now, the components import it from `../editor`, and Stencil compiles it into the bundles like any
 * other source file in this repository.
 */
const external = ['@preact/signals-core'];

/**
 * The 34 stickers and the 32 font files, copied once, next to the standalone build.
 *
 * There used to be three copies. Stencil puts `src/assets` into `dist/collection` by itself, this
 * config asked for a second copy beside the lazy build and a third beside the standalone one, and
 * `diff -rq` said all three were the same 67 files: 3.3 MB of a 5.1 MB install, for 1.1 MB of
 * content. The files are not imported by any module, so no bundler carries any of them; a host
 * copies one directory into whatever it serves statically and says where that is with
 * `setEditorAssetPath()`. One copy is all a host can point at, and it is this one, because
 * `dist/components/assets` is what the `./assets/*` subpath in package.json resolves to and what
 * the message on a missing base names.
 *
 * The other two went for a reason each. `dist/collection/assets` is reached by nothing:
 * `collection-manifest.json` does not mention `assets`, so a downstream Stencil build recompiling
 * the collection never looks for it. It is Stencil's own copy rather than one asked for here, so it
 * is dropped from the tarball by a negated entry in `files` instead. `dist/capacitor-video-kit/assets`
 * was the one a script tag got for free, because the lazy build works its base out from the script
 * it loaded; that host now serves this directory and calls `setEditorAssetPath()` like everyone
 * else, which is one line in exchange for 1.1 MB in every install including the ones that never
 * load the lazy build.
 *
 * The destination is spelled out because Stencil derives the copy task for `dist-custom-elements`
 * with the repository root as its base rather than the target's own directory, so `{ src: 'assets' }`
 * alone writes `core/assets` and still reports the files copied.
 */
const copyAssetsToCustomElements = [{ src: 'assets', dest: `${customElementsDir}/assets` }];

/**
 * The components `v-model` is wired up for, as the Vue output target spells it: the tag, the event
 * it emits when the value changes, and the prop that value lives in.
 *
 * It is empty because `ve-spinner` has no value to bind. It is written here rather than left out
 * because leaving it out is invisible, and `build/vue-component-models.ts` fails the build the
 * moment a component arrives that needs an entry and does not have one.
 */
const componentModels: ComponentModelConfig[] = [];

export const config: Config = {
  namespace: 'capacitor-video-kit',
  /*
   * Not the root `tsconfig.json`, which is the Capacitor plugin's half of `src` and has no JSX
   * settings at all, and not `src/tsconfig.json`, which is the editor's half with its tests. The
   * file named here says why it is a third one.
   */
  tsconfig: 'tsconfig.stencil.json',
  rollupConfig: { inputOptions: { external } },
  outputTargets: [
    /*
     * The lazy build, for a host that wants one script tag and components fetched on demand. It is
     * not what the three wrappers use, and it ships alongside them rather than instead of them.
     */
    {
      type: 'dist',
      esmLoaderPath: '../loader',
    },
    /*
     * The per component ES modules a host bundler can tree shake. Mandatory rather than chosen: the
     * React wrappers import `defineCustomElement` from this directory by name, so without it they
     * do not build at all.
     *
     * `single-export-module` is likewise the only legal value here. The Vue and Angular generators
     * both require it, and the React generator's import shape survives it. The cost is that nothing
     * self registers, so a plain custom element consumer calls `defineCustomElement()` or uses the
     * loader above.
     *
     * `externalRuntime: false` inlines the Stencil runtime instead of importing it from
     * `@stencil/core/internal/client`, so nothing a consumer's bundler sees resolves into
     * @stencil/core. That package is still a dependency, because the emitted declarations name it,
     * but no byte of it reaches the browser.
     */
    {
      type: 'dist-custom-elements',
      customElementsExportBehavior: 'single-export-module',
      externalRuntime: false,
      copy: copyAssetsToCustomElements,
    },
    /*
     * One readme per component, written from the component's own props, events, methods and CSS
     * custom properties. These files are the one place in the repo where the house style does not
     * apply, because Stencil writes them.
     */
    {
      type: 'docs-readme',
    },
    reactOutputTarget({
      outDir: 'packages/react/src/generated',
      customElementsDir,
      esModules: true,
    }),
    vueOutputTarget({
      componentCorePackage,
      proxiesFile: 'packages/vue/src/generated/components.ts',
      customElementsDir,
      componentModels,
      includeImportCustomElements: true,
      includeDefineCustomElements: false,
      includePolyfills: false,
    }),
    /*
     * The guard that makes an absent `componentModels` entry a build failure rather than a binding
     * that quietly does nothing. It reads the same list the Vue target was handed, so the two
     * cannot drift.
     */
    requireVueComponentModels(componentModels),
    /*
     * `outputType` is set rather than left out on purpose. Both the target's readme and the Stencil
     * documentation say it defaults to `component`, which declares the wrappers on an NgModule; the
     * shipped code has defaulted to `standalone` since 1.4.1. Saying it here means a future reader
     * who checks the documentation is not misled by it.
     */
    angularOutputTarget({
      componentCorePackage,
      directivesProxyFile: 'packages/angular/src/generated/proxies.ts',
      customElementsDir,
      outputType: 'standalone',
      esModules: true,
    }),
  ],
};
