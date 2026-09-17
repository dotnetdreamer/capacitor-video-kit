# choisy-video-kit

One package, both halves of video in Choisy: the **native engines** that edit and encode on the
device, and the **editor** that drives them, as framework free web components.

Two Capacitor plugins, both fully native:

- **`VideoComposer`** - edits and encodes video on the device: concat, trim, speed, colour, bitmap
  overlays, music and voiceovers. Nothing is rendered in the WebView and no media bytes cross the
  bridge.
- **`PostPublisher`** - uploads the result and creates a post in a way that survives the app being
  backgrounded, swiped away or killed for memory.

They ship together because they are always used together and two installs for one feature is a
worse wart than an unused dependency. They stay two plugin *classes* because they share nothing at
runtime but a file path: the composer writes the video, the publisher uploads whatever path it is
handed.

| Platform | Composer | Publisher | Status |
|---|---|---|---|
| Android | Media3 Transformer 1.11.x | WorkManager + OkHttp | implemented, verified on device |
| iOS | AVFoundation | background `URLSession` | implemented, 6,567 lines of Swift, compiles for device; no device run recorded here |
| Web | none | none | stub - `capabilities()` answers `supported: false` |

> ### An iOS host has to be on iOS 16, and a new Capacitor 8 app is on 15
>
> `Package.swift` and `ChoisyVideoKit.podspec` both declare iOS 16, and both iOS templates
> `@capacitor/cli` 8.5.0 unpacks, the SwiftPM one and the CocoaPods one, set
> `IPHONEOS_DEPLOYMENT_TARGET = 15.0` in all four build configurations, the CocoaPods one adding
> `platform :ios, '15.0'` to the Podfile as well. So a stock app stops on its first build until that
> one version is made up, which is why this is the first thing here. Where it stops depends on the
> package manager, and neither message names the line to change.
>
> **SwiftPM resolves the graph and then refuses to plan the build.** `xcodebuild` fetches
> `capacitor-swift-pm`, lists `ChoisyVideoKit` under `Resolved source packages`, and fails before the
> first `SwiftCompile`:
>
> ```
> error: The package product 'ChoisyVideoKit' requires minimum platform version 16.0 for the iOS
> platform, but this target supports 15.0 (in target 'CapApp-SPM' from project 'CapApp-SPM')
> ```
>
> `CapApp-SPM` is the package `npx cap sync ios` generates, so the one file the message names is the
> one file an edit does not survive.
>
> **CocoaPods stops earlier, at dependency analysis**, and names the pod rather than the platform:
>
> ```
> [!] CocoaPods could not find compatible versions for pod "ChoisyVideoKit":
>   In Podfile:
>     ChoisyVideoKit (from `../../node_modules/choisy-video-kit`)
>
> Specs satisfying the `ChoisyVideoKit (from `../../node_modules/choisy-video-kit`)` dependency were
> found, but they required a higher minimum deployment target.
> ```
>
> Two files carry the deployment target on a SwiftPM host and only one of them is worth editing:
>
> 1. `ios/App/App.xcodeproj/project.pbxproj`: set **every** `IPHONEOS_DEPLOYMENT_TARGET` in it to
>    `16.0` or higher. Xcode's target editor changes the target's copy and leaves the project level
>    one behind, so check the file rather than the inspector.
> 2. `ios/App/CapApp-SPM/Package.swift`: `platforms: [.iOS(.v16)]`.
>
> The second file is generated, says so on its third line, and `npx cap sync ios` writes it again
> every time from the **first** `IPHONEOS_DEPLOYMENT_TARGET` string in the pbxproj, of which it reads
> exactly two characters (`getMajoriOSVersion` in `@capacitor/cli`). So an edit made only there is
> undone on the next sync without a word, and a pbxproj that still holds a `15.0` above the ones you
> changed undoes it just as quietly. Edit the pbxproj properly and the generated file looks after
> itself: this app's is 18 and every sync writes `.v18` back.
>
> A CocoaPods host edits the pbxproj the same way and `ios/App/Podfile` as well, to
> `platform :ios, '16.0'`. That edit stays where it is put: `npx cap sync ios` rewrites the
> `def capacitor_pods` block and the `require_relative` line of a Podfile and leaves every other line
> alone. Editing only the Podfile is the trap, because nothing fails. `pod install` succeeds, the app
> builds, and all that stands between the developer and an app that claims an iOS it cannot run on is
> a linker warning:
>
> ```
> ld: warning: building for iOS-15.0, but linking with dylib
> '@rpath/ChoisyVideoKit.framework/ChoisyVideoKit' which was built for newer version 16.0
> ```
>
> **Why 16 and not the 18 this package declared until it was measured.** `AVAssetExportSession`'s
> `export(to:as:)` was the reason given for 18 and is not one: the SDK declares it available from
> iOS 13 and back deploys the body, so it never held a floor anywhere. The two calls that genuinely
> sit above 16 now have a second path beside them, chosen by `#available`: progress comes from
> `states(updateInterval:)` on 18 and from the session's own `progress` below it, and the record
> permission comes from `AVAudioApplication` on 17 and from `AVAudioSession` below it.
>
> **Why not 15, which would need nothing of the host at all.** What holds the floor at 16 is
> `AVAssetImageGenerator.image(at:)` and `images(for:)` in `Thumbnailer.swift`, and the pre 16
> spelling of the second one is a completion handler called once per frame that would have to be
> bridged back into an `AsyncSequence` by hand. That is a rewrite of the filmstrip rather than a
> guard around it, on a path nothing here can run, and it is not worth one version. Below 15 it is
> not close: `AVAsset.load(_:)` and `loadTracks(withMediaType:)` are iOS 15 and are used in ten
> places across the two files that build a composition.

## What is in here

| Part | Source | How a consumer reaches it |
|---|---|---|
| The two plugin proxies | `src/plugin.ts`, `src/video-composer/`, `src/post-publisher/` | `choisy-video-kit` |
| The edit contract, which the Swift and Kotlin engines are written against | `src/editor/` | `choisy-video-kit/editor` |
| The editor's web components and its store | the rest of `src/` | `choisy-video-kit/ui`, `/loader`, `/dist/components/*` |
| The native engines | `ios/Sources/`, `android/src/main/` | the Capacitor CLI, on `npx cap sync` |
| React, Vue and Angular bindings | `packages/react`, `packages/vue`, `packages/angular` | `choisy-video-kit-react` and its two siblings |

One repository and, for everything but the three wrappers, one npm package. The wrappers have to be
separate packages because a generated Stencil wrapper compiles against its framework and a package
cannot depend on React, Vue and Angular at once; everything else is one install because a second
copy of the edit contract is a post that renders one way on the phone and another way in the
preview.

## Install

Nothing here is on a registry, so `npm install choisy-video-kit` resolves to nothing and the root
manifest is `"private": true` to keep it that way until it is. There are two honest ways in.

A sibling checkout, which is what Choisy itself uses:

```jsonc
// package.json in the host app
"choisy-video-kit": "file:../../choisy-video-kit"
```

`npm install` in this repository first, whose `prepare` script leaves a built package behind, then
`npm install && npx cap sync` in the host app. The host needs nothing in its `tsconfig.json`: this
package is resolved through `node_modules` and its exports map like any other dependency.

It does need every bundler it runs to **keep the symlink**, which for an Angular host means
`"preserveSymlinks": true` on the `build` target and on the `test` target, and for Vite means not
turning `resolve.preserveSymlinks` off. A tool that resolves the real path instead looks for this
package's own dependencies next to this checkout rather than next to the app, and
`@capacitor/core` is the one it will not find: the error names a path inside this repository, which
reads like a fault here and is not one.

Or a tarball, which is what an app that is not next to this checkout gets and the only way to see
what a published install would actually contain:

```sh
npm pack                                      # in this repository: choisy-video-kit-1.3.0.tgz
npm install ../path/to/choisy-video-kit-1.3.0.tgz && npx cap sync   # in the host app
```

Either way the host is on the hook for the iOS deployment target above, and for `@capacitor/core`,
which is an optional peer dependency and is not installed for you.

One npm package registers both plugin classes: the Capacitor CLI scans every `.kt` under
`android/src/main` and emits an entry per `@CapacitorPlugin` it finds.

Gradle versions come from the host's `android/variables.gradle` (`kotlin_version`, `media3Version`,
`workManagerVersion`, `okhttpVersion`, `kotlinxCoroutinesVersion`), with the plugin's own pins as a
fallback.

### Entry points

Every consumer resolves the built package through its exports map, and every entry below has been
resolved, loaded and type checked out of an `npm pack` tarball installed into a scratch directory.

| Specifier | What it is | Needs |
|---|---|---|
| `choisy-video-kit` | Both plugin proxies, their definitions and the edit contract | `@capacitor/core` |
| `choisy-video-kit/editor` | The edit contract on its own, reaching no `registerPlugin` call and no Capacitor at all | nothing |
| `choisy-video-kit/ui` | The editor's public surface that is not a component: the host interface, the store, the catalogues, `setEditorAssetPath` | `@preact/signals-core` |
| `choisy-video-kit/loader` | `defineCustomElements()`, which registers every component at once | `@preact/signals-core` |
| `choisy-video-kit/dist/components/<tag>.js` | One component's `defineCustomElement()`, for a host that tree shakes | `@preact/signals-core` |
| `choisy-video-kit/assets/*` | The 34 stickers and the 32 fonts, for a build step that copies them | nothing |

Both packages that column names are **optional** peer dependencies, and so is `@stencil/core`,
which the emitted component declarations name. Optional is not laziness: no consumer wants all
three. A Capacitor app that never renders the web editor would otherwise install 22 MB of Stencil
and a signals library it never loads, and a React host that will never run natively would otherwise
install a native bridge. Each of the three wrapper packages declares the ones its half needs, so a
host that installs `choisy-video-kit-react` gets them without having to know they exist. A host that
renders the components without a wrapper installs `@preact/signals-core` itself, and `@stencil/core`
too if it type checks against the declarations.

`@stencil/core` deserves its own note, because a runtime dependency looks wrong for a package that
inlines its own runtime and because the answer changed when the two repositories became one.
`externalRuntime: false` means no emitted JavaScript imports it and no byte of it reaches a browser:
the standalone entry point is 49.5 kB raw and 16.1 kB gzipped, and nothing in it names
`@stencil/core`. What does name it is the declarations, where every component's `render()` is typed
`import("@stencil/core/jsx-runtime").JSX.Element`, and Stencil has no option that stops emitting
that. `@ionic/core` answers this by putting it in `dependencies`, and so did the editor while it was
a package of its own: npm 7 and later install a peer dependency automatically, so a plain peer would
have brought the same 22 MB in while saying something false besides. An **optional** peer is
different, and it is the one that fits a package whose native half is installed by an app that will
never render a component: npm does not install it, `npm ls` is clean with it absent, and the three
wrappers put it back for the consumers who do need it.

The root specifier imports `@capacitor/core` statically, so in a tree without it the import does not
resolve: Node says `ERR_MODULE_NOT_FOUND: @capacitor/core` and a bundler says the same in its own
words, and neither message names this package. Nothing in here can improve on that, because a static
import fails while the module graph is being linked, before any of this package's code runs; the
only way to catch it would be to make `VideoComposer` a promise, which is a worse package than a
documented requirement. So it is documented, here and in `src/plugin.ts`: **if you are not in a
Capacitor app, import `choisy-video-kit/editor` or `choisy-video-kit/ui`.**

Every entry resolves under Node ESM, under Vite and under TypeScript's `bundler`, `node16` and
`nodenext` resolution, and every entry carries declarations. The plugin's two entries type check
with `skipLibCheck` off; the component declarations need it on, because Stencil emits extensionless
relative imports in them that `node16` rejects. `tsconfig.base.json` here turns it on for a
different reason of the same kind, and every wrapper's readme says to turn it on too.

Nothing else is reachable: `choisy-video-kit/src/...` is not an entry point, and Node answers it
with `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than handing out raw TypeScript that only this
repository's toolchain can compile.

`choisy-video-kit/editor` reaches no Capacitor type either, and that is what
`src/video-composer/plugin.ts` exists for. The editor names `ComposeSpec` and `FilterOp`, which live
in `src/video-composer/definitions.ts`, so that file is part of the subpath's declarations; the
`VideoComposerPlugin` interface is the only thing in the composer's contract that names
`PluginListenerHandle`, so it sits in its own file instead. Left where it was, a single `import type`
became `TS2307: Cannot find module '@capacitor/core'` inside the `node_modules` of every web host
that compiles without `skipLibCheck`. The package's public surface is unchanged: `plugin.ts` is
re-exported from `src/video-composer/index.ts` and from `src/plugin.ts`, so `VideoComposerPlugin` is
imported from `choisy-video-kit` exactly as before.

### What `npm pack` carries

`files` carries both builds, `plugin/` and `dist/` with `loader/`, and the native sources the
Capacitor CLI reads: `ios/Sources/`, `Package.swift`, `android/src/main/`, `android/build.gradle`
and `android/proguard-rules.pro`. No `src/`, no tests, no configuration. A native app can install
the tarball and `npx cap sync` it.

The app does not, and will not while this is unpublished: it installs
`file:../../choisy-video-kit`, which npm resolves to a **symlink** at `node_modules/choisy-video-kit`
pointing back into this repository, and `files` has no say over what is visible through a symlink.
`npx cap sync` reads `android/` and `ios/` straight out of the working tree while the app's
TypeScript reads `plugin/` through the exports map, which is why the `prepare` script matters: the
symlink shows whatever the last build left behind.

## Use

```ts
import { VideoComposer, PostPublisher } from 'choisy-video-kit';

// Take ownership of the inputs before anything depends on them.
const { inputs } = await VideoComposer.prepareJob({ pendingPostId, inputs: [{ key, uri }] });

// Start the render. Resolves at once; the outcome arrives as an event.
await VideoComposer.addListener('progress', ({ progress }) => setBar(progress));
await VideoComposer.addListener('completed', ({ uri, posterUri }) => publish(uri));
const { jobId } = await VideoComposer.compose(spec);

// Ask directly whenever an event might have been missed.
const state = await VideoComposer.getState({ jobId });
```

Full contracts: `src/video-composer/definitions.ts` plus `src/video-composer/plugin.ts`, and
`src/post-publisher/definitions.ts`.

## Editor core

`src/editor/` is the framework-free half of editing, what `web.ts` is to the plugins. An editor UI
in any framework builds an `EditManifest` and hands it to `toComposeSpec`:

```ts
import { reconcileManifest, toComposeSpec, cssFor, filterPreset, VideoComposer } from 'choisy-video-kit';

// Start from a straight cut of the host's clips (or bring back a saved edit).
let manifest = reconcileManifest(saved, clipKeys, durationsByKey);

// Preview with the SAME maths the native render uses.
const { filter, tint } = cssFor(filterPreset(manifest.filterId).ops);
videoEl.style.filter = filter;

// Render.
const spec = toComposeSpec(manifest, uriByKey, { jobId, pendingPostId });
await VideoComposer.compose(spec);
```

| Export | What it is for |
|---|---|
| `EditManifest`, `EditClip`, `EditOverlay`, `EditMusic`, `EditVoice` | The edit, in a form that survives being put down and picked up. Overlays keep their **text**, not a bitmap, so a reopened edit is still editable. |
| `reconcileManifest` | Brings a saved edit back in line with a clip list that changed meanwhile. Clips are referred to by the host's own keys - the core never needs to know the host's clip shape. |
| `toComposeSpec` | The one translation from an edit to a render. Rasterises text at output scale, computes the bitrate. |
| `FILTER_PRESETS`, `cssFor`, `filterPreset` | CSS Filter Effects maths shared by the live preview and the native colour matrix. |
| `videoBitrateFor`, `totalDurationMs`, `isUntouched` | Output policy: stay under the upload cap; skip the encode for one untouched clip. |
| `rasteriseText`, `rasteriseArrow` | Canvas → PNG at output pixel scale, the caller's half of the overlay contract. |

There is deliberately no UI in `src/editor/` itself. A host is free to build its own screen on the
contract, and Choisy's shipping editor does exactly that, in Angular, at
`choisy-mobile/src/app/modules/video-editor/`. The web components below are a second editor on the
same contract rather than a replacement for it.

A host that wants only the editing half imports `choisy-video-kit/editor` instead. Nothing on that
path registers a plugin or imports `@capacitor/core` at runtime, so a web build that will never run
natively carries no Capacitor code: Vite tree-shakes an import of one constant from it down to
0.11 kB. The editor's own components are its first consumer, from inside this same package: they
import `../editor` relatively, which is what folding the two repositories into one was for.

## The editor as web components

The editor screen packaged so it can be dropped into a React, Vue or Angular application without
carrying Angular, Ionic or Capacitor with it.

The screen itself is not here yet. What is here is everything underneath it: the store and its undo
history, the host interface an application implements, the bridge that drives Stencil's rendering
from signals, the catalogues the sheets are built from, the icons and the bundled fonts. One
component, `ve-spinner`, is real but trivial and exists so that the wrapper generation is exercised
on every build. Read [what is not here yet](#what-is-not-here-yet) before planning around it.

| Package | What it is |
|---|---|
| `choisy-video-kit` | the components themselves, framework free, plus everything above |
| `choisy-video-kit-react` | React components, generated from the components |
| `choisy-video-kit-vue` | Vue components, generated from the components |
| `choisy-video-kit-angular` | Angular standalone components, generated from the components |

All four carry one version number and move together, the way every `@ionic/*` package sits on one
version. The three wrapper packages hold no hand written component code at all: `stencil.config.ts`
writes their `src/generated/` directories on every build, which is why those directories are ignored
by git.

Each wrapper names `choisy-video-kit` as a **peer** dependency at an exact version rather than as a
dependency at a range, and both halves of that are deliberate.

Exact, because a wrapper is generated from one particular build and hard codes that build's prop and
event names as strings: a range would let npm resolve a version whose components no longer match,
and the wrapper would pass props that do not exist and miss ones that do, with no error anywhere.
That is what `@ionic/react`, `@ionic/vue` and `@ionic/angular` all do with `@ionic/core`.

A peer, because a dependency is a version npm goes and fetches, and there is nowhere to fetch this
from: with `"choisy-video-kit": "1.3.0"` in `dependencies`, installing a wrapper tarball into an app
ended at `404 Not Found - GET https://registry.npmjs.org/choisy-video-kit`, whatever the app already
had installed. A peer edge is satisfied by whatever is in the tree, so **the core package has to be
installed with the wrapper or before it**, and then the version match is checked rather than
fetched:

```sh
npm install ../choisy-video-kit/choisy-video-kit-1.3.0.tgz \
            ../choisy-video-kit/choisy-video-kit-react-1.3.0.tgz
```

The wrapper on its own still stops, because npm installs a missing peer by itself and there is
nothing to install it from, but it stops naming the edge rather than an unexplained dependency:

```
npm warn Could not resolve dependency:
npm warn peer choisy-video-kit@"1.3.0" from choisy-video-kit-react@1.3.0
npm error 404 Not Found - GET https://registry.npmjs.org/choisy-video-kit
```

It is also the truthful edge for a package like this one. The wrapper and the app have to hold the
same copy of the components, because a second copy registers the same custom element names against a
registry that allows each exactly once. The price is that a release is four packs in one go, this
package first, and that a wrapper installed on its own says so at install time rather than at
runtime.

### Using a wrapper

React:

```tsx
import { VeSpinner } from 'choisy-video-kit-react';

export function Busy() {
  return <VeSpinner label="Building your video" />;
}
```

Vue:

```vue
<script setup lang="ts">
import { VeSpinner } from 'choisy-video-kit-vue';
</script>

<template>
  <VeSpinner label="Building your video" />
</template>
```

Angular:

```ts
import { Component } from '@angular/core';
import { VeSpinner } from 'choisy-video-kit-angular';

@Component({
  selector: 'app-busy',
  imports: [VeSpinner],
  template: `<ve-spinner label="Building your video"></ve-spinner>`,
})
export class BusyComponent {}
```

Whichever wrapper, the stickers and fonts have to be served and named, because nothing imports them
and so no bundler carries them:

```ts
import { setEditorAssetPath } from 'choisy-video-kit/ui';

setEditorAssetPath('/video-editor/');
```

with a copy of `node_modules/choisy-video-kit/dist/components/assets` served at that path. One call
covers every build, because the base is kept on a `Symbol.for` key on `globalThis` rather than in
Stencil's runtime: a consumer holds more than one copy of this package's JavaScript, one per output,
each with its own module scoped resources URL, so Stencil's own `setAssetPath` reaches only the copy
it was imported from. `src/host/asset-path.ts` has the whole of it, and the two sections below have
what a host has to call and what it has to serve.

Without a framework, from `choisy-video-kit` itself. Nothing registers itself, so a consumer either
registers one component at a time from the custom elements build:

```ts
import { defineCustomElement } from 'choisy-video-kit/dist/components/ve-spinner.js';

defineCustomElement();
```

or registers everything through the lazy loader, which is the right answer for a script tag:

```ts
import { defineCustomElements } from 'choisy-video-kit/loader';

defineCustomElements();
```

### Two things a host has to call

`installEditorFonts()` puts the editor's text faces into the document. It matters for correctness
rather than looks: the rasteriser burns text into the posted video with these faces, and a canvas
never waits for a font to arrive, so without them the render comes out in Roboto and does not match
what the customer approved. `@font-face` inside a shadow root does not apply, which is why this
cannot live in a component's own styles.

Await it and let it reject. It registers 32 faces and downloads exactly one, the face a new text
layer is drawn in, and that one download is the point: it is the only thing that proves the asset
base reaches files that are actually served. If it does not, you get

```
Error: installEditorFonts could not load VE Inter from
https://app.example.com/video-editor/assets/fonts/inter-700-latin.woff2. That is where the editor's
asset base points, so either setEditorAssetPath() names the wrong directory or this package's assets
directory is not served there.
```

at startup, which is where it is cheap, rather than a finished video in the wrong face, which is
where it is not.

`setEditorAssetPath(url)` says where the stickers and the fonts are served from. A root relative
path, a page relative one and a whole URL all work; the first two are resolved against the
document's base URL once, when they are set. Every host calls it, a script tag included: the custom
elements build the wrappers render has no script to look at and starts with no base at all, so an
application that never calls it is told so on the first sticker:

```
Error: choisy-video-kit cannot work out where its own files are served from, so
"assets/stickers/fire.svg" cannot be resolved. Nothing has called setEditorAssetPath() and this build
carries no base of its own [...] Serve a copy of
node_modules/choisy-video-kit/dist/components/assets and call
setEditorAssetPath('/video-editor/') once, before the editor renders.
```

**Pass the directory that contains `assets`, not `assets` itself.** Everything is fetched from
`assets/stickers/<id>.svg` and `assets/fonts/<face>.woff2` beneath the base, so
`setEditorAssetPath('/video-editor/assets/')` would look under `/video-editor/assets/assets/`. That
one is refused with a message saying so rather than 404ing every file. A missing trailing slash is
the other easy mistake, and is not refused but read as the directory it must have meant, because
`new URL('assets/x', '/video-editor')` resolves against `/` and would silently fetch everything from
the site root.

### Getting the assets served

The 34 stickers and the 32 fonts are not imported by any module, so no bundler will carry them.
There is one copy of them in the package, `dist/components/assets/`, and every host serves a copy of
that directory whatever build it renders. `choisy-video-kit/assets/*` is the subpath to reach them
by, so a copy step does not have to name a build directory that may move. With Vite:

```ts
viteStaticCopy({
  targets: [{ src: 'node_modules/choisy-video-kit/dist/components/assets', dest: 'video-editor' }],
});
```

served alongside `setEditorAssetPath('/video-editor/')`.

### What the host supplies

`VideoEditorHost` is the whole of what passes between the editor and the application around it, and
it is handed over once, as a plain property. The editor owns the edit: the manifest, the undo stack,
every gesture, every sheet and every pixel. It owns no file, no picker, no encoder and no device
measurement, because those differ between a Capacitor app, a React web app and a Vue web app, and a
UI package that guessed at them would be wrong in two of the three.

```ts
import { resolveEditorHost } from 'choisy-video-kit/ui';

const host = resolveEditorHost({
  media: { pickVideo, pickImage, pickAudio, probeDuration, thumbnails, release, voice },
  render: { isSupported, render },
  platform: { fileUrl, haptic, keyboard, registerBackHandler, confirm, measureInsets, debug },
});
```

Every field is optional, at every level. `resolveEditorHost()` fills in whatever is missing from the
browser defaults, and a `ResolvedEditorHost` is what every other file in the package is written
against, so nothing inside the editor asks whether the host has a thing before using it. A host that
supplies nothing at all still gets a real editor: it opens a file, plays it, cuts a real filmstrip
and hands back a real manifest, which is the right behaviour on the web rather than a degraded one.

| What the host gives | What it is for | With nothing supplied |
|---|---|---|
| `media.pickVideo`, `pickImage`, `pickAudio` | Add a clip, an overlay photo, a track | a hidden `<input type="file">` |
| `media.probeDuration` | How long a source runs | a throwaway `<video>` and a ten second timeout |
| `media.thumbnails` | The timeline's filmstrip | one `<video>`, seeked to each time in turn, onto one canvas |
| `media.release` | Give back what the edit dropped | the object URLs the default picker minted are revoked |
| `media.voice` | Record a voiceover | the voiceover sheet does not offer itself |
| `render` | Turn the edit into a file | Next hands back the manifest unrendered |
| `platform.fileUrl` | A URL the WebView can load for a `file://` or `content://` path | the identity function |
| `platform.haptic` | The buzz on a snap, a trim and a commit | nothing, which is what a phone with no motor does too |
| `platform.keyboard` | The height the text sheet sits above | `visualViewport`, the only measurement a browser has |
| `platform.registerBackHandler` | Android's back button, layer by layer | nothing is registered |
| `platform.confirm` | Discard this edit? | the package's own alert |
| `platform.measureInsets` | What the status and navigation bars cover | `env(safe-area-inset-*, 0px)` |
| `platform.debug` | Whether the package says anything on the console | silence |

**A picker resolves with null on a cancel and rejects on a real failure.** The editor shows a
different thing for each, and a host that rejects on a cancel makes every picker look broken.

**Three members stay null when the host supplied nothing, and the editor tests for null.** Not
because there was nothing to write, but because in each case "nobody answered" means something no
invented value could stand in for. `render` is null because there is no browser answer to "encode
this", and the editor greys nothing for it. `confirm` is null so that the editor knows to present
its own alert rather than the host's native one. `measureInsets` is null so that the editor pads
with `env(safe-area-inset-*, 0px)` and writes nothing over it: a measurement that does arrive is set
on the element as `--ve-safe-top` and `--ve-safe-bottom`, which beats both that fallback and
whatever a host set those properties to itself, so handing back numbers read out of the page would
overwrite a host's value with one the browser was already applying. `envSafeAreaInsets()` is that
reading, exported for the host that wants the measurement path anyway.

**`measureInsets` exists because `env()` cannot be trusted inside a native WebView, in either
direction.** It reads 0 at the bottom on Android phones whose WebView is laid out under a
transparent navigation bar, which puts the toolbar under the system buttons, and it keeps reporting
the notch at the top after the WebView has moved down below an opaque status bar, which puts a black
band over the video. Which of the two the app is in changes while the editor is open, because coming
back from a system picker drops the launch's edge-to-edge flags. So the editor measures on its way
in and again whenever the window changes size, and remembers the answer per window height. In choisy
the implementation is `() => VideoComposer.systemInsets()`, already installed with this package,
which measures the overlap between the bars and the WebView rather than the bars themselves, so a
WebView that already sits above them answers 0 and nothing is padded twice.

**`release` is the one absence that costs something and reports nothing.** It is called once,
immediately before the editor hands its result back, with both lists: the sources the result carries
and the ones the edit stopped using. Both, because what a source costs and what two sources share is
knowledge the editor does not have, since it never sees a file. In choisy the same gallery video
picked twice is two keys and one path, so a path a kept source still reads must not be unlinked, and
that check can only be made in the host. Nothing is released during the edit: a clip whose every
segment was deleted stays in the store so that an undo can bring it back, and only the customer
tapping Next settles which ones are gone. Left unimplemented, every dropped clip is held until the
app is killed, up to 100 MB of recording each. The browser default revokes the object URLs it minted
itself, and leaves alone both a URL a kept source still names and any URL the application handed in.

### Conventions every component holds to

Five rules that are a line in every component, so that reading one file is enough to know the rest.

**Only the outermost component declares the `--ve-*` tokens**, on its own `:host`, keeping choisy's
own value as a `var()` fallback (`--ve-accent: var(--choisy-wasabi-lime, #a6ff2e)`). Every other
component reads them with a fallback at each use site, `var(--ve-bg, #000)`. A component that
declared a token on its own `:host` would beat the value inherited from above and no host could
override anything, so a host themes the editor by setting the tokens on the editor element or
anywhere above it, and custom properties are the one thing that still inherits through a shadow
boundary.

**There is no Sass and there is not going to be.** Every stylesheet is plain CSS, hand flattened,
with no `&` and no native nesting. The reason is specifically `&--modifier`: renaming a `.scss` file
to `.css` compiles clean and drops those rules without a word, and the rule that goes missing is
always the one that only shows up on a device.

**Every event is `ve` prefixed and no component declares a `<prop>Change` event.** `veChange` for a
committed value, `veLive` for a value during a gesture, then `veConfirm`, `veDismiss`, `veTab`,
`veNone`, `veSearch`, `veDone`, `veCancel`. This is not only naming: `build/vue-component-models.ts`
fails the build when a component declares a prop `x` alongside an event `xChange` and
`componentModels` in `stencil.config.ts` has not been told about it. Nothing inside the editor is
`v-model` bound, so keeping the prefix means that shared config is never touched.

**Reactive work splits three ways, never one.** Where the Angular editor wrote `effect()`, the
answer here depends on what the render reads. If the render already reads every signal the work
depends on, it is `componentDidRender()` behind a remembered signature, so an unrelated repaint does
not replay it. If the work depends on a signal the render does not read, and the playhead is the
usual one, it is a real `@preact/signals-core` effect created in `connectedCallback` and disposed in
`disconnectedCallback`. If the body calls back into the store, it is `deferredEffect` from
`src/bridge/`, which queues the body onto a microtask: a preact effect runs synchronously inside the
`.value =` assignment that triggered it, which for the store is the middle of `commit()`, before the
history entry has been pushed. Never in a constructor either way, because a preact effect runs its
body immediately and Angular's did not.

**A host defines one tag and gets the tree.** Under `dist-custom-elements` a component's generated
`defineCustomElement` also defines every tag that component renders, transitively, because Stencil
collects the string literals passed to `h()`. So there is no barrel to import and no registration
list to keep in step. The price is one rule: a tag rendered through a variable is invisible to that
analysis, so a component that picks a child by name renders the choices as literal tags in a switch.

### What is not here yet

Every pixel. The working editor is 20,288 lines of Angular in
`choisy-mobile/src/app/modules/video-editor`, it ships today, and none of its screen has moved.

Specifically absent:

  - every editor component: the shell, the preview, the timeline, the toolbar and the eleven sheets
  - the gestures, the transport player, the follower video and the timeline geometry
  - the replacements for the four Ionic controls the Angular editor uses: `ve-icon`, `ve-slider`,
    `ve-progress` and the two alerts
  - a dev harness page, so `stencil build --dev --watch --serve` has nothing to open

`OverlayBitmaps` is ported but untested: rasterising a layer needs a canvas and an `Image`, so its
tests belong in the browser project alongside the preview that drives it.

## Two builds in one package

`src/` holds both halves and two compilers read it. Neither can be dropped: `tsc` cannot compile a
Stencil component and Stencil cannot produce the plain dual ESM and CommonJS tree a Capacitor plugin
is consumed as.

| Build | Compiles | Reads | Writes |
|---|---|---|---|
| The plugin | `src/plugin.ts`, `src/video-composer/`, `src/post-publisher/`, `src/editor/` | `tsconfig.json` and `tsconfig.cjs.json` | `plugin/esm/`, `plugin/cjs/` |
| The editor | everything else in `src/`, and `src/editor/` again | `tsconfig.stencil.json`, which extends `src/tsconfig.json` | `dist/`, `loader/` |

`src/editor/` is in both, which is the point of the merge: the contract is compiled into the
plugin's tree for `choisy-video-kit` and `choisy-video-kit/editor`, and again into the components
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
`require('choisy-video-kit')` has to return the two plugin proxies, and `main` is what a resolver
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

`packages/react`, `packages/vue` and `packages/angular` are npm workspaces and each names
`choisy-video-kit` at an exact version. npm cannot satisfy that from the repository root, because
the root is not itself a workspace, and it goes to the registry and gets a 404 - and npm installs a
missing peer by itself, so making the edge a peer dependency does not avoid the trip. So the root
declares itself as a development dependency:

```jsonc
"devDependencies": { "choisy-video-kit": "file:." }
```

npm answers it with a symlink at `node_modules/choisy-video-kit` pointing at `.`, each wrapper's
exact edge dedupes onto it, and `npm ls --all` exits 0. The wrappers then compile against the same
exports map a published consumer reads, rather than against a path mapping that only works here.

## The parts worth knowing about

### Composer

**A render outlives the screen that started it.** `compose()` resolves immediately and never holds a
`PluginCall` open. Results live in a process-wide registry, not in the plugin instance, because the
system may destroy the Activity while the render continues - a retained event on a dead Bridge
reaches nobody. A fresh instance replays whatever has not been acknowledged; `getState` is the
direct question; a `job_not_found` rejection means the process itself restarted.

**A foreground service keeps the encoder running.** `mediaProcessing` on API 35+, `dataSync` on 34,
untyped below. On API 35+ `startForeground` is called on the framework directly rather than through
`ServiceCompat`, whose type mask predates `mediaProcessing` and would reduce it to "no type" - which a modern target rejects outright, leaving the render unprotected on exactly the devices that
need it most.

**Colour is CSS maths, folded into one matrix**, applied in a single gamma-space fragment pass. That
is what makes the native render and a browser preview agree by construction. The one known deviation
is documented in `ColorMatrix.kt`.

**Progress comes from frame timestamps, not `Transformer.getProgress`.** With music or a voiceover
in the composition, Transformer averages the progress of every sequence, and an audio sequence that
finished seconds ago keeps reporting 99 % - so the average reads 55 % while the video is at 10 %.
The colour pass already sees each frame's output-timeline timestamp, so that is what is published.

**Overlay bitmaps belong to the job, not to the shader chain.** Media3 rebuilds its shader programs
whenever it registers a new input stream - once per clip in a multi-clip sequence - and rebuilding
releases every overlay first. An overlay that recycled its bitmap in `release()` therefore renders
the first clip and then fails the whole export at the first item boundary. (It did. See below.)

**Music repeats explicitly.** `setIsLooping` repeats the whole sequence including its leading gap,
so a track starting three seconds in would go silent for three seconds on every repeat. The plan
lays out numbered repetitions and clips the last one, in microseconds, to the video's exact end.

**Fades multiply, they do not replace.** Media3's `DefaultGainProvider.addFadeAt` overrides the
default gain inside the fade window, so a 60 %-volume track would ramp to 100 % and then drop.

**Inputs are taken, not referenced.** `prepareJob` moves app-owned files and copies everything else
into `filesDir/pending-posts/<id>/`. A picker's `content://` grant dies with the Activity that got
it. Only `cleanup` deletes a job folder.

### Publisher

**The caller's JSON stays the caller's.** `bodyTemplate` is the complete create-post body with
`"$STITCHED"`, `"$ORIGINALS"` and `"$ALL"` where ids will go, replaced textually. The plugin never
has to understand the post's schema - which matters for something that may run from a persisted
record days later. Plain string replacement, never a regex: the body carries customer-written text.

**Nothing is uploaded twice.** An id survives cancels and retries, and a file that was mid-flight
when the process died is looked up by its guid first. `publish()` on a post already in flight is a
no-op; the create step is idempotent on `postId`.

**Two workers, not one**, so a 503 on the create call retries only the create call.

**Retryable and not-retryable are different answers.** A network drop backs off silently (the caller
shows "waiting for connection"); a 401 stops at once and is retryable only once a fresh token
arrives; a 400 or a missing file is final.

**Progress is bytes, not files**, capped at 95 until the post actually exists.

### iOS

**The two plugin classes are one SwiftPM target.** `Package.swift` declares `ChoisyVideoKit` and
Capacitor registers each `@objc` class it finds separately, so `VideoComposerPlugin` and
`PostPublisherPlugin` ship in one library and share `JobFolders`, `PublishStore` and the error
mapping rather than repeating them.

**CocoaPods gets a hand written podspec beside `Package.swift`.** `ChoisyVideoKit.podspec` declares
the same single target, the same `ios/Sources/**` glob and the same iOS 16 floor, because a host that
adds its project with `npx cap add ios --packagemanager CocoaPods` compiles exactly the Swift a
SwiftPM host compiles. Three things in it are not choices. The name is one: the Capacitor CLI writes
`pod 'ChoisyVideoKit', :path => ...` into the host's Podfile from the npm package name, uppercasing
each dash separated word (`fixName` in `@capacitor/cli`), and CocoaPods then looks for a podspec of
exactly that name at the package root, so `choisy-video-kit` can only ever be
`ChoisyVideoKit.podspec`. The single `s.dependency 'Capacitor'` is another: `Package.swift` names the
`Capacitor` and `Cordova` products separately, while the `Capacitor` pod already depends on
`CapacitorCordova`, whose module name is `Cordova`. And the deployment target is the third, because
two hosts of the same package disagreeing about what it runs on is a bug that only one of them sees.

`files` in `package.json` decides whether a tarball install carries that podspec, the same way it
decides `Package.swift`. Without the entry a CocoaPods host installs cleanly, `npx cap sync ios`
writes the pod line, and `pod install` stops at `No podspec found`, naming a file the developer has
no way to know should exist.

**A render outlives the screen on iOS too, and for a second reason.** `JobRegistry` holds the jobs
outside the plugin instance, the way Android's does, and it also takes a `UIApplication` background
task assertion for the length of a render, so a customer who leaves the app mid encode gets the
suspension window rather than an immediate kill. Backgrounding stops the work deliberately and
reports `interrupted`: the registry writes the stop reason synchronously inside the notification,
and `Exporter` asks for it before it retries anything.

**The encoder is `AVAssetExportSession` with a preset ladder**, chosen on the longer edge, with one
retry at a lower preset for the AVError family Android also retries. A preset picks its own bitrate,
which is why `fileLengthLimit` and two guards after the fact stand in for the rate control the
Android engine sets directly, and why `Exporter.swift` logs the delivered rate against the ladder
the spec asked for: that number is the evidence for or against writing the `AVAssetWriter` engine
the `RenderEngine` protocol exists to allow.

**Progress has two implementations.** `states(updateInterval:)` from iOS 18, and the session's own
`progress` polled on the same interval below it. Both feed the same callback, so nothing above them
knows which ran.

**The publisher is one background `URLSession`.** Uploads continue while the app is suspended and
are handed back through `application(_:handleEventsForBackgroundURLSession:completionHandler:)`;
`PublishStore` is what survives the process dying, and a fresh plugin instance replays whatever JS
has not acknowledged. Job folders are rooted in Application Support rather than Caches, because the
system purges Caches under pressure and a half purged job folder is a post that can never be
retried, and every directory created there is marked excluded from backup.

## Failure codes

Composer: `unreadable_input` (blame `clipKey`), `encoder`, `muxer`, `interrupted`, `cancelled`,
`no_space` (carries `needBytes`), `unsupported`, `unknown`.

Publisher: `network`, `http`, `auth`, `server_rejected`, `file_missing`, `cancelled`, `unknown` - each with `phase`, an optional `httpStatus`, and `retryable`.

## Build and test

```sh
npm install        # `prepare` builds the package, so a linked host has something to resolve
npm run build      # the package, then the three wrapper packages
npm test           # 103 tests: vitest in a mock DOM, and Playwright Chromium for the components
npm run typecheck  # the plugin, the editor, the build helpers and all three wrappers
npm run clean      # every output of this package; `clean:all` takes the wrappers with it
```

`npm run build` is `build:package` and then `build:wrappers`. `build:package` is the whole of what
is published from here and is what `prepare` runs: clean, the plugin's two `tsc` passes,
`finish-build.mjs`, `stencil build`, and `module-type.mjs` last so that it checks the finished tree.

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
sh gradlew :choisy-video-kit:compileDebugKotlin :choisy-video-kit:testDebugUnitTest --rerun-tasks
```

144 JVM tests cover the parts that fail silently: the colour matrices against the CSS spec, the
timeline arithmetic (speed, clamping, music repetitions, voiceover gaps, overlay coordinates), the
parsers' reject-versus-clamp boundary, the multipart wire format and the template substitution.
`--rerun-tasks` is not optional: without it Gradle reports every task up to date and runs nothing.

The iOS half is a Swift package and does build on its own, against the device SDK:

```sh
xcodebuild -scheme ChoisyVideoKit -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/choisy-video-kit-build -skipMacroValidation build
```

The derived data path is not decoration, and neither is removing it first. Run a second time
against the same one, that command prints `** BUILD SUCCEEDED **` in 44 lines having run **zero**
`SwiftCompile` tasks, so it will report success for Swift it has never looked at. The same thing
happens to the host app's own build, at 342 lines. A path of its own, removed first, is what makes
the answer mean anything: a real run of this target is 27 `SwiftCompile` lines, and
`grep -c '^SwiftCompile'` on the output is the cheapest way to know which kind of run you just had.

Add `IPHONEOS_DEPLOYMENT_TARGET=18.0` to compile it the way a host on a later floor does, which is
worth doing after touching anything behind `#available`: a deprecation that is invisible at 16 is a
warning at 18, and an `if #available` written as an early return rather than an `else` is how one
gets in.

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
  - `choisy-video-kit-react` is bundled with Rollup rather than emitted by `tsc`, so that
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

