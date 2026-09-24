# capacitor-video-kit

One package, both halves of video on a device: the **native engines** that edit and encode, and the
**editor** that drives them, as framework free web components.

Two Capacitor plugins, both fully native:

- **`VideoComposer`** - edits and encodes video on the device: concat, trim, speed, colour, bitmap
  overlays, music and voiceovers. Nothing is rendered in the WebView and no media bytes cross the
  bridge.
- **`BackgroundPublisher`** - uploads the result and makes one finalizing call to your own API, in
  a way that survives the app being backgrounded, swiped away or killed for memory. It knows
  nothing about your backend: the URLs, the field names, the response keys and the body are all
  things you hand over.

They ship together because they are always used together and two installs for one feature is a
worse wart than an unused dependency. They stay two plugin *classes* because they share nothing at
runtime but a file path: the composer writes the video, the publisher uploads whatever path it is
handed.

| Platform | Composer | Publisher | Status |
|---|---|---|---|
| Android | Media3 Transformer 1.11.x | WorkManager + OkHttp | implemented, verified on device |
| iOS | AVFoundation: `AVAssetReader` into `AVAssetWriter`, `AVAssetExportSession` as the fallback | background `URLSession` | implemented, 11,136 lines of Swift in 28 files; builds for device and for the iOS Simulator with no compiler warning, and 159 XCTest cases run on the simulator (see **Build and test**); no device run recorded here |
| Web | WebCodecs through Mediabunny, `MediaRecorder` as the fallback | `XMLHttpRequest`, files staged in IndexedDB | implemented, covered by the Vitest and Playwright Chromium suites; see **Web** below |

> ### An iOS host has to be on iOS 16, and a new Capacitor 8 app is on 15
>
> `Package.swift` and `CapacitorVideoKit.podspec` both declare iOS 16, and both iOS templates
> `@capacitor/cli` 8.5.0 unpacks, the SwiftPM one and the CocoaPods one, set
> `IPHONEOS_DEPLOYMENT_TARGET = 15.0` in all four build configurations, the CocoaPods one adding
> `platform :ios, '15.0'` to the Podfile as well. So a stock app stops on its first build until that
> one version is made up, which is why this is the first thing here. Where it stops depends on the
> package manager, and neither message names the line to change.
>
> **SwiftPM resolves the graph and then refuses to plan the build.** `xcodebuild` fetches
> `capacitor-swift-pm`, lists `CapacitorVideoKit` under `Resolved source packages`, and fails before the
> first `SwiftCompile`:
>
> ```
> error: The package product 'CapacitorVideoKit' requires minimum platform version 16.0 for the iOS
> platform, but this target supports 15.0 (in target 'CapApp-SPM' from project 'CapApp-SPM')
> ```
>
> `CapApp-SPM` is the package `npx cap sync ios` generates, so the one file the message names is the
> one file an edit does not survive.
>
> **CocoaPods stops earlier, at dependency analysis**, and names the pod rather than the platform:
>
> ```
> [!] CocoaPods could not find compatible versions for pod "CapacitorVideoKit":
>   In Podfile:
>     CapacitorVideoKit (from `../../node_modules/capacitor-video-kit`)
>
> Specs satisfying the `CapacitorVideoKit (from `../../node_modules/capacitor-video-kit`)` dependency were
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
> '@rpath/CapacitorVideoKit.framework/CapacitorVideoKit' which was built for newer version 16.0
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

## Install

Nothing here is on a registry, so `npm install capacitor-video-kit` resolves to nothing and the root
manifest is `"private": true` to keep it that way until it is. There are two honest ways in.

A sibling checkout, which is what the applications built on this package use:

```jsonc
// package.json in the host app
"capacitor-video-kit": "file:../../capacitor-video-kit"
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
npm pack                                      # in this repository: capacitor-video-kit-core-1.3.0.tgz
npm install ../path/to/capacitor-video-kit-core-1.3.0.tgz && npx cap sync   # in the host app
```

Either way the host is on the hook for the iOS deployment target above, and for `@capacitor/core`,
which is an optional peer dependency and is not installed for you.

One npm package registers both plugin classes: the Capacitor CLI scans every `.kt` under
`android/src/main` and emits an entry per `@CapacitorPlugin` it finds.

Gradle versions come from the host's `android/variables.gradle` (`kotlin_version`, `media3Version`,
`workManagerVersion`, `okhttpVersion`, `kotlinxCoroutinesVersion`), with the plugin's own pins as a
fallback.

### iOS host setup

Everything an iOS host adds by hand, in one place. Little of it is optional where it applies,
because the way iOS reports a missing usage string is not a failed call but an app terminated at
the moment the call asks.

**The deployment target is iOS 16.** The callout at the top of this file is the whole of it,
including the generated file an edit there does not survive.

**The names.** The npm package is `capacitor-video-kit`, so `npx cap sync ios` writes a SwiftPM
package and product called `CapacitorVideoKit` into the host, or a pod of that name on a CocoaPods
host. The Swift module inside is `CapacitorVideoKitCore` whichever manager installed it - the
podspec sets `module_name` to match the SwiftPM target - and that is the name a host imports when
it writes Swift against the kit. Only the publisher's hooks below ask it to.

**`npx cap sync ios` on every checkout, before Xcode opens the project.** The
`CapApp-SPM/Package.swift` it generates records the path the kit resolved to on the machine that
ran it, and for a `file:` dependency reached through a symlink that is the real folder behind the
link. A copy of that file made on one machine can therefore name a folder the next one does not
have, and the sync is what writes the right one.

**`Info.plist`**, one key per thing the app may be asked for:

| Key | Asked for by | Without it |
|---|---|---|
| `NSPhotoLibraryAddUsageDescription` | `saveToGallery` | the app is terminated on the first save |
| `NSPhotoLibraryUsageDescription` | `requestGalleryAccess`, and so the other three gallery calls; `saveToGallery` with an `album` | the app is terminated when access is asked for; a save with an album never asks, and goes to Recents |
| `NSMicrophoneUsageDescription` | `startVoiceRecording` | the app is terminated when the first take starts |
| `NSCameraUsageDescription` | no call of the kit's: the editor's default pickers, which are `<input type="file">` elements, and a WKWebView offers the camera from every one that takes images or video | the app is terminated when somebody taps Take Photo or Video |

A host that only saves needs only the first key. Filing into an album is what the second is for on
such a host, and **Saving the finished video to the gallery** below says what happens without it.

**The editor's default audio picker is the kit's own document picker, and needs nothing from the
host.** A WKWebView cannot be trusted with an `<input type="file">` for a sound. It copies what the
input picks into a `tmp/WKFileUploadPanel-*` folder of its own before the page is told, and that
copy comes out empty when the same song is picked again about a minute after the first time -
Replace on a track somebody has just set up - so the page is handed a `File` of 0 bytes and a good
song reads as one the app cannot use. On an iOS 26.5 simulator a second pick 61 s after the first
failed every time, and picks 22 to 34 s or 70 to 79 s apart did not. So on iOS in a Capacitor app
the default `pickAudio` calls `VideoComposer.pickAudioFile`, which presents
`UIDocumentPickerViewController` for any audio type and copies the choice into
`tmp/videokit-audio/`, then reads that copy into an object URL typed as the picker said, exactly the
answer the input gives. It reaches the plugin through the `window.Capacitor` the native side puts in
the page, so it works whether or not the app has imported `capacitor-video-kit` yet, and only when
that native side lists `pickAudioFile` among the plugin's methods: iOS's bridge answers nothing at
all for a method it lacks, so a binary older than the JS gets the input rather than a pick that never
comes back. The picker opens the song where it is rather than handing over a copy of its own,
because its own copy fails the same way: with the same song picked again 57 to 63 s after the first
time, iOS deletes that copy before the kit is told. The kit's copy is the only one, read inside the
file's security scope and through a coordinated read, so a song still in iCloud or at another app's
file provider downloads after the sheet has closed rather than inside it: with no progress bar, no
cancel and no deadline, while the editor stays busy with its pickers and Next greyed, and a download
that fails - offline, say - reads as a song the app cannot use. Losing the song on every Replace a
minute after the first pick was worse. Nothing has to be called once the copy is read: the next pick
deletes it before it copies its own song there, and the plugin's next load deletes whatever is left. Capacitor loads a
plugin when it builds the bridge, in practice once a launch, and a web view reload only resets the
bridge, so that load is the app's next launch. One song at most is ever on disk in that folder, and
iOS may empty `tmp` while the app is not running besides. A host keeps all this by keeping the
default: supply a media host of its own as `{ ...browserMediaHost(), pickVideo, ... }` and leave
`pickAudio` out. No file picker plugin is needed for sounds.

Everywhere else the default is still an `<input type="file">`, and it names its formats, because
`accept="audio/*"` alone is the input's other trap on iOS, for Safari and any page without the kit's
native side: WebKit turns each accepted type into a Uniform Type Identifier for the Files browser,
has none for that wildcard and makes one up that no file has, so the browser opened with every song
in it greyed out. So `accept` is `audio/*` followed by MP3, M4A, AAC, WAV, AIFF, CAF, FLAC and Ogg,
each by its MIME types and by its extensions, which are what WebKit can map to real types. Every
other engine goes by the wildcard, which stays first, and offers exactly what it did before. The
list is `AUDIO_FORMATS` in `src/host/defaults.ts`, one line per format.

**The publisher needs two lines in the `AppDelegate`**, and only the publisher. A finished upload is
handed back to the app through the application delegate, and when iOS relaunches an app in the
background for one it usually connects no scene - so there is no Capacitor bridge and no plugin for
anything to reach. The Capacitor template's `AppDelegate` already has the first method, and the
second goes beside it:

```swift
import CapacitorVideoKitCore

func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
) -> Bool {
    // Makes the background session again at every launch, so it can deliver what finished while
    // the app was gone.
    PublisherSession.warmUp()
    return true
}

func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
) {
    // Calls the handler once everything the session held has been delivered.
    PublisherSession.handleEvents(identifier: identifier, completionHandler: completionHandler)
}
```

Without them a finalize call that falls due while the app is in the background waits until the
customer next opens it, and UIKit's handler is never called, so iOS is never told the app has dealt
with a wake and may hold back the ones that follow. `handleEvents` answers an identifier that is not
the kit's session by calling its handler straight away, so an app with background sessions of its
own handles those first and passes on the rest. Android needs none of this: WorkManager starts from
the manifest.

**The editor's preview takes the audio session while it plays.** A WKWebView ignores a page setting a
media element's `volume`, so on iOS the preview plays the music and the voiceover through Web Audio
instead - one `AudioContext` for the page and a gain for each element - and the music's volume, its
fade-out and each take's level are heard as the render will mix them. That needs WebKit's Audio
Session API, `navigator.audioSession`, which iOS has from 16.4, because Web Audio is otherwise
ambient sound the ringer switch silences. The preview sets its type to `playback` only while the
page has left it at `auto`, gives it back as `auto` on every pause, at the end of the post and when
the preview closes, and never touches it during a voiceover take. A host that sets a type of its own
keeps it: under `playback` the levels are heard, and under any other type the music and the voiceover
play at full volume, as they did before and as they do in a WebView without the API. A file served
from another origin plays at full volume on a stand-in element, because the graph hears such a file
as silence. A clip's
own volume and a transition's crossfade are still not heard in the iOS preview - a clip keeps its
mute, and a transition is a cut - because the way WebKit hands a media element to Web Audio does not
follow `playbackRate`, and a clip plays at anything from a quarter to four times its speed. The
export is unaffected by all of it, and none of it has been listened to on a device yet.

### Entry points

Every consumer resolves the built package through its exports map, and every entry below has been
resolved, loaded and type checked out of an `npm pack` tarball installed into a scratch directory.

| Specifier | What it is | Needs |
|---|---|---|
| `capacitor-video-kit` | Both plugin proxies, their definitions, the edit contract, the editor's render host over the composer (`composerRenderHost`) and the glue a native host needs around them (**Native hosts**) | `@capacitor/core` |
| `capacitor-video-kit/editor` | The edit contract on its own, reaching no `registerPlugin` call and no Capacitor at all | nothing |
| `capacitor-video-kit/ui` | The editor's public surface that is not a component: the host interface, the store, the catalogues, `setEditorAssetPath` | `@preact/signals-core` |
| `capacitor-video-kit/loader` | `defineCustomElements()`, which registers every component at once | `@preact/signals-core` |
| `capacitor-video-kit/dist/components/<tag>.js` | One component's `defineCustomElement()`, for a host that tree shakes | `@preact/signals-core` |
| `capacitor-video-kit/assets/*` | The 34 stickers and the 32 fonts, for a build step that copies them | nothing |

Both packages that column names are **optional** peer dependencies, and so is `@stencil/core`,
which the emitted component declarations name. Optional is not laziness: no consumer wants all
three. A Capacitor app that never renders the web editor would otherwise install 22 MB of Stencil
and a signals library it never loads, and a React host that will never run natively would otherwise
install a native bridge. Each of the three wrapper packages declares the ones its half needs, so a
host that installs `capacitor-video-kit/react` gets them without having to know they exist. A host that
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
Capacitor app, import `capacitor-video-kit/editor` or `capacitor-video-kit/ui`.**

Every entry resolves under Node ESM, under Vite and under TypeScript's `bundler`, `node16` and
`nodenext` resolution, and every entry carries declarations. The plugin's two entries type check
with `skipLibCheck` off; the component declarations need it on, because Stencil emits extensionless
relative imports in them that `node16` rejects. `tsconfig.base.json` here turns it on for a
different reason of the same kind, and every wrapper's readme says to turn it on too.

Nothing else is reachable: `capacitor-video-kit/src/...` is not an entry point, and Node answers it
with `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than handing out raw TypeScript that only this
repository's toolchain can compile.

`capacitor-video-kit/editor` reaches no Capacitor type either, and that is what
`src/video-composer/plugin.ts` exists for. The editor names `ComposeSpec` and `FilterOp`, which live
in `src/video-composer/definitions.ts`, so that file is part of the subpath's declarations; the
`VideoComposerPlugin` interface is the only thing in the composer's contract that names
`PluginListenerHandle`, so it sits in its own file instead. Left where it was, a single `import type`
became `TS2307: Cannot find module '@capacitor/core'` inside the `node_modules` of every web host
that compiles without `skipLibCheck`. The package's public surface is unchanged: `plugin.ts` is
re-exported from `src/video-composer/index.ts` and from `src/plugin.ts`, so `VideoComposerPlugin` is
imported from `capacitor-video-kit` exactly as before.

### What `npm pack` carries

`files` carries both builds, `plugin/` and `dist/` with `loader/`, the three framework wrappers as
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

## Use

```ts
import { VideoComposer, BackgroundPublisher } from 'capacitor-video-kit';

// Take ownership of the inputs before anything depends on them.
const { inputs } = await VideoComposer.prepareJob({ batchId, inputs: [{ key, uri }] });

// Start the render. Resolves at once; the outcome arrives as an event.
await VideoComposer.addListener('progress', ({ progress }) => setBar(progress));
await VideoComposer.addListener('completed', ({ uri, posterUri }) => publish(uri));
const { jobId } = await VideoComposer.compose(spec);

// Ask directly whenever an event might have been missed.
const state = await VideoComposer.getState({ jobId });
```

Full contracts: `src/video-composer/definitions.ts` plus `src/video-composer/plugin.ts`, and
`src/background-publisher/definitions.ts`.

## Editor core

`src/editor/` is the framework-free half of editing, what `web.ts` is to the plugins. An editor UI
in any framework builds an `EditManifest` and hands it to `toComposeSpec`:

```ts
import { reconcileManifest, toComposeSpec, cssFor, filterPreset, VideoComposer } from 'capacitor-video-kit';

// Start from a straight cut of the host's clips (or bring back a saved edit).
let manifest = reconcileManifest(saved, clipKeys, durationsByKey);

// Preview with the SAME maths the native render uses.
const { filter, tint } = cssFor(filterPreset(manifest.filterId).ops);
videoEl.style.filter = filter;

// Render.
const spec = toComposeSpec(manifest, uriByKey, { jobId, batchId });
await VideoComposer.compose(spec);
```

| Export | What it is for |
|---|---|
| `EditManifest`, `EditClip`, `EditOverlay`, `EditMusic`, `EditVoice` | The edit, in a form that survives being put down and picked up. Overlays keep their **text**, not a bitmap, so a reopened edit is still editable. |
| `reconcileManifest` | Brings a saved edit back in line with a clip list that changed meanwhile. Clips are referred to by the host's own keys - the core never needs to know the host's clip shape. |
| `toComposeSpec` | The one translation from an edit to a render. Rasterises text at output scale, computes the bitrate, writes the host's size ceiling when there is one. |
| `FILTER_PRESETS`, `cssFor`, `filterPreset` | CSS Filter Effects maths shared by the live preview and the native colour matrix. |
| `videoBitrateFor`, `totalDurationMs`, `isUntouched` | Output policy: the bitrate a frame of this size needs to look like its source, however big that makes the file; skip the encode for one untouched clip. |
| `rasteriseText`, `rasteriseArrow` | Canvas → PNG at output pixel scale, the caller's half of the overlay contract. |

There is deliberately no UI in `src/editor/` itself. A host is free to build its own screen on the
contract, and the first application on this package did exactly that, in Angular, until the
components below replaced it. The contract is what both were written against, which is why replacing
one editor with the other changed no manifest and no render.

A host that wants only the editing half imports `capacitor-video-kit/editor` instead. Nothing on that
path registers a plugin or imports `@capacitor/core` at runtime, so a web build that will never run
natively carries no Capacitor code: Vite tree-shakes an import of one constant from it down to
0.11 kB. The editor's own components are its first consumer, from inside this same package: they
import `../editor` relatively, which is what folding the two repositories into one was for.

## The editor as web components

The editor screen packaged so it can be dropped into a React, Vue or Angular application without
carrying Angular, Ionic or Capacitor with it. Twenty four custom elements, of which a host uses
exactly one: `<ve-editor>` is the screen, and the other twenty three are what it is made of.

| Import | What it is |
|---|---|
| `capacitor-video-kit` | the native plugins, plus everything above |
| `capacitor-video-kit/ui` | the components themselves, framework free, and the store they read |
| `capacitor-video-kit/react` | React components, generated from the components |
| `capacitor-video-kit/vue` | Vue components, generated from the components |
| `capacitor-video-kit/angular` | Angular standalone components, generated from the components |

One install carries all five, and a host imports the one line it needs. The three wrappers hold no
hand written component code at all: `stencil.config.ts` writes `packages/<framework>/src/generated/`
on every build, which is why those directories are ignored by git, and `build:wrappers` compiles
each into `angular/`, `react/` or `vue/` at the root, which the exports map points at.

**The wrapper and the components have to be the same build**, and being one package is what
guarantees it. A wrapper is generated from one particular build and hard codes that build's prop and
event names as strings, so a wrapper compiled against different components passes props that do not
exist and misses ones that do, with no error anywhere. A second copy of the components is worse
still: it registers the same custom element names against a registry that allows each exactly once.

That used to be an exact peer dependency between four separate packages - what `@ionic/react`,
`@ionic/vue` and `@ionic/angular` do with `@ionic/core` - and it was the rule nobody could satisfy
here, because none of these is on a registry: the peer edge sent npm to look the core package up
whenever its tarball was not installed first, and every such install ended in
`404 Not Found` against `registry.npmjs.org`.

There is nothing to version-match now, so nothing to get wrong. The frameworks themselves are
**optional peers** of this package: an application with only Angular in its tree is warned about
neither React nor Vue, and bundles neither, because nothing here imports a framework the host has
not asked for by writing its subpath.

## The editor's whole public surface

One element, four properties, two events.

```html
<ve-editor></ve-editor>
```

| Property | Type | Default | What it is |
|---|---|---|---|
| `sources` | `readonly EditorSource[]` | required | What the customer is editing. The editor hands these same objects back and never reads a field it did not put there, so a host can carry its own on them. |
| `manifest` | `EditManifest` | a straight cut of `sources` | A previous edit of these same sources, when the customer is stepping back into one. |
| `maxSources` | `number` | `10` | When Add stops offering itself. |
| `host` | `VideoEditorHost` | the browser defaults | The door to the device: pickers, the encoder, the keyboard, the back button. Absent is a real editor, not a degraded one. |

| Event | Detail | When |
|---|---|---|
| `veDone` | `VideoEditorResult` | The customer tapped Next and the render, if there was one, finished. |
| `veCancel` | `EditorCancelReason`, `'back'` or `'exit'` | They left without a video. Two reasons because a host's own navigation has to tell a back press from a discard. |

```ts
interface VideoEditorResult {
  /** The originals, in the order the customer left them and without the ones they removed. */
  sources: EditorSource[];
  manifest: EditManifest;
  /** Absent when there was nothing to render. A single untouched clip is not re-encoded. */
  stitched?: EditorSource;
}
```

All four properties are objects or numbers, so they are set as **DOM properties, not attributes**.
Every framework wrapper here does that for you; a plain page writes `element.sources = [...]`.

**That is the whole contract.** There is no imperative API, no `open()` that resolves with a result,
no service to construct. The editor is an element: a host puts it on screen however it puts anything
on screen, and takes it off when one of the two events arrives. What that buys is that the editor
has no opinion at all about navigation, and navigation is the part every application does
differently. An Ionic host opens it in an `ion-modal`, a React web application might route to it, and
neither has to be talked out of it.

The things a video editor needs that an element cannot do for itself are all in `host`, and the
split is the same one every time: **the editor owns the edit, the application owns the device.** The
manifest, the undo stack, every gesture, every sheet and every pixel are the package. Files,
encoding, the upload afterwards and anything that reaches Capacitor are the application, because
they are what differs between a native app and a web page, and a UI package that guessed at them
would be wrong wherever it guessed.

## Putting the editor on screen

Four steps, and only the third one changes between frameworks.

1. `setEditorAssetPath('/video-editor/')`, with a copy of the package's assets served there.
2. `installEditorFonts()`, at startup, where a failure is loud.
3. Define the tag, which is what a wrapper does for you and what a plain page does in one call.
4. Set `sources` and listen for `veDone`.

The two sections after the frameworks are the whole of what steps 1 and 2 are about, and both are
worth reading before the first sticker 404s.

### A plain page, no framework and no build step

`examples/plain-web/` is this, checked in and runnable:

```sh
npm run build:package    # once, so dist/ exists
npm run example
```

It prints `http://localhost:5173`, and that page is the editor, on two of MDN's example videos, with
no application around it. Without the build first it says so and stops, naming the file it wanted:

```
/path/to/capacitor-video-kit/dist/components/ve-editor.js is not there.
Run "npm run build:package" in /path/to/capacitor-video-kit first.
```

`serve.mjs` is a static server with no dependencies: it serves the example directory, `node_modules/`
so that a bare specifier in the import map resolves to real files the way a bundler would resolve
it, and the package's `dist/components/assets` at `/video-editor/assets/`.

The page itself is three files. The import map, because there is no bundler to resolve a bare
specifier:

```html
<script type="importmap">
  {
    "imports": {
      "capacitor-video-kit/": "/node_modules/capacitor-video-kit/",
      "@preact/signals-core": "/node_modules/@preact/signals-core/dist/signals-core.mjs"
    }
  }
</script>
<script type="module" src="./example.js"></script>
```

and then the whole integration, which is `example.js` with its comments taken out:

```js
import { defineCustomElement as defineVideoEditor } from 'capacitor-video-kit/dist/components/ve-editor.js';
import { installEditorFonts, setEditorAssetPath } from 'capacitor-video-kit/dist/components/index.js';

const SOURCES = [
  { key: 'clip-a', fileName: 'flower.mp4', playbackUrl: 'https://mdn.github.io/shared-assets/videos/flower.mp4' },
  { key: 'clip-b', fileName: 'friday.mp4', playbackUrl: 'https://mdn.github.io/shared-assets/videos/friday.mp4' },
];

setEditorAssetPath('/video-editor/');
installEditorFonts().catch((error) => report(String(error), true));

defineVideoEditor();

const editor = document.createElement('ve-editor');
editor.sources = SOURCES;
editor.maxSources = 10;
editor.addEventListener('veDone', (event) => showResult(event.detail));
editor.addEventListener('veCancel', (event) => showCancelled(event.detail));
document.getElementById('stage').replaceChildren(editor);
```

`showResult` puts the manifest on the page and takes the editor off it, because one of those two
events is the end of the screen and an editor left mounted is a video left playing.

`defineVideoEditor()` is the only registration on the page and it defines all twenty four tags, for
the reason in [conventions](#conventions-every-component-holds-to). The page prints how many it
found along the bottom, so that claim is checked rather than asserted.

There is no `host` object at all, which is the other thing this page is for. The editor then runs on
the browser defaults: the pickers are file inputs, the durations come from a throwaway `<video>`,
the filmstrip is cut with a canvas, and Next hands the manifest back unrendered, because the editor
is handed no `render` host and does not go looking for one. A page that wants the browser to encode
gives it one, exactly as a Capacitor app does - see [Web](#web).

Both imports come out of `dist/components` on purpose. `capacitor-video-kit/ui` is the same code
compiled a second time for bundlers, so a page that took the element from one and
`setEditorAssetPath` from the other would download the editor twice. An import map also has no
exports map to read, so it can only name real files: `capacitor-video-kit/ui` is not a path that exists
on disk, while `dist/components/index.js` is.

The alternative to naming the element's own file is the lazy loader, which registers every tag at
once and fetches each component's code only when that tag turns up in the page:

```html
<script type="importmap">
  { "imports": { "@preact/signals-core": "/node_modules/@preact/signals-core/dist/signals-core.mjs" } }
</script>
<script type="module">
  import { defineCustomElements } from '/node_modules/capacitor-video-kit/loader/index.mjs';
  import { installEditorFonts, setEditorAssetPath } from '/node_modules/capacitor-video-kit/dist/capacitor-video-kit/index.esm.js';

  setEditorAssetPath('/video-editor/');
  defineCustomElements();
  void installEditorFonts();
</script>
```

The import map does not go away, because the lazy build imports the signals library by name too, and
nothing in this package can resolve a bare specifier for a browser. The second import is that same
lazy bundle's own entry rather than `dist/components/index.js`, so the page still holds one copy of
the editor and not two. A host with a bundler writes `from 'capacitor-video-kit/loader'` and
`from 'capacitor-video-kit/ui'` and never sees either path.

### React

```sh
npm install ../capacitor-video-kit/capacitor-video-kit-core-1.3.0.tgz
```

Once, wherever the application starts:

```ts
import { installEditorFonts, setEditorAssetPath } from 'capacitor-video-kit/ui';

setEditorAssetPath('/video-editor/');
void installEditorFonts();
```

Then the editor is a component:

```tsx
import { VeEditor } from 'capacitor-video-kit/react';
import type { EditorSource, VideoEditorResult } from 'capacitor-video-kit/ui';

const SOURCES: EditorSource[] = [
  { key: 'clip-a', fileName: 'flower.mp4', playbackUrl: '/media/flower.mp4' },
];

export function EditorScreen({ onDone }: { onDone: (result: VideoEditorResult) => void }) {
  return (
    <VeEditor
      sources={SOURCES}
      maxSources={10}
      onVeDone={(event) => onDone(event.detail)}
      onVeCancel={() => history.back()}
    />
  );
}
```

Nothing registers a custom element here, in any of the three frameworks. The generated wrapper holds
the component's own `defineCustomElement` and calls it as the module is imported, and that one call
defines the other twenty three tags. An event is a prop named `on` plus the event, capitalised, and
what the handler is given is the `CustomEvent` itself, so **the result is `event.detail`**.

### Vue

```sh
npm install ../capacitor-video-kit/capacitor-video-kit-core-1.3.0.tgz
```

```vue
<script setup lang="ts">
import { VeEditor } from 'capacitor-video-kit/vue';
import type { EditorSource, VideoEditorResult } from 'capacitor-video-kit/ui';

const sources: EditorSource[] = [
  { key: 'clip-a', fileName: 'flower.mp4', playbackUrl: '/media/flower.mp4' },
];

function onDone(event: CustomEvent<VideoEditorResult>) {
  console.log(event.detail.manifest);
}
</script>

<template>
  <VeEditor :sources="sources" :max-sources="10" @veDone="onDone" />
</template>
```

A prop may be written either way, `:max-sources` or `:maxSources`; Vue camelises what it is given
and the wrapper sets it on the element as a property, objects and arrays included. A listener is the
event's own name, and again the handler is given the `CustomEvent`.

`setEditorAssetPath` and `installEditorFonts` are the same two calls as in React, in `main.ts`.

### Angular

```sh
npm install ../capacitor-video-kit/capacitor-video-kit-core-1.3.0.tgz
```

```ts
import { Component } from '@angular/core';
import { VeEditor } from 'capacitor-video-kit/angular';
import type { EditorSource, VideoEditorResult } from 'capacitor-video-kit/ui';

@Component({
  selector: 'app-editor-screen',
  imports: [VeEditor],
  template: `
    <ve-editor
      [sources]="sources"
      [maxSources]="10"
      (veDone)="onDone($event)"
      (veCancel)="onCancel()"
    ></ve-editor>
  `,
})
export class EditorScreenComponent {
  readonly sources: EditorSource[] = [
    { key: 'clip-a', fileName: 'flower.mp4', playbackUrl: '/media/flower.mp4' },
  ];

  onDone(event: CustomEvent<VideoEditorResult>): void {
    console.log(event.detail.manifest);
  }

  onCancel(): void {}
}
```

The wrapper is a standalone component, so it goes in `imports` and there is no
`CUSTOM_ELEMENTS_SCHEMA` and no module. Inputs are camelCase, `[maxSources]`, and an output hands
over the `CustomEvent`, so `$event` is the event and `$event.detail` is the result. Under
`strictTemplates` a missing `[sources]` is a build error rather than an empty editor:

```
error NG8008: Required input 'sources' from component VeEditor must be specified.
```

A host installing this package from a checkout rather than a tarball also needs
`"preserveSymlinks": true` on both the `build` and the `test` target, for the reason in
[Install](#install).

### A Capacitor app, where the native engines do the rendering

Everything above is the same. What changes is that `host` is no longer left out, because on a phone
there is a real answer to every question the browser defaults were guessing at - including the
render, which the defaults leave null. The wiring below is the same wiring a plain web page uses
with the web implementations; only the pickers differ.

```ts
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { VideoComposer, composerRenderHost, webViewUrl } from 'capacitor-video-kit';
import { browserMediaHost, registerBackHandlerWith, type VideoEditorHost } from 'capacitor-video-kit/ui';

const host: VideoEditorHost = {
  media: {
    // The defaults for what the app does not replace: `pickImage`, and `pickAudio`, which on iOS is
    // already the kit's own document picker (see iOS host setup).
    ...browserMediaHost(),
    pickVideo,       // the app's own clip pickers, resolving null on a cancel (see Native hosts)
    pickMedia,
    probeDuration: async (source) => (await VideoComposer.probe({ uri: source.sourcePath! })).durationMs,
    thumbnails: async ({ source, timesMs, maxHeight, precise }) => {
      const { uris } = await VideoComposer.thumbnails({
        uri: source.sourcePath!,
        timesMs: [...timesMs],
        maxHeight,
        precise,
      });
      // The composer writes files; the WebView needs URLs it is allowed to load.
      return uris.map(webViewUrl);
    },
    sounds: {
      list: async () => (await VideoComposer.listSounds()).sounds,
      extract: async (source) => {
        const out = await VideoComposer.extractAudio({ uri: source.sourcePath! });
        return out.hasAudio ? { ...out, id: out.id!, uri: out.uri!, fileName: out.fileName!, durationMs: out.durationMs!, savedAt: out.savedAt! } : null;
      },
      remove: (id) => VideoComposer.deleteSound({ id }),
    },
    release: ({ kept, dropped }) => discardRecordings(kept, dropped),
    voice: {
      start: () => VideoComposer.startVoiceRecording(),
      stop: () => VideoComposer.stopVoiceRecording(),
    },
  },
  // The render, over the same composer, on a phone and in a page alike. See below.
  render: composerRenderHost(),
  platform: {
    // No `fileUrl`: the default is `webViewUrl`, which sends a device path through Capacitor's local
    // server wherever the page has Capacitor.
    haptic: (kind) => {
      switch (kind) {
        case 'light':     void Haptics.impact({ style: ImpactStyle.Light }); break;
        case 'medium':    void Haptics.impact({ style: ImpactStyle.Medium }); break;
        case 'selection': void Haptics.selectionChanged(); break;
        case 'success':   void Haptics.notification({ type: NotificationType.Success }); break;
        case 'warning':   void Haptics.notification({ type: NotificationType.Warning }); break;
      }
    },
    keyboard: {
      subscribe: (listener) => {
        const handles = [
          Keyboard.addListener('keyboardWillShow', (info) => listener(info.keyboardHeight)),
          Keyboard.addListener('keyboardWillHide', () => listener(0)),
        ];
        return () => void Promise.all(handles).then((all) => all.forEach((handle) => void handle.remove()));
      },
      show: () => void Keyboard.show(),
    },
    // At 101, ahead of Ionic's own overlay handler at 100, so the editor closes its sheet before a
    // modal decides the press was for it; a press it has nothing to close for goes on down. `ionic`
    // here is Ionic's own Platform service, not the `platform` key this sits in.
    registerBackHandler: registerBackHandlerWith(ionic),
    confirm: (request) => presentNativeAlert(request),
    measureInsets: () => VideoComposer.systemInsets(),
    debug: !environment.production,
  },
};
```

The render is `composerRenderHost()` from the package root: the editor's render host over
`VideoComposer`, the same on a phone and in a page, because the composer's web implementation renders
too and `isSupported` asks whichever implementation is loaded. Every host used to write the same
sixty lines of it by hand, and got the same few of them wrong. What differs between hosts is what
happens to the file afterwards, and that is what the options are for:

```ts
import { composerRenderHost, readRenderFile } from 'capacitor-video-kit';

// An app that keeps its renders, in drafts or the gallery: nothing to say.
const render = composerRenderHost();

// An app whose render is only ever on its way to an upload.
const uploadRender = composerRenderHost({
  // The upload sends a File, so the render is read into one: `edited-<jobId>.mp4`, or `.webm` for
  // a browser's WebM. `UploadClip` is the app's own source type: an `EditorSource` with the `File`
  // on it, which the editor hands back untouched.
  toSource: async (result, { jobId }): Promise<UploadClip> => {
    const file = await readRenderFile(result.uri, `edited-${jobId}`);
    return {
      key: `edited-${jobId}`,
      fileName: file.name,
      file,
      sourcePath: result.uri,
      thumbnailUrl: result.posterUri || undefined,
    };
  },
  // Each earlier render's folder deleted before the next starts, so an edit made twice leaves one file.
  discardPreviousRenders: { storageKey: 'my-app.render-folders' },
  // Every failed render's reason in the app's own log, in production too.
  log: (...details) => console.error(...details),
});

// ...and when the upload flow ends, either way, so the last render is not left on disk either:
await uploadRender.discardRenders();
```

| Option | What it is for | Left out |
|---|---|---|
| `toSource(result, { jobId, batchId, manifest })` | The finished file as the source `veDone` carries as `stitched`. The editor does nothing with that source but hand it back, so what it carries is the host's: a `File` for an upload, which `readRenderFile(result.uri, name?)` reads, a name for the gallery. It may be async. What it throws fails the render: a `RenderFailedError` as it is, anything else as `unknown`. It is not called for a job that finished after the customer called the render off, since the editor would throw its source away. | `{ key: 'edited-<jobId>', fileName: 'edited.mp4', sourcePath: result.uri, thumbnailUrl: result.posterUri }`, the name `edited.webm` for the WebM a browser with no MP4 encoder writes, and no thumbnail when no poster could be cut. No `playbackUrl`, because the editor plays a source without one through `platform.fileUrl(sourcePath)`. |
| `discardPreviousRenders` | `true`, or `{ storageKey, remember }`. Deletes the folder of every earlier render with `VideoComposer.cleanup` before each new render starts, and makes `discardRenders()` do the same when the host's flow ends. The ids are written down in `localStorage` as each render starts, so a run the app was killed in is cleaned up by the next one; an id whose cleanup fails is kept for next time, and so is the folder of a render on the page that has not settled yet, since `cleanup` forgets the job in it and that render would never hear how it ended. Only the newest `remember` are kept at all. A host that already kept such a list names its key, and the folders on it are still deleted; an entry that is not a folder id of its own (empty, `.` or `..`) is dropped rather than handed to `cleanup`. | Off. Nothing is written down or deleted, and `discardRenders()` does nothing, which is right for an app that keeps its renders. The defaults once on are `capacitor-video-kit.render-folders` and 16. |
| `log(...details)` | Where failures are reported: a spec `toComposeSpec` refused, a job the composer failed, an input that could not be staged, a `toSource` that threw, a cleanup that did not go through, a platform that could not be asked what it can encode. The editor can show only one of four fixed sentences, so this is the only record of why. | The package's debug switch, which the editor sets from `platform.debug`, so these lines appear exactly when the editor's own do. |
| `ids()` | The job id and the folder id of one render, called once per render. Both must be new each time: composing under the id of a job that already exists answers with that job. A folder id that is empty, `.` or `..` fails the render as `unknown` before anything starts, because the native halves keep dots and `cleanup` of `..` would delete every job folder and the one they are in. | `render-<time>-<random>` and `edit-<time>-<random>`, from `crypto.getRandomValues`, since `crypto.randomUUID` is missing from a page served over plain http. |

What it does for every host, which is the part that was written wrong by hand:

**It draws with the editor's own raster context.** The editor hands it over as
`RenderRequest.raster`, made for the frame this render is at, and the spec is built with it, so every
layer in the file is drawn exactly as the preview drew it. That is why there is no `platform` to
pass: the context resolves the sticker URLs against the asset base of the Stencil runtime the editor
was loaded with, which the plugin at the root does not have, and a context built there could point a
sticker at a different file than the customer saw. Its `output` being `manifest.output` is what keeps
a 4K post's caption from being drawn at 720p and burned in soft.

**It reads each clip by the URL its engine can open.** `sourcePath` whenever there is one. Without
one, in a browser, `playbackUrl`, since the web engine opens whatever the page can, an object URL
from the editor's own picker included. On a phone only a `blob:` URL, which it writes out as a file
first (below); a WebView URL such as Capacitor's local server is nothing a native engine can open,
so a clip with only that is refused before any job as `unreadable_input`, naming the clip.

**It hands the engine files, not blobs.** A page holds some of a post as `blob:` URLs in the
WebView's own memory - a sound from the browser's sound library, a track the default picker read in
on iOS, a clip a host kept as bytes - and neither native engine can open one. Every render goes
through `withNativeRenderInputs(spec, render, signal)`, which stages each distinct blob through
`stageRenderInput`, a mebibyte per call, renders a copy of the spec that names the staged files, and
releases them once the job has settled. In a browser it is the render and nothing else. An input
that cannot be staged rejects with a `RenderInputError` in the composer's own terms, and the job
never starts: a blob that will not read - revoked by whatever minted it, or empty - is
`unreadable_input` naming the clip whose URL it was, and a write the phone refused is `no_space`
for a full disk and `unknown` otherwise.

**It listens before it starts.** `compose` answers with the job id at once and the rest arrives as
events, and a two second clip can finish before an `await` comes back, so the three listeners are on
before `compose` is called, match on the job id, and come off however the job ends. The render
settles on the job's own `completed` or `failed`, never on `compose`'s answer, because the staged
inputs are deleted the moment it settles.

**It honours the signal at the moment a cancel can name the job.** The editor aborts when the
customer backs out of the export screen or leaves mid render. An abort before `compose` never starts
the job; one while `compose` is on its way is cancelled the moment the composer has the job, since a
cancel sent before then names an id it has never heard of and is lost, and the encode runs on with
nobody waiting. Once the signal is aborted, whatever fails after settles as the abort and is not logged:
the `cancelled` that answers its own cancel, an encoder that broke as the cancel landed, an iOS job
`interrupted` by a customer leaving the app on the way out, a `compose` that rejected, a spec
refused, an input that would not stage, a `toSource` that threw, even a `RenderFailedError` it
worded itself. The editor has let go of the render, and a line in the log would read as a broken
render nobody had. A cancel nobody here asked for, with the signal still live, is reported like any
other failure. A job that finishes after all, its cancel having lost the race with the last frame,
settles as the abort too, and `toSource` is not called for a file nobody will use. The abort listener comes off when the job
settles, so a finished render sends no cancel when the editor leaves.

**It passes the host's size ceiling on.** `RenderRequest.maxBytes`, the host's own
`output.maxBytes` handed back, goes to `toComposeSpec` as it comes, and writes nothing when it is
unset (**A size ceiling is the host's to set**).

**It rejects with `RenderFailedError` on the editor's union, whatever failed.** The composer's
`no_space`, `unreadable_input` and `too_large` carry straight across, a `RenderInputError` from
staging is read the same way, and everything else - an encoder, a muxer, an interrupted job, a
listener the bridge refused, a `toSource` that threw - is `unknown` and logged, because the editor
shows one sentence per code and a code it does not know reads as a blank apology. A render the
customer called off rejects with the signal's reason instead. The composer blames a failure on the
SEGMENT that had it, since split and duplicate put several segments over one source, and the
failure's `sourceKey` is that segment's clip key, on the base track or on any layer, so the host
hears about its own source. `instanceof` holds whichever door the class came through: every
instance carries a `Symbol.for` brand, and every copy of the class on the page - the root's,
`/ui`'s, `dist/components`' and the editor's own chunk's - looks for it. The editor also reads an
error's `name` and code, so one built without the brand is still heard.

**It does not call `prepareJob`.** That call takes ownership of its inputs and MOVES them into the
job folder, and the originals still belong to whatever step recorded or picked them: the customer
can step back, watch them, remove one, and come forward again. The composer reads each source where
it already is, and the job folder only ever holds the output.

A host that renders some other way - its own engine, a server - implements `EditorRenderHost` itself:
`toComposeSpec(manifest, uriByKey, ids, request.raster, { maxBytes: request.maxBytes })`, its own job,
and a `RenderFailedError` with a code on the union for every failure. The class is exported from the
root and from `capacitor-video-kit/ui`, and the editor recognises either.

### What is left in the application

The editor replaced one function, `VideoEditorService.open(clips)`, and the parts of it that were
never editing stayed where they were.

| The old call | Where it lives now |
|---|---|
| `open(clips, manifest, maxClips)` | `<ve-editor [sources] [manifest] [maxSources]>`, placed in whatever the application shows a full screen step in |
| the modal dismissing with `confirm` and data | `veDone`, with the same result object |
| the modal dismissing with `back` | `veCancel` |
| `VideoRenderService` | `host.render`: `composerRenderHost()` from the package root, with what the application does with the file in its `toSource` |
| `discardUnusedClips` | `host.media.release`, still in the application, which is the only place that knows two keys can share one file |
| `VideoComposer.systemInsets()` | `host.platform.measureInsets` |
| the upload that follows | untouched. The editor hands back sources and a manifest and has no idea an upload exists |

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

`ve-editor` calls it too, on its way in, and swallows the rejection into `platform.debug`. That is a
safety net and not the call: by then the editor is on screen, there is nobody to tell, and a host
that never called it would find out from a customer's video rather than from its own startup.

`setEditorAssetPath(url)` says where the stickers and the fonts are served from. A root relative
path, a page relative one and a whole URL all work; the first two are resolved against the
document's base URL once, when they are set. Every host calls it, a script tag included: the custom
elements build the wrappers render has no script to look at and starts with no base at all, so an
application that never calls it is told so on the first sticker:

```
Error: capacitor-video-kit cannot work out where its own files are served from, so
"assets/stickers/fire.svg" cannot be resolved. Nothing has called setEditorAssetPath() and this build
carries no base of its own [...] Serve a copy of
node_modules/capacitor-video-kit/dist/components/assets and call
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
that directory whatever build it renders. `capacitor-video-kit/assets/*` is the subpath to reach them
by, so a copy step does not have to name a build directory that may move. With Vite:

```ts
viteStaticCopy({
  targets: [{ src: 'node_modules/capacitor-video-kit/dist/components/assets', dest: 'video-editor' }],
});
```

served alongside `setEditorAssetPath('/video-editor/')`.

### What the host supplies

`VideoEditorHost` is the whole of what passes between the editor and the application around it, and
it is handed over once, as `editor.host`. The editor owns the edit: the manifest, the undo stack,
every gesture, every sheet and every pixel. It owns no file, no picker, no encoder and no device
measurement, because those differ between a Capacitor app, a React web app and a Vue web app, and a
UI package that guessed at them would be wrong in two of the three.

```ts
editor.host = {
  media: { pickVideo, pickImage, pickAudio, probeDuration, thumbnails, sounds, release, voice },
  render: { isSupported, render },
  platform: { fileUrl, haptic, keyboard, registerBackHandler, confirm, measureInsets, debug },
};
```

Every field is optional, at every level, and so is the property itself. `ve-editor` fills in what is
missing from the browser defaults with `resolveEditorHost()`, which is exported for a host that
drives the store itself rather than rendering the element; a `ResolvedEditorHost` is what every
other file in the package is written
against, so nothing inside the editor asks whether the host has a thing before using it. A host that
supplies nothing at all still gets a real editor: it opens a file, plays it, cuts a real filmstrip
and hands back a real manifest, which is the right behaviour on the web rather than a degraded one.

| What the host gives | What it is for | With nothing supplied |
|---|---|---|
| `media.pickVideo`, `pickImage`, `pickAudio` | Add a clip, an overlay photo, a track | a hidden `<input type="file">`, except `pickAudio` on iOS in a Capacitor app, which is the kit's own document picker |
| `media.probeDuration` | How long a source runs | a throwaway `<video>` and a ten second timeout |
| `media.thumbnails` | The timeline's filmstrip | one `<video>`, seeked to each time in turn, onto one canvas |
| `media.sounds` | The customer's kept sounds: list, extract one from a video, delete one | audio decoded in the page and kept in IndexedDB |
| `media.release` | Give back what the edit dropped | the object URLs the default picker minted are revoked |
| `media.voice` | Record a voiceover | the voiceover sheet does not offer itself |
| `render` | Turn the edit into a file: `composerRenderHost()` from the package root, on Capacitor and in a browser | Next hands back the manifest unrendered |
| `platform.fileUrl` | A URL the WebView can load for a `file://` or `content://` path | `webViewUrl`: a device path through `Capacitor.convertFileSrc` where the page has Capacitor, read off `window.Capacitor` rather than imported; every other URL, and every URL in a page without Capacitor, as it came |
| `platform.haptic` | The buzz on a snap, a trim and a commit | nothing, which is what a phone with no motor does too |
| `platform.keyboard` | The height the text sheet sits above | `visualViewport`, the only measurement a browser has |
| `platform.registerBackHandler` | Android's back button, layer by layer; `registerBackHandlerWith(platform)` from `/ui` is this over Ionic's `Platform`, at priority 101, passing on a press the editor had nothing to close for | nothing is registered |
| `platform.confirm` | Discard this edit? | the package's own alert |
| `platform.measureInsets` | What the status and navigation bars cover | `env(safe-area-inset-*, 0px)` |
| `platform.debug` | Whether the package says anything on the console | silence |

**The default filmstrip is blank for a clip served from another origin.** It draws each frame on a
canvas, and a cross origin video taints that canvas, so `toDataURL` throws `SecurityError: Tainted
canvases may not be exported` and the lane stays grey with nothing said. A file the customer picked
is an object URL and is fine; a clip from a CDN is not. A host in that position supplies
`media.thumbnails` of its own, which is what a Capacitor app does anyway.

**A picker resolves with null on a cancel and rejects on a real failure.** The editor shows a
different thing for each, and a host that rejects on a cancel makes every picker look broken.

**The sound library is three calls and the host decides where the bytes live.** `list()` answers
with what is kept, newest first; `extract(source)` pulls the audio out of a video the EDITOR picked -
so the library never grows a picker of its own - keeps it, and answers with the record; `remove(id)`
deletes one. `extract` resolves with null for a video that carries no audio track, which is a fact
about the file rather than a failure, and the editor says so plainly instead of showing an error.

On a Capacitor host this is three lines over the composer, which owns the files and the records:

```ts
sounds = {
  list: async () => (await VideoComposer.listSounds()).sounds,
  extract: async (source) => {
    const result = await VideoComposer.extractAudio({ uri: source.sourcePath ?? source.playbackUrl! });
    return result.hasAudio ? { ...result, id: result.id!, uri: result.uri! } : null;
  },
  remove: (id) => VideoComposer.deleteSound({ id }),
};
```

**A host with no `sounds` never opens the Sound sheet at all.** "Add sound" goes straight to
`pickAudio`, which is what every host did before the library existed and is still the right answer
for one with nowhere durable to put a file.

**Three members stay null when the host supplied nothing, and the editor tests for null.** Not
because there was nothing to write, but because in each case "nobody answered" means something no
invented value could stand in for. `render` is null because the editor is given one rather than
finding one: the web engine lives behind `VideoComposer`, and wiring a plugin into the editor is the
host's call, not this file's, which `composerRenderHost()` makes a one line call. There is no default
answer to "encode this", and the editor greys nothing for it. `confirm` is null so that the editor knows to present
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
in and again whenever the window changes size, and remembers the answer per window height. The usual
implementation is `() => VideoComposer.systemInsets()`, already installed with this package,
which measures the overlap between the bars and the WebView rather than the bars themselves, so a
WebView that already sits above them answers 0 and nothing is padded twice.

**`release` is the one absence that costs something and reports nothing.** It is called once,
immediately before the editor hands its result back, with both lists: the sources the result carries
and the ones the edit stopped using. Both, because what a source costs and what two sources share is
knowledge the editor does not have, since it never sees a file. In a typical gallery host the same
video picked twice is two keys and one path, so a path a kept source still reads must not be
unlinked, and
that check can only be made in the host. Nothing is released during the edit: a clip whose every
segment was deleted stays in the store so that an undo can bring it back, and only the customer
tapping Next settles which ones are gone. Left unimplemented, every dropped clip is held until the
app is killed, up to 100 MB of recording each. The browser default revokes the object URLs it minted
itself, and leaves alone both a URL a kept source still names and any URL the application handed in.

### A size ceiling is the host's to set

The package holds a video to no size of its own, because how big a finished file may be is a
product decision and the apps on this editor decide it differently. LightSnip builds 4K for its own
use and sets nothing, so its renders are as big as their rate makes them. A host whose server
refuses a file over some size says so once, beside the rungs it offers:

```ts
import { MAX_UPLOAD_BYTES } from 'capacitor-video-kit/editor'; // 100 MiB, for a host with that limit

editor.host = {
  ...host,
  output: { qualities: ['720p', '1080p'], maxBytes: MAX_UPLOAD_BYTES },
};
```

From there it is carried all the way to the file:

- **The quality sheet warns and refuses nothing.** A rung whose size estimate for this post is over
  the ceiling is marked with it, and the chosen one gets a line under the size. Nothing is greyed,
  because the estimate is an average rate the encoder may spend less than: a still or dark post
  often comes in well under.
- **The render is handed the number, and passes it on.** The editor gives it to the host's render
  as `RenderRequest.maxBytes`, and `toComposeSpec(manifest, uriByKey, ids, raster, { maxBytes })`
  writes it as the spec's `output.maxBytes`, and writes nothing when there is none.
  `composerRenderHost()` always does; a render a host wrote itself has to, because one that leaves
  it out sends no ceiling, whatever the quality sheet warned.
- **Every engine holds the file to it.** An engine stops the encode as soon as the file grows past
  the ceiling and deletes what it wrote, and measures the finished file once more before
  `completed`; either way the job fails `too_large` with the message
  `too_large max=<maxBytes> bytes=<bytes>`. iOS measures the files its writer is writing a few
  times a second and gives its `AVAssetExportSession` fallback the ceiling as `fileLengthLimit`; a
  fallback that meets that limit by stopping at it hands back a file cut short, which fails
  `too_large` too, since the ceiling is what cut it, with `bytes` the size it stopped at - at or
  UNDER `max`. So the code is the test, never `bytes > max`.
  Android counts the encoded samples its muxer is handed and checks the count on each progress
  poll, since Media3's muxer leaves room in the file it is writing that makes it read up to a fifth
  larger than it will finish. The web counts what its encoders hand the muxer, or the recorder's
  chunks, after every frame; a recorder that hands its media over only when it stops, as
  Chromium's MP4 one does, is held by the finished-file check. Nothing is refused by estimate
  before the encode starts.
- **The customer is told in a sentence of its own.** `composerRenderHost()` turns the composer's
  `too_large` into `RenderFailedError('too_large', ...)`, as a render a host wrote must, and the
  editor says the video is too big to post, with a lower quality or a shorter video as the way out
  and Keep editing where the other failures offer Try again, since trying again would build the
  same file.

### Theming

Twenty two custom properties, declared by `ve-editor` and read by everything under it. A host sets
any of them on the editor element, or anywhere above it, and the change reaches every component:
custom properties are the one thing that still inherits through a shadow boundary, which is why the
editor is themed with them and not with a stylesheet.

```css
ve-editor {
  --ve-accent: #ff5ea8;   /* a selected chip, a slider's fill, the render bar */
  --ve-cta: #ff5ea8;      /* Next */
  --ve-cta-text: #14040c;
}
```

`src/components/ve-tokens.css` is the registry, with a line on each saying what it paints. In short:
`--ve-bg`, `--ve-surface`, `--ve-sheet`, `--ve-raised` and `--ve-raised-2` are the five depths from
the page up to a tile on a sheet; `--ve-line`, `--ve-text`, `--ve-dim` and `--ve-faint` are the
hairline and the three strengths of ink; `--ve-accent`, `--ve-cta`, `--ve-cta-text` and
`--ve-danger` are the four that carry meaning; seven `--ve-lane-*` give each kind of layer its own
colour in the timeline, with `--ve-lane-ink` for the text on them; and `--ve-safe-top` and
`--ve-safe-bottom` are the system bars, which the editor overwrites with the host's measurement when
there is one.

Every one of them is a finished colour, so a host that declares nothing gets a complete palette. A
host that wants its brand in the editor sets the tokens it cares about on an ancestor of `ve-editor`
- `--ve-accent: var(--my-brand-accent)` in its own stylesheet - and the rest keep their defaults.
Four of these used to name a particular application's brand variables in their own fallback chains,
which meant this package knew one host's stylesheet by heart and no other host could reach them
without adopting those names; the mapping belongs in the host, and that is where it is now.

Nothing else is styleable from outside, and that is deliberate. Every component but the preview is
in a shadow root, and the preview is scoped, so a host's selectors reach into neither; no component
takes a `class` from the host or leaves a `::part` open. What a host can set is a token, which is a
value with a name and a meaning, rather than a rule that depends on the shape of a tree that is free
to change.

### Conventions every component holds to

Five rules that are a line in every component, so that reading one file is enough to know the rest.

**Only `ve-editor` declares the `--ve-*` tokens**, and it does it by including `ve-tokens.css`.
Every other component reads them with a fallback at each use site, `var(--ve-bg, #000)`, so it
stands up on its own in the harness and inherits the palette in the editor. A component that
declared a token on its own `:host` would beat the value inherited from above, and the host override
in [Theming](#theming) would fail in silence.

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
unless `@modelcontextprotocol/sdk` is installed, and **The MCP server** below is the whole of it.
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

`packages/react`, `packages/vue` and `packages/angular` are npm workspaces - private ones, which
build into this package rather than publishing anything of their own - and each names
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

## The MCP server

An agent that can call these tools can build a post: lay out the base track, trim and split it, put
a second video over it, add text, stickers, photos and effects, place music and voiceover, choose
the frame. What it produces is an `EditManifest`, the same document the editor's own UI produces,
because the tools call the same functions the UI's buttons call. Hand the result to `<ve-editor>`
through its `manifest` property, or straight to `toComposeSpec`, and it renders exactly as an edit
made by dragging.

It is **off unless it is asked for**, and the section below on leaving it out is the important half
of this one if you are shipping an app.

### The tools

| Tool | What it does |
|---|---|
| `manifest_create` | Starts a post, optionally with its base track laid out and its frame chosen |
| `manifest_edit` | Applies a list of edit ops in order, all or nothing |
| `manifest_inspect` | Reads a post back: durations, rows, layers, sound, and the colour ops the render will actually apply |
| `manifest_validate` | Runs a manifest through the editor's own normaliser and says what had to change |
| `catalog_list` | The filter, effect, layout and text style ids, the frames on offer, every edit op's parameters, and the limits |

Three of the five change nothing and say so through MCP's `readOnlyHint`.

A manifest is around 200 lines of JSON and an edit is usually a dozen ops, so the server keeps
manifests under short ids: every tool returns a `manifestId`, and every tool that reads one takes
either that or an inline `manifest`. Inline is not a fallback. It is how a draft the app already has
gets edited without being imported first, and what comes back is stored either way.

Two things are worth knowing before driving it:

**An op that names something the post does not have is refused, not ignored.** The editor's own
functions return the manifest unchanged for a clip id that is not there, which is right for a UI,
where the button belongs to a clip that exists. An agent can name anything, usually by carrying an
id over from an earlier version of the edit, and a silent no-op leaves it unable to tell "refused"
from "ignored". So the error names the id and lists the ones there are.

**A list of ops is all or nothing.** A list that fails at op 5 leaves the manifest exactly as it
was, and the message names the op and its position, because "no clip c3" means something different
at op 1 than it does at op 7 with five removals behind it.

### What it deliberately does not do

It does not render. Rendering is `toComposeSpec` plus a `RasterContext`, and a raster context is a
canvas: text is measured with its real loaded font, stickers and photos are decoded, and every layer
comes back as a PNG. None of that exists in a Node process, and faking it would produce a video that
did not match what the customer saw, which is the one promise the rasteriser exists to keep.

So the line is real rather than a first cut. Everything an edit **is** can be done here; turning it
into pixels belongs to the device with the screen it was edited on.

### Running it

```json
{
  "mcpServers": {
    "capacitor-video-kit": {
      "command": "node",
      "args": ["/absolute/path/to/capacitor-video-kit/mcp/mcp/stdio.js"]
    }
  }
}
```

Or inside something that already runs, with a transport of its own:

```ts
import { createVideoKitMcpServer } from 'capacitor-video-kit/mcp';

const server = createVideoKitMcpServer({ version: '1.3.0' });
await server.connect(myTransport);
```

The doubled `mcp/mcp/` is `tsc` output, not a typo: `src/mcp/` imports the editor core out of
`src/editor/`, so the common root is `src` and the emitted tree mirrors it, with `mcp/editor/` and
`mcp/data/` beside the server. That is what makes `mcp/` self-contained and safe to delete whole.

### Leaving it out

`@modelcontextprotocol/sdk` brings around 190 packages with it, a web framework and a JOSE
implementation among them, and none of that belongs anywhere near an app bundle. So an app that
wants nothing to do with the server pays nothing for it, and does not have to remember a flag to get
that:

| What you have | What the build does |
|---|---|
| No `@modelcontextprotocol/sdk` installed | Skips it, says so in one line, and leaves no `mcp/` behind |
| The SDK installed | Builds it |
| `CAPACITOR_VIDEO_KIT_MCP=0` | Never builds it, and deletes an `mcp/` an earlier build left |
| `CAPACITOR_VIDEO_KIT_MCP=1` | Builds it, and **fails** if the SDK is missing, because a build told to produce the server and quietly not doing so is how a client discovers it instead |

The SDK is an **optional peer dependency**, so the first row is what an app gets without doing
anything. Four things keep it that way and each one is load bearing:

- `src/mcp/` is excluded from `src/tsconfig.json` and `tsconfig.stencil.json`, so the editor build
  never compiles it. Left in, Stencil would copy it into `dist/collection`, which is published, and
  an app bundling the editor would be bundling a tool server it has no use for.
- It is not in `tsconfig.json`'s `include` either, so the plugin build never emits it.
- `server.ts` is the only file in the package that imports the SDK, and only `capacitor-video-kit/mcp`
  reaches it. No other entry point leads there, so no bundler follows it.
- `files` names `mcp/**` rather than `mcp/`. That is not cosmetic: Stencil's package.json validation
  resolves every non-glob entry and fails the whole build when one is missing, and this directory is
  missing on purpose whenever the server was not built.

To check for yourself that nothing leaked:

```sh
npm run build:package
grep -rl modelcontextprotocol dist/ plugin/ loader/   # nothing
```

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

**The sound library is a folder, not an index.** `extractAudio` writes one `.m4a` and one `.json`
record beside it, both named after the same id, and `listSounds` reads the folder - so nothing can
hold a list that disagrees with what is on the disk, which is what a list kept in the WebView would
eventually do the first time storage was cleared on one side and not the other. It lives outside
every job folder and the sweep does not touch it: a sound is the customer's, not a job's.

On Android the extraction is a **remux** - `MediaExtractor` hands over the compressed samples and
`MediaMuxer` writes them into an MP4 of their own, so nothing is decoded and the result is bit for
bit the sound that was in the video. iOS re-encodes to AAC, because `AVAssetExportPresetAppleM4A` is
the only audio-only door `AVAssetExportSession` offers. A browser has no demuxer a page can reach at
all, so the web implementation decodes with `decodeAudioData` and writes WAV: about 10 MB a minute,
against well under one for the remux.

**`prepareJob` copies a library sound rather than moving it.** It moves app-owned inputs, and a
sound moved out of the library is a row that plays nothing from the next post onwards. Android asks
`SoundLibrary.owns` before it chooses. iOS moves from only three folders, all of them written for
one post, and the library is not one of them, so it copies without having to ask (see **iOS**).

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
into `filesDir/video-batches/<id>/`. A picker's `content://` grant dies with the Activity that got
it. Only `cleanup` deletes a job folder.

### Publisher

**It knows nothing about your backend, on purpose.** The upload runs in a process your JavaScript is
not in, hours after `publish()` returned, so there is nobody for it to ask. Everything it needs is
DATA it was handed and wrote down: the URLs, the HTTP method, the multipart field names, the dotted
path its id lives at in your response, and the body to finish with. If a thing cannot be written
down it cannot be used here, which is why there are no callbacks anywhere in this contract.

**Two upload shapes.** `POST` builds the multipart form your `fields` and `fileField` describe -
that is where a server convention like Fine Uploader's `qquuid`/`qqfile` goes. `PUT` sends the file
as the raw body with no envelope, which is what a presigned S3, R2, GCS or Azure URL wants; there
each file carries its own signed `url`.

**The caller's JSON stays the caller's.** `bodyTemplate` is the complete finalize body with
`"$ID:<uploadId>"`, `"$IDS:<tag>"` and `"$IDS"` where ids will go, replaced textually. The plugin
never has to understand your schema - which matters for something that may run from a persisted
record days later. Plain string replacement, never a regex: the body carries customer-written text
and a `$` in it must stay a `$`. An id keeps the JSON type your server used, so a numeric id goes
back as a number and a key goes back quoted.

**Nothing is uploaded twice.** An id survives cancels and retries, and a file that was mid-flight
when the process died is looked up first, if you gave a `lookupUrlTemplate`. `publish()` on a batch
already in flight is a no-op; the finalize step is idempotent on the record being `done`.

**Two workers, not one**, so a 503 on the finalize call retries only the finalize call.

**Retryable and not-retryable are different answers.** A network drop backs off silently (the caller
shows "waiting for connection"); a 401 stops at once and is retryable only once a fresh token
arrives; a 400 or a missing file is final. A server that reports failure in the body of a 200 is
caught only if you name the field, through `finalize.requirePath` - guessing would be worse.

**Progress is bytes, not files**, capped at 95 until the finalize call has answered.

#### Moving an existing caller onto the generic contract

Everything the publisher used to assume about one particular backend is now something you pass. The
shape below is the old hard-coded behaviour, written out:

```ts
await BackgroundPublisher.publish({
  batchId,                                  // was pendingPostId
  headers: { 'X-Token': token },
  upload: {
    url: `${api}/api/download/asyncUpload`, // was uploadUrl
    method: 'POST',
    fileField: 'qqfile',                    // was hard-coded
    fields: { qquuid: '{uploadId}', qqfilename: '{fileName}' },  // were hard-coded
    idPath: 'downloadId',                   // was hard-coded
    lookupUrlTemplate: `${api}/api/download/byName/{uploadId}`,  // was {uploadGuid}
  },
  uploads: [
    { uploadId: mainGuid, tag: 'stitched', path: mainPath, mimeType: 'video/mp4',
      fields: { pictureId: String(pictureId) } },   // pictureId was a first-class field
    { uploadId: clipGuid, tag: 'original', path: clipPath, mimeType: 'video/mp4' },
  ],
  finalize: {                               // was createPost
    url: `${api}/api/Post/CreateContentPost`,
    bodyTemplate: JSON.stringify({ video: `$ID:${mainGuid}`, clips: '$IDS:original' }),
    requirePath: 'postId',                  // was an unconditional check
  },
});
```

| Was | Is |
|---|---|
| `pendingPostId` | `batchId`, everywhere including the composer |
| `uploadGuid` | `uploadId` |
| `role: 'stitched' \| 'original'` | `tag: string`, any value, never interpreted |
| `pictureId` | one entry in that upload's `fields` |
| `downloadId` on the state | `remoteId`, a string or a number |
| `postId` / `published` on the state and the finished event | `result`, your response parsed |
| `"$STITCHED"` | `"$ID:<uploadId>"` |
| `"$ORIGINALS"` | `"$IDS:<tag>"` |
| `"$ALL"` | `"$IDS"` |
| phase `creating` | phase `finalizing` |

Three behaviour changes to read carefully:

- **The stitched fallback is gone.** The old code treated the first upload as the post's video when
  nothing carried `role: 'stitched'`. Nothing is implicit now: name the upload you mean with
  `"$ID:<uploadId>"`. That policy was always the app's, and it is now written where the app can see it.
- **A 2xx is success unless you say otherwise.** The old code failed a create whose body had no
  `postId`. Set `finalize.requirePath` to keep that check.
- **Records written by the old version are dropped on upgrade.** They name fields that no longer
  exist, so a batch in flight when the new build lands is re-queued by your app rather than resumed.
  Same for the iOS background session id and the Android notification channel, both renamed: finish
  or cancel what is in flight before shipping the upgrade if that matters to you.


### iOS

**The two plugin classes are one SwiftPM target.** `Package.swift` declares the package and product
`CapacitorVideoKit` over one target, `CapacitorVideoKitCore`, and Capacitor registers each `@objc`
class it finds separately, so `VideoComposerPlugin` and `BackgroundPublisherPlugin` ship in one
library and share `JobFolders`, `PublishStore` and the error mapping rather than repeating them.

The package and product names are not choices either. `npx cap sync ios` writes
`.package(name: "CapacitorVideoKit", path: ...)` and `.product(name: "CapacitorVideoKit", ...)` into
the host's generated `CapApp-SPM/Package.swift`, from the npm package name by the same `fixName` as
the pod line below, and a host whose kit declares any other product fails to resolve the graph. The
target's name is free: nothing outside `Package.swift` refers to it.

**CocoaPods gets a hand written podspec beside `Package.swift`.** `CapacitorVideoKit.podspec` declares
the same single target, the same `ios/Sources/**` glob and the same iOS 16 floor, because a host that
adds its project with `npx cap add ios --packagemanager CocoaPods` compiles exactly the Swift a
SwiftPM host compiles. Three things in it are not choices. The name is one: the Capacitor CLI writes
`pod 'CapacitorVideoKit', :path => ...` into the host's Podfile from the npm package name,
dropping the `@`, treating every `/` and `-` as a word break and uppercasing each word that follows
one (`fixName` in `@capacitor/cli`); CocoaPods then looks for a podspec of exactly that name at the
package root, so `capacitor-video-kit` can only ever be `CapacitorVideoKit.podspec`. A rename of
the npm package is a rename of this file and of the SwiftPM package and product. The single `s.dependency 'Capacitor'` is another: `Package.swift` names the
`Capacitor` and `Cordova` products separately, while the `Capacitor` pod already depends on
`CapacitorCordova`, whose module name is `Cordova`. And the deployment target is the third, because
two hosts of the same package disagreeing about what it runs on is a bug that only one of them sees.

`files` in `package.json` decides whether a tarball install carries that podspec, the same way it
decides `Package.swift`. Without the entry a CocoaPods host installs cleanly, `npx cap sync ios`
writes the pod line, and `pod install` stops at `No podspec found`, naming a file the developer has
no way to know should exist.

**A render outlives the screen on iOS, and not the app leaving the foreground.** `JobRegistry` holds
the jobs outside the plugin instance, the way Android's does, so a WebView reload or a route change
mid encode still finds its outcome. What iOS has no equivalent of is the foreground service: a
backgrounded app is denied Metal and the hardware encoder, and a background task assertion does not
give them back - it only trades a clean stop for AVFoundation's confusing -11847. So the render is
deliberately given no assertion. The registry observes `didEnterBackgroundNotification`
synchronously, stops every render in that same call, and reports it `interrupted` with the message
`did_enter_background`; `Exporter` asks for that stop reason before it would retry anything, so a
backgrounded render never starts a second engine into the same wall. The only assertion covers the
unwind - the `failed` event, letting go of the files, and closing the microphone of a voiceover take
in progress. `willResignActive` is deliberately not a trigger: Control Centre, a call banner and
Face ID all leave the app in the foreground with its GPU. Nothing restarts an interrupted render. A
host that still wants the video composes the same spec again when the app is back, under a new
`jobId`, because a repeat id answers with the job that already exists. While any render runs the
idle timer is held off, so the phone does not lock itself in the middle of one.

**The encoder is an `AVAssetReader` feeding an `AVAssetWriter`** (`WriterEngine.swift`): one reader
over the composition, with a video-composition output that draws every frame through
`EditCompositor` and an audio-mix output that mixes every sound through the audio mix, one writer
with an input for each, and a pump per input. It asks the encoder for what Android's
`newTransformer` asks for, field for field: H.264 High with the level left to the encoder, an
average - variable - rate of `output.videoBitrate`, a key frame at most every second, `output.fps`
as the expected rate, BT.709 tags and the index at the front of the file; and AAC-LC stereo at
48 kHz, at the rate nearest `output.audioBitrate` that the encoder accepts. That last step is not a
nicety: Apple's AAC takes 64 to 320 kbps for stereo, in thirteen steps, and a rate outside the set
passes every check the writer makes up front and then fails the first append. A file gets no audio
track at all when no source has sound. Measured on the simulator, 64 and 256 kbps asked for come
out within a fifth of that. So one quality chip is one file size on both native platforms, and the
quality sheet's estimate, which is that same arithmetic, now describes an iOS file as well.

**The only size ceiling is the one the spec carries.** Earlier versions carried one host's 100 MiB
upload cap inside the engine - a `fileLengthLimit` of 90 MiB on the export session, a check that
refused a timeline the preset estimated would not fit, and a guard after the encode - so every
host's long or high-quality render failed as `unsupported`, sometimes after the whole encode had
run. All three are gone. A ceiling is a host's policy, set as `EditorOutputOptions.maxBytes` and
sent as `output.maxBytes` (**A size ceiling is the host's to set**), and with none the render is as
big as its rate makes it. With one, `WriterEngine` polls the size of the file it is writing a few
times a second and stops with `too_large` once it passes the ceiling, the `AVAssetExportSession`
fallback is given it as `fileLengthLimit`, and the finished file is measured before `completed`
whichever of the two wrote it. There is no refusal by estimate. What stays besides is the check
that the file came out as long as the timeline.

**One fallback, to `AVAssetExportSession`.** An encoder that turns the writer down - no encoder for
the request, the encoder busy, or the settings refused, before the first frame or at it - gets one
more attempt through the export session at the preset that matches the render size, which is
Android's one relaxed retry. A preset picks its own bitrate, so the switch is logged, with the rate
the file actually came out at. Nothing else is retried: not a frame the encoder had accepted and
then failed, and not a render that is being cancelled or stopped.

**Progress comes from frame timestamps**, as on Android: the fraction of the timeline the last frame
written has reached. The preset fallback has two implementations of its own, `states(updateInterval:)`
from iOS 18 and the session's `progress` polled on the same interval below it, and both feed the
same callback, so nothing above them knows which ran.

**A render is stopped for time only when it stops moving.** There is no deadline: a render that
keeps reporting frames is slow, not wedged, and how slow is too slow is the customer's call, with the
cancel button. A render whose progress has not changed for 90 seconds is stopped and reported
`unknown` with the message `timeout`, and if its export has not unwound five seconds after that the
registry writes the ending itself, so a job never says `rendering` for the rest of the process. A
cancel is answered within about half a second even when a decoder or the GPU never hands back
another frame; an ordinary one still waits for the writer to cancel and delete what it wrote, which
took up to 1.6 seconds on the simulator. A cancel that lands while the file is being closed is still
a cancel: the file is deleted and the job reports `cancelled`, as Android does.

**A failure partway through names a clip.** `EditCompositor` records the last frame it drew, and an
`unreadable_input` thrown during the encode is blamed on the base clip under that frame, which is
Android's `blameClip`. It is a best guess with a known blind side: AVFoundation reads the sound far
ahead of the picture, and a clip whose audio was damaged was measured failing the render while the
clip before it was still on screen, which is then the clip named.

**`encodeSupport` asks the encoder about the rate as well as the size.** iOS has no table like
Android's `MediaCodecInfo` to read, so each frame is asked of VideoToolbox: a compression session is
made at that size with the rate as its expected frame rate, and thrown away, and the frame is held
to the limits of the highest H.264 level the encoder lists, which is where a device that takes a
size at 30 fps and not at 60 shows it. Each size is tried both ways round, as Android tries it, the
reason names the rate only when the rate is what was refused, and every answer is kept for the life
of the process, as `plugin.ts` promises.

**Inputs are opened by what they hold.** `AVURLAsset` chooses its reader by the file's extension and
never looks at the bytes, so a file with none fails with -11828 and a WAV named `.m4a` with -11829,
and a blob `withNativeRenderInputs` stages from a type it has no extension for is written with none.
`RenderInputs` therefore reads the first bytes of each distinct input, and a file whose name does
not say what they are is hard-linked into `named/` in the job folder under one that does - copied
only when a link cannot be made - and opened from there. The original is never touched. The link
costs nothing while the host's file is there, but it does keep those bytes on disk after the host
deletes its own copy, until `cleanup` or the launch sweep takes the job folder.

**Pictures become footage.** AVFoundation has no still-image item, so each distinct picture on the
timeline is written as a short H.264 file of one frame, under `pictures/` in the job folder, when the
builder first needs it, and opened from then on like any video. `ios/PICTURES.md` has the details.

**A clip's sound holds its level to its cut.** AVFoundation's export draws a straight line from each
volume point to the next, so one point per clip ramped every clip towards the next one's level: a
clip before a picture, a held frame, a muted clip or a quieter voiceover take faded out across the
whole of its length, and every clip a transition leads out of faded towards the silence its
successor's fade-in starts from. The builder sets each level again a millisecond before its range
ends, which to the ear is the step Android's and the web's per-clip gain makes. Music fades follow
Android's `planMusic` and the web's `fadeGain`, with the one exception `ComposeMusic.fadeOutMs`
describes.

**A spec Android plans around, iOS plans around too.** A track with no `z` sits at its index plus
one, an empty track is refused with Android's own message, a clip whose in-point is at or past the
end of its footage holds its last frame for the millisecond Android and the web plan it rather than
failing the post, and music whose trim lies wholly past the end of its file leaves the post without
music rather than failing it.

**`prepareJob` moves only what was written for one post.** Three places qualify: `Documents/`,
`Library/Application Support/video-batches/` and `Library/Caches/video-composer/`. Everything else is
copied - the sound library, the gallery copies a draft points at, whatever the host keeps in
Application Support - and the source is deleted after its copy only when it is a scratch file under
`tmp/` or `Library/Caches/`, which is where the file picker leaves a pick.

**The publisher is one background `URLSession`.** Uploads continue while the app is suspended and
are handed back through `application(_:handleEventsForBackgroundURLSession:completionHandler:)`,
which the host forwards (see **iOS host setup**); `PublishStore` is what survives the process dying,
and a fresh plugin instance replays whatever JS has not acknowledged. Unlike Android, every upload
without an id is handed to the session at once, so a server sees them in whatever order the system
sends them, and a failure does not cancel the others, which keep their ids for the retry. Every
body is a private copy of the caller's file - for a `PUT` an APFS clone, which costs no space,
unless the file's data protection class would leave a clone unreadable while the phone is locked,
when it is copied - so a send in flight survives the caller deleting its file; the next send reads
the file again. A 401 or 403 is never sent again on the plugin's own account; other retryable
failures are, up to three more times, the first after 30 seconds and the rest after 60. Job folders
are rooted in Application Support rather than Caches, because the system purges Caches under
pressure and a half purged job folder is a post that can never be retried, and every directory
created there is marked excluded from backup.

### Web

Both plugins have a real web implementation. They used to be six lines of `unavailable()` each, on
the reasoning that a second renderer is a second thing to keep in sync - and that reasoning is why
the web engine is built the way it is rather than why it does not exist. Nothing in
`src/video-composer/web/` decides anything the native engines decide: the plan, the geometry, the
colour matrix and the audio layout are ports of `RenderPlan.kt` and `ColorMatrix.kt`, the spec is
checked with the same refusals as `ComposeSpecParser`, and every one of those is a pure module with
a unit test rather than a shader nobody can assert on.

**A `<video>` element is the decoder, not `VideoDecoder`.** WebCodecs decodes elementary streams, so
using it would mean demuxing whatever container the customer picked - MP4 from an iPhone, WebM from
a screen recorder, MOV, 3GP - before a single frame came out. A `<video>` already holds every
demuxer and decoder the platform has, applies rotation metadata and copes with variable frame rates.
The cost is that it is driven by seeking, which is slower; the benefit is that it is right for every
format the browser can play, and that stepping the output timeline frame by frame makes the render
deterministic - a slow phone produces the same file as a desktop, just later.

**The container is Mediabunny's.** `VideoEncoder` is an encoder, not a muxer, so something has to
write the ISO boxes. That was seven hundred hand-written lines here first, and that was the wrong
call: a container is a large, fiddly, well specified thing somebody else already maintains and tests
against real players. [Mediabunny](https://mediabunny.dev) is zero-dependency, does that one job, and
is the package's only runtime dependency. It is reached exclusively through `src/video-composer/web/`,
which loads behind the lazy `import('./web')` inside `registerPlugin`, so an editor-only host never
pulls it into a bundle. `render.cmp.test.ts` still hands the finished file back to the browser's own
demuxer, because a container only this package can read is not a container.

**There are two engines, and a browser without WebCodecs still renders.** The first is the real one:
Mediabunny over `VideoEncoder`, producing MP4 with H.264 and AAC. The second is `MediaRecorder` over
a canvas stream, for a browser with neither `VideoEncoder` nor an H.264 config it will take. It costs
real time - `MediaRecorder` timestamps by the wall clock, so a thirty-second post takes thirty
seconds - and it lands in whatever container that browser records in, usually WebM, which is why
`capabilities()` reports the container and says when the slow engine is the one in play. Only a
browser with neither gets `supported: false`. Both engines are exercised in the browser suite; the
fallback's test hides WebCodecs to get at it, because otherwise the path that exists for browsers
this suite never runs in would not be tested anywhere.

**Two canvases.** A WebGL2 canvas draws the video, because the one thing a 2D canvas cannot do is the
colour matrix - `ctx.filter` takes CSS filter functions, not a 4x5 matrix. A 2D canvas then puts the
overlays on it, because rotating a bitmap about its centre at an opacity is three lines there. The
matrix is applied to the sampled texel and to nothing else, so a tint or a fade does not colour the
letterbox bars - the same rule, and the same reason, as on the phone.

**Pitch is preserved by hand.** `playbackRate` resamples, so a 2x clip would come back an octave up.
`web/time-stretch.ts` is overlap-add with a correlation search, which is the only way a browser gets
what Media3 and AVFoundation get from the platform.

**The render does not survive the page, and the result does.** A browser has no foreground service
and no WorkManager: a tab closed mid-render stops rendering, and a job left behind comes back as
`interrupted`. But the finished video's bytes and the job record go into IndexedDB as they are
produced, so `getState` after a reload answers with the render rather than with `job_not_found` -
which is more than the native plugins promise, and is the most a browser can honestly offer.

**So the customer is asked before the tab goes.** `web-runtime/leave-guard.ts` holds a `beforeunload`
listener for as long as a render or an upload is in flight, ref-counted so the two can overlap and so
nothing is left asking about a tab with nothing running in it. Two browser rules shape it and both
look like bugs otherwise: the wording is the browser's and a page cannot change it, and nothing is
shown at all unless the customer has interacted with the page - which, after a tap on Next, they
have.

**The publisher stages its files.** Natively an upload names a path in an app-private folder; in a
browser it names a `blob:` URL, which dies with the document. So `publish()` copies the bytes into
IndexedDB before it queues anything, and the record names the copy - otherwise a record that survived
a reload would come back pointing at nothing. Everything else is the native behaviour unchanged: an
upload with an id is never sent again, a file that was mid-flight is looked up by its guid first, the
create step is idempotent on `postId`, and the retry ladder is the same 30/60/120 seconds. A Web Lock
keeps two tabs off one post.

**`capabilities()` is the call that earns its keep here.** It probes rather than guesses -
Mediabunny's codec checks negotiate with the platform's own encoder - and answers with the engine's
real container and codec, so a host knows whether it is getting an MP4 or a WebM before it offers
anything. A browser with no engine at all gets `supported: false` with a sentence saying why, and a
`compose()` that fails with `unsupported` rather than pretending. Every other error keeps its native
code, so a host written against a phone needs no second set of branches.

**Reaching it.** The web implementations load through `registerPlugin`, so a plain web host that
wants them installs `@capacitor/core` - an optional peer, and the same `VideoComposer` object a
Capacitor app uses. The editor itself still needs none of that: `capacitor-video-kit/ui` is the editor,
`capacitor-video-kit` is the plugin, and a host that only edits reaches the first one.

## Saving the finished video to the gallery

A render lands in the app's private storage, where no gallery app can see it and nobody holding
the phone can reach it. `VideoComposer.saveToGallery` is the other end of that:

```ts
const { uri } = await VideoComposer.saveToGallery({
  uri: stitched.sourcePath!,        // what `compose` handed back
  fileName: 'lightsnip-20260922.mp4', // extension included; defaults to the source's own name
  album: 'LightSnip',               // a folder in the directory, and the album a gallery shows
  directory: 'movies',              // or 'dcim'; defaults to 'movies'
});
```

Android inserts into MediaStore under `Movies/<album>`, which needs no permission from API 29 and
survives the app being uninstalled, and answers with the `content://` row. iOS creates a `PHAsset`
from the file as it is - the name handed to PhotoKit with it, rather than put on a second copy a
nearly full phone would fail to write - and answers with `ph://` and the asset's local identifier.
The web hands the file to the browser's own download, ignoring `album` and `directory` because a
page has neither.

`directory` means nothing to the iOS photo library, which has no folders, but it is checked there
all the same: a value other than `movies` or `dcim`, like an album with a `/` or `\` in it, is
refused with `invalid_spec` on both platforms, before the file is looked at, rather than being
accepted on one and refused on the other.

The album is where iOS is least like Android. Finding an album and making one both need READ access
to the photo library, which is more than adding a video needs, so iOS files into one only with full
access, and only when the host's `Info.plist` also declares `NSPhotoLibraryUsageDescription`. When
read access has never been asked about, the first save with an album asks for it, and that one
prompt settles adding as well - which has a price: a person who answers it with Don't Allow may have
refused adding along with reading, and the save is then refused with `permission_denied` where a
prompt for adding alone might have been allowed. With add-only or limited access, or on a host
without the key, the video is saved to Recents and the album is left out with no error, because a
save is not lost over the folder it was to go in. Limited access skips the album on purpose: PhotoKit
does not promise that an album made on an earlier save is visible under it, and a save that could
not see one would make another of the same name every time.

Two traps this exists to avoid, both of which look right and are not: copying into
`getExternalMediaDirs()` puts the video in `Android/media/<package>/`, which Android **deletes when
the app is uninstalled**, and announcing the copy with `ACTION_MEDIA_SCANNER_SCAN_FILE` uses a
broadcast deprecated at API 29 and ignored after it. Either one produces a save that reports
success over a video no gallery ever shows.

On iOS the host's `Info.plist` needs `NSPhotoLibraryAddUsageDescription`, and that is all a plain
save needs; without it the app is terminated when the permission is asked for. Filing into an
`album` needs `NSPhotoLibraryUsageDescription` as well, as above, and without that key the kit never
asks for read access - iOS would terminate the app if it did - and saves to Recents. Android needs
nothing added - the kit's manifest declares the pre-API-29 storage permission, capped so modern
installs do not carry it.

The failures are `invalid_spec` for an option that cannot be honoured, `permission_denied`,
`unreadable_input` for a file that is missing or is not a video, `no_space` for a full disk,
`unsupported` from a browser that cannot download, and `unknown` for whatever else the platform
says. One of those is not yet true everywhere: Android looks for a full disk by the words of the
error rather than by its cause, misses a real `ENOSPC`, and reports it as `unreadable_input`.

## Reading the gallery, for a host that draws its own picker

The system picker answers with a set, so the order somebody tapped their clips in - the order they
want on the timeline - is lost on the way back. A host that numbers its picks, the way phone video
editors do, lists the library itself:

```ts
const { access } = await VideoComposer.requestGalleryAccess(); // 'granted' | 'limited' | 'denied' | 'unsupported'

const { videos, total } = await VideoComposer.listGalleryVideos({ offset: 0, limit: 60 }); // newest first
const { uri: tile } = await VideoComposer.galleryThumbnail({ id: videos[0].id }); // a cached file:// JPEG

// For every pick, before it goes anywhere else in the plugin:
const { uri, fileName } = await VideoComposer.resolveGalleryVideo({ id: videos[0].id });
```

A video's `id` is the library's handle, not a file: `resolveGalleryVideo` is what turns it into one.
On Android that is instant - the MediaStore URI is already readable - and on iOS it copies the asset's
video out of the photo library (from iCloud first when it lives there) into Application Support, so
a draft that stores the path can still open it next week.

The iOS copy is one per version of an item, never one per pick:
`videokit-gallery/<id>/original/<name>` for an item nobody has edited, whatever else happens to it in
Photos - a favourite or a caption does not make another - and `videokit-gallery/<id>/<modification
stamp>/<name>` for an edited one, so an edit made after the first pick is a fresh copy rather than
the old cut served again, and reverting it goes back to the original copy already there. `<name>`
is the name the item was taken under, `IMG_0042.MOV`, never the `FullSizeRender` Photos calls every
edit, so the sound library and a save read a real name off the path. The kit deletes none of them
on its own, because only the host knows whether a draft still points at one: every pick stays on the
phone as a copy until the host lets it go, with `releaseMedia` or `sweepMedia` (**Keeping picked
media**, below). A flat copy made by an earlier version of the kit is hard-linked into its new place
rather than downloaded again, and both paths go on working.

With `images: true`, `listGalleryVideos` lists pictures among the videos, newest first together,
and every item on Android and iOS says which it is in `kind`; a picture's `durationMs` is 0.
`galleryThumbnail` and `resolveGalleryVideo` take a picture's id as they take a video's, and on iOS
the picture is copied in the format it is stored in, a HEIC as a HEIC, for the renderer to decode.
Newest first means the date a file was added on Android and the `creationDate` the Photos app sorts
by on iOS, which has no public key for the date added, so a video downloaded today but shot last year
sits in a different place on each. A thumbnail's `maxSize` is its long edge on both.

`limited` is the person having chosen a few videos rather than all of them; the calls work and list
fewer. `denied` is an answer rather than a rejection, because the fallback - the system picker -
needs no permission. The web answers `unsupported` and refuses the other three.

**The host declares the permission, not the kit.** Google Play reviews media read permissions app by
app, so the kit does not put one on every host that only renders. Android:

```xml
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
```

and `READ_MEDIA_IMAGES` beside `READ_MEDIA_VIDEO` for a host that lists pictures, which
`requestGalleryAccess({ images: true })` then asks for in the same prompt.

iOS: `NSPhotoLibraryUsageDescription` in `Info.plist`, without which the app is terminated when
access is asked for. The one grant covers pictures and videos alike, so `images` changes nothing
about the prompt there.

## Keeping picked media

What a native picker hands over is good for the launch that picked it. A host that keeps picks past
that - drafts that name their clips - has to make each one last, and the two phones break the
promise in opposite ways. Android's photo picker hands over a `content://` URI and a read grant, and
the grant dies with the process: the URI then names a video the app may no longer open. iOS hands
over a file of the app's own, copied into `Library/Caches`, which the system empties by itself when
space runs low, while the app is closed. Either way a draft came back to a clip it could not open and
could not tell from one the customer had deleted. Five calls on `VideoComposer` settle it, with the
same names and shapes on every platform:

| Call | Android | iOS | Web |
|---|---|---|---|
| `retainMedia({ uri })` answers `{ uri, durable }` | takes a persistable read grant, or from Android 12 swaps a photo-picker URI for the MediaStore URI behind it; copies nothing; a name that already lasts (a MediaStore URI, a file in app storage) comes back as it came, `durable: false` | moves a file in Caches or `tmp` to `Application Support/videokit-picked/<uuid>.<ext>`, a rename rather than a copy; a file elsewhere in the app's container answers itself | the URI, `durable: false` |
| `checkMedia({ uri })` answers `{ exists, uri }` | opens a read descriptor; `uri` as given | reads the file, after moving a path into an old container onto the current one, and answers with that path | `exists: true` |
| `requestMediaAccess({ images })` answers `{ granted }` | `READ_MEDIA_VIDEO`, and `READ_MEDIA_IMAGES` with `images`, from 13; `READ_EXTERNAL_STORAGE` below | granted, without a prompt | granted |
| `releaseMedia({ uris, keep })` | nothing | deletes the kit's own copies among `uris`, except any `keep` also names | nothing |
| `sweepMedia({ keep, before })` answers `{ removed }` | 0 | deletes every copy of the kit's own that no URI in `keep` names and that was made before `before` | 0 |

`retainMedia` rejects only when there is no `uri`: every other way it can fail answers with the URI
as it came and `durable: false`, because that URI still opens for the rest of the launch. False is
not a reason to refuse the pick; for a picker's own name it is the truth a draft store needs, that
this clip will be missing on a later launch. On Android it says what retaining did rather than
whether the name lasts, so a name that needed no help - a `resolveGalleryVideo` answer, which is a
MediaStore URI, or a file in the app's own storage - is `durable: false` there too, and iOS says true
for its counterpart. `requestMediaAccess` never rejects for a refusal either, and the permissions it
asks for are the ones **Reading the gallery** has the host declare. The two that delete are the ones
strict about their arguments, on every platform alike: an absent `uris`, a sweep's absent `keep` or
`before`, and a release's `keep` that is there but not a list are refused with `invalid_spec` rather
than given a default, because a `keep` read as empty would delete every copy a draft still uses and
`before` read as now would take a clip being picked that moment. A release's `keep` may be left out,
and then every copy `uris` names goes, as it did before `keep` existed.

The kit's own copies on iOS are the ones `retainMedia` moves into `videokit-picked/` and the ones
`resolveGalleryVideo` copies into `videokit-gallery/`, both under Application Support, which nothing
else ever empties. `releaseMedia` and `sweepMedia` match a URI to a copy by its path under
Application Support rather than by the whole path, because the whole path names the install's
container folder, `.../Containers/Data/Application/<UUID>/`, and iOS gives an app a new one when it is
updated or restored and carries every file across. A name a draft stored before an update therefore
names a folder that no longer exists, while its file sits in the new one under the same name. That
is also what `checkMedia` answers for, and `currentMediaUri(uri)`, from `capacitor-video-kit`, asks it
only when it has to: on iOS, for a path with a container in it. Every other path comes back as it went
in without a bridge call, and a call that fails answers the path as it came. A URL Capacitor's local
server plays a file by (what `Capacitor.convertFileSrc` answers) names the container too, and comes
back moved the same way, still that URL, for a host that stored one, such as a poster.

A list of names to KEEP - `sweepMedia`'s `keep`, and `releaseMedia`'s - is read in every form a host
is likely to have stored a copy's name in: a `file://` URI, percent-encoded as the kit hands one out
or written literally, also as `file://localhost/...` or `file:/...`; a bare absolute path; either one
into an earlier install's container; the local server's URL for the copy, under whatever scheme and
host the app configured; a path relative to Application Support, `videokit-picked/<name>` or
`videokit-gallery/<id>/...`; and any of these with a query or a fragment after it. A name read more
ways than it meant can only keep more, which is the side to err on when a misreading loses a clip for
good. `releaseMedia`'s `uris`, the names to DELETE, are read as file names only, a `file://` URI or a
bare path moved onto this install's container, because a name misread there costs only some space
until the next sweep. So a copy `uris` names by its path and `keep` by the URL the web view plays it
by is one copy, and stays. The file's own path is the better thing to store and convert on the way
out: it is the one form both lists read, and the URL's front is the app's configuration, which a
later version is free to change.

Two kinds of copy survive a sweep whatever `keep` says and however old they are. One is a copy this
process has handed a host - moved in by `retainMedia` or answered by `resolveGalleryVideo` since the
app started, which a web view reload does not restart - so a clip picked while the host gathers
`keep`, or earlier in the launch and not saved yet, is safe; `before` alone could not promise that,
because a gallery copy made in an earlier launch is dated then however recently it was picked again.
The other is an input of a render still running, or of one whose outcome JS has not collected,
because a host runs its sweep as its page starts, so the sweep runs again when the web view reloads,
which can happen mid render, and the edit being rendered may be in no draft. `releaseMedia` does delete a copy handed out in this launch: that is the host saying it is
done with it.

A host with drafts uses the five like this, and **Native hosts**, below, is the same glue with the
helpers that wrap it:

```ts
import { Capacitor } from '@capacitor/core';
import { VideoComposer, currentMediaUri } from 'capacitor-video-kit';

// Every file a system picker hands over that a draft may keep, before anything is written down
// (a `resolveGalleryVideo` answer already lasts). Store the answer, and play it through the local
// server: on iOS the picker's own webPath names where the file was.
const { uri, durable } = await VideoComposer.retainMedia({ uri: picked.path });
source.sourcePath = uri;
source.playbackUrl = Capacitor.convertFileSrc(uri);
void VideoComposer.requestMediaAccess({ images: picked.isPicture }).catch(() => undefined);

// A draft read back: every stored path, as this install has to open it, before it is converted.
const path = await currentMediaUri(stored.sourcePath);
const { exists } = await VideoComposer.checkMedia({ uri: path }); // before calling the clip missing

// A draft deleted: what it named, and what every draft still kept names. Two drafts can share one
// pick, and the kit keeps whatever both lists name.
await VideoComposer.releaseMedia({ uris: pathsIn(deleted), keep: pathsIn(remaining) });

// Once per launch: every media path any draft names. `before` spares a clip picked while this runs.
const startedAt = Date.now();
await VideoComposer.sweepMedia({ keep: await everyPathInEveryDraft(), before: startedAt });
```

The sweep is what makes the rest affordable. Most copies stop mattering without anybody saying so:
a clip deleted from the edit, a Replace, a video Extract from video only read the sound out of, an
edit left without a draft, a draft whose app was killed before it saved. What the drafts name is the
whole of what a copy can still be for, so whatever else is in the two folders goes. A host that also
draws its own gallery puts the `resolveGalleryVideo` paths its drafts use in `keep`, since those copies
are swept too.

A browser keeps none of this: a pick there is a `blob:` URL that dies with the page, which is what
`durable: false` says, and a draft keeps the bytes instead. The pick itself, for the step before the
editor - a new project, a template's slots - is `pickMediaFiles({ limit, pictures })` from
`capacitor-video-kit/ui`: the browser's own file input asked for several files at once, answering
each with its source and its length in milliseconds, a picture as `kind: 'image'` with a length of
0, and a cancel as an empty array. The object URLs it mints are the caller's to revoke.

## Native hosts

A Capacitor app with drafts was writing the same glue around the calls above whatever it edited:
turning a pick into a source that lasts, turning a gallery item into one, giving the engine files
rather than blobs, and letting go of copies nothing uses. That glue is in `capacitor-video-kit`, so
what is left in the app is its picker plugin, its keys and its drafts. The whole of it:

```ts
import {
  VideoComposer,
  composerRenderHost,
  gallerySource,
  retainPickedFile,
} from 'capacitor-video-kit';
import { browserMediaHost, type EditorMediaHost, type EditorSource } from 'capacitor-video-kit/ui';

// A system picker's file as a source a draft can keep. Every Capacitor picker plugin answers a
// `path` and a `webPath`, and a file picker its `mimeType`; this retains the first and answers what
// to store and what to play. A picture has to say so, or the editor opens it as a video and reports
// it missing, and Android asks for pictures as a right of their own.
async function sourceFor(file: { name: string; mimeType?: string; path?: string; webPath?: string }): Promise<EditorSource> {
  const picture = file.mimeType?.startsWith('image/') === true;
  void VideoComposer.requestMediaAccess({ images: picture }).catch(() => undefined); // to read it later
  const { sourcePath, playbackUrl } = await retainPickedFile(file);
  return { key: crypto.randomUUID(), fileName: file.name, sourcePath, playbackUrl, ...(picture ? { kind: 'image' } : {}) };
}

// An item from the app's own gallery (`listGalleryVideos`), resolved into a source. A picture says so.
const source = await gallerySource(video, crypto.randomUUID());

// The editor's media host: the defaults, with the clip pickers replaced. `pickAudio` stays the
// default, which on iOS is already the kit's own document picker, so there is no audio picker to write.
const media: EditorMediaHost = {
  ...browserMediaHost(),
  async pickVideo() {
    const file = await pickOneVideo(); // the app's picker plugin, null on a cancel
    return file ? sourceFor(file) : null;
  },
  async pickMedia() {
    const file = await pickOneVideoOrPicture(); // with editing.pictures on: the same, offering stills
    return file ? sourceFor(file) : null;
  },
  // ...probeDuration, thumbnails and the rest over VideoComposer, as above
};

// The render: every blob the spec names staged as a file, and released once the job has settled.
const render = composerRenderHost();

// A draft deleted: what it named, less whatever the drafts still kept name.
await VideoComposer.releaseMedia({ uris: pathsIn(deleted), keep: pathsIn(remaining) });

// Once per launch, with every media path any draft names.
const startedAt = Date.now();
await VideoComposer.sweepMedia({ keep: pathsIn(await allDrafts()), before: startedAt });
```

**`retainPickedFile({ path, webPath })`** answers `{ sourcePath, playbackUrl, durable }`. It calls
`retainMedia` when there is a `path` and never throws: a picker that worked must not be undone by the
step that was only ever about tomorrow, so a call that fails answers the path as it came, `durable:
false`, which opens for the rest of the launch. `playbackUrl` is the picker's `webPath`, except after
iOS MOVED the file out of Caches, when the picker's URL names where the file was and the new name
through `Capacitor.convertFileSrc` is what plays. Android's new name is another name for the same
bytes, and the picker's URL goes on playing them.

**`gallerySource(video, key)`** resolves a listed item with `resolveGalleryVideo` and answers the
`EditorSource` the editor opens: the resolved name, or the listing's where the resolve found none,
the resolved URI as `sourcePath` and through `convertFileSrc` as `playbackUrl`, and `kind: 'image'`
for a picture, without which the editor opens a picture as a video and reports it missing. It
rejects as the resolve does, `unreadable_input` for an item gone from the library since it was
listed. The key is the app's, new for every pick, because the same item picked twice is two clips.

**`composerRenderHost(options?)`** is the editor's render host over the composer, and **A Capacitor
app, where the native engines do the rendering** has its options and what it does. The host it
answers always has `encodeSupport`, typed as required, so a host that wraps it calls it straight
through with no fallback of its own.

**`readRenderFile(uri, name = 'edited')`** is the finished render as a `File`, for a `toSource` that
sends it somewhere: read through `webViewUrl`, named `<name>.mp4`, or `.webm` for a browser's WebM,
and typed as its bytes came or `video/mp4` where they came with none. It takes the iOS local server's
answer for a whole file, which has no HTTP status and so is not `ok`, as the file it is, and rejects
with a plain `Error` - an HTTP error, a failed fetch, a file of no bytes - which fails the render as
`unknown` with the reason logged, rather than handing an upload an empty `File`. **`containerOf(type)`**
is its naming on its own: `webm` for a MIME type that says WebM, `mp4` for anything else, no type
included, since every native render is MP4.

**`webViewUrl(uri)`** is the URL the WebView loads a file by: a `file://`, a `content://` or a bare
path through `Capacitor.convertFileSrc`, and an `http(s):`, `blob:` or `data:` URL as it came. It is
already the editor's default `platform.fileUrl`, so it is for everything else a host shows: a done
screen's render, a poster. It reads `window.Capacitor`, which is the `Capacitor` `@capacitor/core`
exports, so a test's spy on `Capacitor.convertFileSrc` is the one it calls.

**`withNativeRenderInputs(spec, render, signal?)`**, which `composerRenderHost` runs every render
through and a host with a render of its own calls itself, gives the engine files instead of the
`blob:` URLs a page holds - a sound from the browser's sound library, a track the default picker
read in - which no native engine can open. Every place a spec names media is covered: the base
clips, every layer's clips, each transition's outgoing side, the music and every voiceover. Each
distinct blob is staged through `stageRenderInput` a mebibyte of bytes per call, named with the
extension its type calls for (a better default rather than a requirement, since iOS's
`RenderInputs` and Android's Media3 both read what a file holds), and released through
`releaseRenderInputs` once `render` has settled, whatever it settled with. The caller's spec is not
touched. An input it cannot stage rejects with a **`RenderInputError`**, also from the root, before
`render` is called: `code` is `unreadable_input` for a blob that will not read, with `clipKey` the
wire key of the clip that named it (none for a sound), `no_space` for a write a full disk refused,
and `unknown` for any other; an abort rejects with the signal's reason. In a browser it is
`render(spec)` and nothing else.

**The editor's default `pickAudio`** is the kit's document picker on iOS (**iOS host setup** says
why), so a native host keeps it by spreading `browserMediaHost()` and leaving `pickAudio` out.

The three native calls behind those, for a host that needs them on their own:

| Call | Android | iOS | Web |
|---|---|---|---|
| `pickAudioFile()` answers `{ cancelled, uri?, fileName?, mimeType? }` | rejects `UNIMPLEMENTED` | presents the document picker for any audio type, opens the choice in place and copies it to `tmp/videokit-audio/<uuid>.<ext>`, after downloading it first when it is still in iCloud, with no progress or cancel; the copy is deleted by the next pick or the plugin's next load, whichever comes first; rejects `already_picking` while its picker is open or on its way up | rejects `UNIMPLEMENTED` |
| `stageRenderInput({ data, uri?, extension? })` answers `{ uri }` | writes or appends to a file in `cacheDir/videokit-render-inputs/` | writes or appends to a file in `tmp/videokit-render-inputs/` | rejects `UNIMPLEMENTED` |
| `releaseRenderInputs({ uris })` | deletes the named files in that folder, and nothing else | the same | rejects `UNIMPLEMENTED` |

`stageRenderInput` starts a new file, named `<uuid>` and `extension` after a dot, when `uri` is
absent, and appends to the file `uri` names otherwise. It refuses with `invalid_spec` a `uri` that is
not a staged file still there, data that is not base64 and an extension that is not one to sixteen
letters and digits, and answers `no_space` for a full disk. Chunks are written one at a time in the
order they were sent, on both platforms. `withNativeRenderInputs` releases what it staged the moment
the render has settled. A staged file nobody released - its app killed mid render, or its page
reloaded before the render settled - is deleted when the plugin next loads, once it is a day old.
The plugin loads once per bridge, before the bridge loads its page, and a web view reload does not
load it again, since a reload only resets the bridge; in an app with one bridge that is once a
launch, so a leftover goes on the first launch a day or more after it was written, and iOS may empty
`tmp` sooner while the app is not running. Not sooner than a day, because a bridge can be built
again in a process whose render is still reading its inputs - on Android, an Activity made again
while the render's foreground service keeps the process.

## Failure codes

Composer: `unreadable_input` (blame `clipKey`), `encoder`, `muxer`, `interrupted`, `cancelled`,
`no_space` (carries `needBytes`), `too_large`, `unsupported`, `unknown`. `interrupted` is the
platform stopping a render with nothing wrong with the post - on iOS, the app leaving the
foreground - and the same spec composed again under a new `jobId` can succeed. `too_large` is a file
that grew past the spec's `output.maxBytes` and was deleted, with the message
`too_large max=<maxBytes> bytes=<bytes>` on every engine; the same spec fails the same way. `bytes`
can read under `max`: on iOS a render that fell back to the preset export session, which is handed
the ceiling as its `fileLengthLimit`, may come back cut short at it, and fails `too_large` with the
size it stopped at. The code is the answer and the numbers are for the log.
`unknown` with the message `timeout` is an iOS render that stopped moving for 90 seconds.

`saveToGallery`: `invalid_spec`, `permission_denied`, `unreadable_input`, `no_space`, `unsupported`
(web only), `unknown`.

Publisher: `network`, `http`, `auth`, `server_rejected`, `file_missing`, `cancelled`, `unknown` - each with `phase`, an optional `httpStatus`, and `retryable`.

## Build and test

```sh
npm install        # `prepare` builds the package, so a linked host has something to resolve
npm run build      # the package, then the three wrapper packages
npm test           # vitest in a mock DOM, and Playwright Chromium for the components, both web
                   # render engines, and the file each of them produces
npm run typecheck  # the plugin, its own tests, the editor, the MCP server, the build helpers
                   # and the wrappers
npm run build:mcp  # only the MCP server, which a normal build skips unless its SDK is installed
npm run clean      # every output of this package; `clean:all` takes the wrappers with it
```

`npm run build` is `build:package` and then `build:wrappers`. `build:package` is the whole of what
is published from here and is what `prepare` runs: clean, the plugin's two `tsc` passes,
`finish-build.mjs`, `stencil build`, `build-mcp.mjs`, and `module-type.mjs` last so that it checks
the finished tree. `build-mcp.mjs` is the one step that can decide to do nothing, and **The MCP
server** above says when and why.

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


