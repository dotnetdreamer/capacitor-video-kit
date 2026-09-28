# Development and architecture

[Documentation](README.md) / [Project overview](../README.md)

- [Package overview](#package-overview)
- [What is in here](#what-is-in-here)
  - [What `npm pack` carries](#what-npm-pack-carries)
- [Two builds in one package](#two-builds-in-one-package)
  - [The emitted trees say which module system they are](#the-emitted-trees-say-which-module-system-they-are)
  - [The wrappers resolve this package through a self link](#the-wrappers-resolve-this-package-through-a-self-link)
- [Build and test](#build-and-test)
  - [The two watches](#the-two-watches)
  - [On a device](#on-a-device)
- [Decisions already taken](#decisions-already-taken)

## Package overview

One package, both halves of video on a device: the **native engines** that edit and encode, and the
**editor** that drives them, as framework free web components.

Two Capacitor plugins, both fully native:

- **`VideoComposer`** - edits and encodes video on the device: concat, trim, speed, colour, bitmap
  overlays, music and voiceovers. Nothing is rendered in the WebView and no media bytes cross the
  bridge.
- **`BackgroundPublisher`** - uploads the result and makes one finalizing call to your own API
  using native background work. OS restrictions still apply; an iOS force quit can cancel uploads. It knows
  nothing about your backend: the URLs, the field names, the response keys and the body are all
  things you hand over.

They ship together because they are always used together and two installs for one feature is a
worse wart than an unused dependency. They stay two plugin *classes* because they share nothing at
runtime but a file path: the composer writes the video, the publisher uploads whatever path it is
handed.

## What is in here

| Part | Source | How a consumer reaches it |
|---|---|---|
| The two plugin proxies | `src/plugin.ts`, `src/video-composer/`, `src/background-publisher/` | `capacitor-video-kit` |
| The edit contract, which the Swift and Kotlin engines are written against | `src/editor/` | `capacitor-video-kit/editor` |
| The editor's web components and its store | the rest of `src/` | `capacitor-video-kit/ui`, `/loader`, `/dist/components/*` |
| The native engines | `ios/Sources/`, `android/src/main/` | the Capacitor CLI, on `npx cap sync` |
| React, Vue and Angular bindings | `packages/react`, `packages/vue`, `packages/angular` | `capacitor-video-kit/react` and its two siblings |
| The MCP server, which is optional and built only when it is asked for | `src/mcp/` | `capacitor-video-kit/mcp`, or `node mcp/mcp/stdio.js` |

One repository, one npm package. The three wrappers are built from `packages/<framework>` into
`angular/`, `react/` and `vue/` at the root, and the exports map offers each as a subpath, so a host
installs one thing and imports the binding for the framework it actually uses.

They were three packages of their own until they were not, and what changed is the reason they were
split: a generated Stencil wrapper compiles against its framework, and a package cannot *depend* on
React, Vue and Angular at once. It can declare all three as **optional peers**, which is what the
root manifest does, and an application that installs this package and has only Angular in its tree
gets no warning about the other two and bundles neither - nothing imports `./react` unless the host
writes that specifier. Against that, three packages cost a versioning problem that showed up every
time: a wrapper carried a peer edge on an exact core version with nowhere to fetch it from, so
installing one without the other ended in a 404 against a registry this package is not on.

One package also means one build. The wrappers are generated from the components, so they are always
a step behind them, and as separate packages that step was easy to skip: a host linked to a checkout
could resolve a wrapper built from components two edits ago and nothing said so. `angular/`, `react/`
and `vue/` are now written by this package's own `build:wrappers`, and its `prepare` runs it, so the
tarball and the symlinked checkout carry the same thing.

### What `npm pack` carries

`files` carries the documentation in `docs/`, both builds, `plugin/` and `dist/` with `loader/`, the three framework wrappers as
`angular/`, `react/` and `vue/`, and the native sources the Capacitor CLI reads: `ios/Sources/`,
`Package.swift`, `CapacitorVideoKit.podspec`, `android/src/main/`, `android/build.gradle` and
`android/proguard-rules.pro`. No `src/`, no `packages/`, no tests, no configuration. A native app can
install the tarball and `npx cap sync` it.

The wrapper directories are why `prepare` runs the whole `build` rather than `build:package`. `npm
pack` and `npm publish` both run `prepare`, and `build:package` starts with `clean`: a `prepare` that
stopped there would delete `angular/`, `react/` and `vue/` and pack the three subpaths empty, with
every other file present and nothing failing. `scripts/finish-wrappers.mjs` is the check that would
now catch it, because the run without `--scaffold` refuses a directory the exports map names and the
build did not fill.

The app does not, and will not while this is unpublished: it installs
`file:../../capacitor-video-kit`, which npm resolves to a **symlink** at `node_modules/capacitor-video-kit`
pointing back into this repository, and `files` has no say over what is visible through a symlink.
`npx cap sync` reads `android/` and `ios/` straight out of the working tree while the app's
TypeScript reads `plugin/` through the exports map, which is why the `prepare` script matters: the
symlink shows whatever the last build left behind.

## Two builds in one package

`src/` holds both halves and two compilers read it. Neither can be dropped: `tsc` cannot compile a
Stencil component and Stencil cannot produce the plain dual ESM and CommonJS tree a Capacitor plugin
is consumed as.

| Build | Compiles | Reads | Writes |
|---|---|---|---|
| The plugin | `src/plugin.ts`, `src/video-composer/`, `src/background-publisher/`, `src/editor/` | `tsconfig.json` and `tsconfig.cjs.json` | `plugin/esm/`, `plugin/cjs/` |
| The editor | everything else in `src/`, and `src/editor/` again | `tsconfig.stencil.json`, which extends `src/tsconfig.json` | `dist/`, `loader/` |
| The MCP server, when it is built at all | `src/mcp/`, and `src/editor/` a third time | `tsconfig.mcp.json` | `mcp/` |

The third is in the table for completeness and is not part of a normal build: it produces nothing
unless `@modelcontextprotocol/sdk` is installed, and [The MCP server](mcp.md#the-mcp-server) is the whole of it.
The two that are always there are the two the heading counts.

`src/editor/` is in both, which is the point of the merge: the contract is compiled into the
plugin's tree for `capacitor-video-kit` and `capacitor-video-kit/editor`, and again into the components
that read it from `../editor`. It is pure functions and frozen data with no module state, so the two
compiled copies cannot disagree about anything but bytes. What there is exactly one of is the
**source**, which is what the Swift and Kotlin engines are written against.

Three things about this are load bearing and none of them are obvious.

**The plugin does not write into `dist/`.** Stencil's `dist` target writes a `dist/esm/` and a
`dist/cjs/` of its own, each with an `index.js`, and empties `dist/` before every build. So the
plugin's pair is `plugin/`, and `main`, `module`, `types` and the `.` and `./editor` conditions of
the exports map all point into it. The price is one warning on every production build:

```
package.json "main" property is set to "plugin/cjs/plugin.js".
It's recommended to set the "main" property to: dist/index.cjs.js
```

That warning is Stencil asking for the package root to be the component library. It cannot be:
`require('capacitor-video-kit')` has to return the two plugin proxies, and `main` is what a resolver
that does not read `exports` uses. Stencil offers no way to turn the check off short of dropping the
collection output, and a wrong `main` is a worse lie than a build warning.

**No source file may be named `*spec.ts`.** Stencil's emitter skips any file whose emitted path
contains the substring `spec.`, which is how it drops `*.spec.ts` test files, and a source file
caught by it is never transpiled at all. Rollup then reads the raw TypeScript, and what the build
says names the line rather than the cause:

```
Rollup: Parse Error: src/editor/compose-spec.ts (1:12): Expected ',', got '{'
```

That is why `toComposeSpec` lives in `src/editor/compose.ts`. The same rule is why the tests here
are `*.unit.test.ts` and `*.cmp.test.tsx`.

**There are three tsconfigs and each has a reader.** The root `tsconfig.json` is the plugin's, and
it lists its four paths one by one rather than taking `src/**` minus the rest, so that a new
directory joins a build on purpose. `src/tsconfig.json` is the editor's, and it is in `src/` rather
than at the root because Vite reads `jsx` and `jsxImportSource` for a `.cmp.test.tsx` from the
nearest tsconfig that covers it: from the root it would find the plugin's, which has no JSX
settings, and every component test would fail to render with `Invalid vNode child undefined`.
`tsconfig.stencil.json` is the editor's again with the tests taken out, because everything Stencil
compiles is copied into `dist/collection`, which is published. It is at the root rather than beside
`src/tsconfig.json` because Stencil resolves `include` and `exclude` against its own root rather
than against the directory the tsconfig is in: written the way TypeScript reads them, Stencil
compiled
nothing at all and then handed rollup untranspiled TypeScript.

### The emitted trees say which module system they are

Node decides a `.js` file's module system from the nearest package.json and nothing else, and this
package declares no `type`, because Capacitor's tooling and every legacy `require` expect the
CommonJS default. So `scripts/module-type.mjs` writes a package.json into each emitted directory
naming that directory's kind, renames the three ES modules Stencil writes beside CommonJS to `.mjs`,
and then checks its own work by handing every emitted file to Node's parser and comparing what it is
against what Node would read it as. Without that, every `import` condition of this package was
CommonJS as far as Node was concerned, and `export * from ...` threw `SyntaxError: Unexpected token
'export'` on any Node that predates the 20.19 reparse fallback.

`scripts/finish-build.mjs` does the other half for the plugin's tree: the sources keep extensionless
relative imports, because that is what the editors and bundlers here read, and Node ESM needs the
extension, so it is added to the emitted JavaScript afterwards.

### The wrappers resolve this package through a self link

`packages/react` and `packages/vue` are private npm workspaces. `packages/angular` is built
separately with `npm --prefix packages/angular run build`. All three build into this package
rather than publishing anything of their own, and each names
`capacitor-video-kit` at an exact version. npm cannot satisfy that from the repository root, because
the root is not itself a workspace, and it goes to the registry and gets a 404 - and npm installs a
missing peer by itself, so making the edge a peer dependency does not avoid the trip. So the root
declares itself as a development dependency:

```jsonc
"devDependencies": { "capacitor-video-kit": "file:." }
```

npm answers it with a symlink at `node_modules/capacitor-video-kit` pointing at `.`, each wrapper's
exact edge dedupes onto it, and `npm ls --all` exits 0. The wrappers then compile against the same
exports map a published consumer reads, rather than against a path mapping that only works here.

## Build and test

```sh
npm install --ignore-scripts
npm --prefix packages/angular install --ignore-scripts
npm run build      # the package, then the three wrapper packages
npm test           # vitest in a mock DOM, and Playwright Chromium for the components, both web
                   # render engines, and the file each of them produces
npm run typecheck  # the plugin, its own tests, the editor, the MCP server, the build helpers
                   # and the wrappers
npm run build:mcp  # only the MCP server, which a normal build skips unless its SDK is installed
npm run clean      # every output of this package; `clean:all` takes the wrappers with it
```

`npm run build` is `build:package` and then `build:wrappers`. `prepare` runs the full build, including wrappers. `build:package` builds the shared package output: clean, the plugin's two `tsc` passes,
`finish-build.mjs`, `stencil build`, `build-mcp.mjs`, and `module-type.mjs` last so that it checks
the finished tree. `build-mcp.mjs` is the one step that can decide to do nothing, and [The MCP server](mcp.md#the-mcp-server) says when and why.

### The two watches

```sh
npm run dev      # one component on its own, http://localhost:3333/?tag=ve-slider
npm run watch    # everything a linked host reads, for an app running beside this
```

They are not alternatives, and picking the wrong one is the mistake this section exists for.

`npm run dev` writes `www/` and nothing else, so a host linked to this checkout sees none of it: the
app imports `plugin/`, `dist/components/` and, through `capacitor-video-kit/angular`, the
`angular/` directory, and the dev harness writes to none of the three. It is the loop for shaping a
component against the page in `src/index.html`, not for seeing a change land in an app. A host built
against a checkout where only `dev` has ever run fails at resolution rather than at runtime -
`Cannot find module 'capacitor-video-kit'` and then a page of cascading `implicitly has an
'any' type` - because the directories the exports map names are simply not there.

`npm run watch` is the other one, and it writes every directory a full build writes: `tsc --watch`
over the plugin half, `stencil build --watch` over the editor half, and `watch:wrappers` over the
three framework bindings. A component change is on screen about six seconds after the file is saved,
most of it Stencil's.

The wrappers are in that list because leaving them out was a real bug and a quiet one. Stencil's
output targets regenerate `packages/<framework>/src/generated/` on every rebuild, which *looks* like
the wrappers are being watched, but turning that source into `angular/`, `react/` or `vue/` is
ng-packagr, `tsc` and Rollup respectively - none of which Stencil runs. So a watch that stopped at
`watch:ui` served an Angular host a wrapper built from whatever the last full build left, with no
warning, and this file used to tell you to run a second watch by hand on the days a prop or an event
changed. It does not any more; `watch` runs all of them.

**A host has to be told not to prebundle this package.** Vite's development server copies every
dependency into a cache on startup and serves the app from that copy, which is the last full build
of this package no matter what the watch writes afterwards. In an Angular host that is:

```jsonc
// angular.json, under the serve builder
"options": { "prebundle": { "exclude": ["capacitor-video-kit", "capacitor-video-kit/angular"] } }
```

The exclusion has one consequence worth knowing, because the error it produces names neither this
package nor prebundling: the host's bundler now resolves this package's imports itself, so
`@preact/signals-core` and `mediabunny` have to be installed in the host as well. The first is a
peer dependency and was always the host's to install; the second is a dependency of this package
that npm does not hoist out of a `file:` link. Without them the server starts and then answers
`Failed to resolve dependency` on the first import.

`stencil.watch.config.ts` says why the watch does not simply use the published config: a production
build names each shared chunk after a hash of its contents, and a host watching this package reads
the rewritten component before the chunk it now imports exists, fails on it, and stays failed. The
watch config is the published one with stable names, no minifier, source maps, and the readme
writer dropped, that last because an incremental rebuild regenerates a component's readme from only
what it reparsed and quietly drops the CSS custom properties table.

**The watch leaves an unminified tree behind.** Run `npm run build` before a device build, a
`npm pack`, or anything measuring size.

**A test run writes nothing a consumer reads.** `stencil-test` builds the components before it hands
them to Vitest, and that build is not `build:package`: it never reaches `module-type.mjs`, so run
against the real config it left `dist/index.mjs` and `loader/index.mjs` deleted under their new
names, the `./ui` and `./loader` conditions of the exports map pointing at nothing, and every
emitted directory unmarked, which Node reads as CommonJS. In a checkout an app is linked to, which
is how this package is developed, running its tests broke the app until the next full build. So
`npm test` passes `--stencil-config stencil.test.config.ts`, which is the real config with its
output targets replaced by one that writes to `.stencil-test-build/`. Nothing under `plugin/`,
`dist/` or `loader/` is touched by a test run at all now, so no exit from one can leave them half
written.

**`@capacitor/core` is installed here under an alias**, as `capacitor-core-build`, and
`tsconfig.json` maps the specifier onto it. Under its own name it sat in this package's
`node_modules`, and a host that links this repository rather than installing the tarball resolves
bare specifiers from inside it, so the app bundled two copies of Capacitor's core, each with its own
plugin registry, one of them reached only from this package's code. The mapping covers the plugin
half only: the editor half must not import Capacitor at all, and the `TS2307` it would get without a
mapping of its own is what keeps that true.

`stencil build` also writes `packages/*/src/generated/`, so the wrappers cannot be built first and
their generated sources are not in git.

`build/` holds the parts of the build that are not the package: today that is the guard that fails
the build when a component could be bound with `v-model` and `componentModels` has not been told
about it. It is checked by `tsconfig.tools.json` rather than by either of the package's own
tsconfigs, because everything in those is emitted and a build helper listed in one comes out as
`dist/collection/build/*.js` in the published package.

The native half is a Capacitor Android library, so it is built through a host app rather than on its
own: the Gradle wrapper, the SDK location and `variables.gradle` all live there.

```sh
cd <host app>/android
sh gradlew :capacitor-video-kit:compileDebugKotlin :capacitor-video-kit:testDebugUnitTest --rerun-tasks
```

144 JVM tests cover the parts that fail silently: the colour matrices against the CSS spec, the
timeline arithmetic (speed, clamping, music repetitions, voiceover gaps, overlay coordinates), the
parsers' reject-versus-clamp boundary, the multipart wire format and the template substitution.
`--rerun-tasks` is not optional: without it Gradle reports every task up to date and runs nothing.

The iOS half is a Swift package and does build on its own, against the device SDK:

```sh
xcodebuild -scheme CapacitorVideoKit -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/capacitor-video-kit-build -skipMacroValidation build
```

The derived data path is not decoration, and neither is removing it first. Run a second time
against the same one, that command prints `** BUILD SUCCEEDED **` in 44 lines having run **zero**
`SwiftCompile` tasks, so it will report success for Swift it has never looked at. The same thing
happens to the host app's own build, at 342 lines. A path of its own, removed first, is what makes
the answer mean anything: a real run of this target is 36 `SwiftCompile` lines for its 28 files, and
`grep -c '^SwiftCompile'` on the output is the cheapest way to know which kind of run you just had.

Add `IPHONEOS_DEPLOYMENT_TARGET=18.0` to compile it the way a host on a later floor does, which is
worth doing after touching anything behind `#available`: a deprecation that is invisible at 16 is a
warning at 18, and an `if #available` written as an early return rather than an `else` is how one
gets in.

The iOS half has tests of its own as well, in `ios/Tests/CapacitorVideoKitCoreTests/`, which run on
the iOS Simulator and nowhere else - the module imports UIKit and links Capacitor's iOS frameworks,
so there is no macOS `swift test` for it:

```sh
xcodebuild test -scheme CapacitorVideoKit \
  -destination 'platform=iOS Simulator,name=<a simulator you have>' \
  -derivedDataPath /tmp/capacitor-video-kit-test
```

Add `-only-testing:CapacitorVideoKitCoreTests/<class>` to run one file's class. The 159 cases make
their own media rather than shipping any: `TestSupport.swift` writes videos, with a tone in them when
asked, and pictures into a folder per test, renders a spec through the same parser, builder and
exporter a job uses, and reads the result back as the colour at a point of a frame; the tests about
sound measure its level over windows of a tenth of a second. That is what they check: pictures on
every track and as a transition's side, sound levels held to their cuts, music fades, inputs with no
extension or the wrong one, the encoder's settings and the file they produce, the fallback,
cancelling and the stall watch, which clip a failure names, the gallery's copy paths and album
decisions, `encodeSupport` against the real VideoToolbox, `file://` parsing, and the publisher's
bodies, templates and resend rules.

Three things they cannot reach. PhotoKit, because the test runner cannot be granted the photo
library: the gallery's PhotoKit paths were checked in a throwaway app on the simulator instead. A
data protection class, because the simulator reports none for any file, so the one test that needs
a real one skips there. And a device, where nothing here has run.

A tarball install carries `Package.swift` and `ios/Sources/` and not `ios/Tests/`, and that is
fine: SwiftPM builds a dependency's library without looking for its test target's folder (checked
with a package whose test folder was missing, under Swift 6), and the podspec's glob never reaches
the tests at all.

### On a device

`/video-kit-lab` in a debug build (the small **LAB** chip on the right edge) drives the whole thing
by hand: pick clips, probe, filmstrip, filter presets against a live CSS swatch, rotated overlays,
music, voiceover, render with progress, play the result, publish.

What only hardware can settle, and what it settled:

| Check | Result on a Redmi Note 7, Android 10 (API 29) |
|---|---|
| Overlay rotation sign | **Correct.** `rotationDeg: 30` turns clockwise on screen, so `rotationGlDeg = -rotationDeg` holds. |
| Overlay placement | `cx`/`cy` land where the web coordinates say. |
| Overlay time gate | An overlay with `startMs: 2200` is absent at 500 ms and present at 3 s. |
| Multi-clip + effects | Was broken (`VIDEO_FRAME_PROCESSING_FAILED` at the first item boundary); fixed by giving the job ownership of the overlay bitmaps. |
| Speed | Two 2 s clips with the second at 2× produce 2.99 s, not 4.03 s. |
| `fit: contain` | A 720×900 source letterboxes into 720×1280. |
| Colour | A strong tint and saturation lift are plainly visible in the encoded frames. |

Still outstanding: a golden-frame comparison against a browser's `ctx.filter` for every preset, and
the publisher's kill-mid-upload recovery against a real backend.

## Decisions already taken

Settled by research against the published packages and by building the thing, and written down so
they are not reopened by accident.

  - `@stencil/core` 4.45.0, not the 5.0.0 beta. Stencil 5 renames every output target, replaces
    `shadow: true` with an encapsulation object and moves to ESM on rolldown. It was moving daily
    when this was written and `@ionic/core` still depends on Stencil 4
  - `stencil test` is not used. That runner is deprecated as of 4.43 and removed in 5. Tests run on
    `@stencil/vitest`, and browser tests on Playwright Chromium
  - `dist-custom-elements` is mandatory, not a preference: the React wrappers import
    `defineCustomElement` from it by name
  - `customElementsExportBehavior` is `single-export-module`, the only value that satisfies the
    React, Vue and Angular generators at once. The cost is that nothing self registers
  - `customElementsDir` is set explicitly on all three wrapper targets, because they do not agree on
    a default: React uses `dist/components` and the other two use `components`
  - no Ionic dependency of any kind in the components. The whole Ionic surface in the Angular editor
    is four controls and they are cheaper to own than to depend on
  - state is `@preact/signals-core`, left external in the build. Not `@stencil/store`, which cannot
    express a computed value at all, against 83 of them in the editor. Two copies in one dependency
    tree break reactivity silently in both directions, so `npm ls @preact/signals-core` printing
    exactly one resolved version is worth checking
  - the asset base lives on a `Symbol.for` key on `globalThis`, not in Stencil's runtime
  - `capacitor-video-kit/react` is bundled with Rollup rather than emitted by `tsc`, so that
    `@stencil/react-output-target` and the 18.4 MB of generator dependencies behind it stay out of a
    consumer's tree. The Vue and Angular packages are not bundled, because neither has the problem
  - the stickers and the fonts are published once, in `dist/components/assets`. Three byte identical
    copies used to ship, which was 3.3 MB of a 5.1 MB install, and `setEditorAssetPath` means a host
    can only point at one of them anyway
  - no source maps, anywhere, in any published package. Every package publishes built output and no
    sources, so a map names a `src/` the consumer does not have and a debugger stops showing the
    shipped JavaScript to report a missing file instead. The one map still published is the Angular
    package's, which ng-packagr writes whatever the tsconfig says and which does not dangle, because
    it inlines every source in `sourcesContent`
  - each published package carries its own copy of the repository's `LICENSE`. npm includes a file
    by that name whatever `files` says, so a consumer reading `node_modules/*/LICENSE` finds the
    terms rather than only the word UNLICENSED in a manifest
  - the Angular package's peer range is `^19 || ^20 || ^21 || ^22`, enumerated rather than left open
    as `>=19`. `packages/angular/README.md` has what was built and run to establish each of them

Generated files are the one place the repository's writing style does not apply. Stencil writes
`src/components/*/readme.md` and `src/components.d.ts` itself, and the wrapper sources under
`packages/*/src/generated/` are written from the components.
