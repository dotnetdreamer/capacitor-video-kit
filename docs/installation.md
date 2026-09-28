# Installation

[Documentation](README.md) / [Project overview](../README.md)

- [Install](#install)
- [iOS deployment target](#ios-deployment-target)
- [iOS host setup](#ios-host-setup)
- [Entry points](#entry-points)

## Install

The package is private and unpublished. Build a checkout, then install it through a local path or a tarball.

From the repository root, install the build dependencies and build all entry points:

```sh
npm install --ignore-scripts
npm --prefix packages/angular install --ignore-scripts
npm run build
```

The Angular wrapper has its own dependency installation; the root workspaces cover React and Vue.
Skipping install scripts here lets all build dependencies finish installing before `prepare` would run the build.

A sibling checkout, which is what the applications built on this package use:

```jsonc
// package.json in the host app
"capacitor-video-kit": "file:../../capacitor-video-kit"
```

After building this repository, run `npm install` and `npx cap sync` in the host app. The host needs nothing in its `tsconfig.json`: this
package is resolved through `node_modules` and its exports map like any other dependency.

It does need every bundler it runs to **keep the symlink**, which for an Angular host means
`"preserveSymlinks": true` on the `build` target and on the `test` target, and for Vite means setting
`resolve.preserveSymlinks: true`. A tool that resolves the real path instead looks for this
package's own dependencies next to this checkout rather than next to the app, and
`@capacitor/core` is the one it will not find: the error names a path inside this repository, which
reads like a fault here and is not one.

Or a tarball, which is what an app that is not next to this checkout gets and the only way to see
what a published install would actually contain:

```sh
npm pack                                      # in this repository: capacitor-video-kit-1.3.0.tgz
npm install ../path/to/capacitor-video-kit-1.3.0.tgz && npx cap sync   # in the host app
```

Either way the host is on the hook for the [iOS deployment target](#ios-deployment-target), and for `@capacitor/core`,
which is an optional peer dependency and is not installed for you.

One npm package registers both plugin classes: the Capacitor CLI scans every `.kt` under
`android/src/main` and emits an entry per `@CapacitorPlugin` it finds.

Gradle versions come from the host's `android/variables.gradle` (`kotlin_version`, `media3Version`,
`workManagerVersion`, `okhttpVersion`, `kotlinxCoroutinesVersion`), with the plugin's own pins as a
fallback.

## iOS deployment target

`Package.swift` and `CapacitorVideoKit.podspec` both declare iOS 16, and both iOS templates
`@capacitor/cli` 8.5.0 unpacks, the SwiftPM one and the CocoaPods one, set
`IPHONEOS_DEPLOYMENT_TARGET = 15.0` in all four build configurations, the CocoaPods one adding
`platform :ios, '15.0'` to the Podfile as well. So a stock app stops on its first build until that
deployment target is raised. Where it stops depends on the
package manager, and neither message names the line to change.

**SwiftPM resolves the graph and then refuses to plan the build.** `xcodebuild` fetches
`capacitor-swift-pm`, lists `CapacitorVideoKit` under `Resolved source packages`, and fails before the
first `SwiftCompile`:

```
error: The package product 'CapacitorVideoKit' requires minimum platform version 16.0 for the iOS
platform, but this target supports 15.0 (in target 'CapApp-SPM' from project 'CapApp-SPM')
```

`CapApp-SPM` is the package `npx cap sync ios` generates, so the one file the message names is the
one file an edit does not survive.

**CocoaPods stops earlier, at dependency analysis**, and names the pod rather than the platform:

```
[!] CocoaPods could not find compatible versions for pod "CapacitorVideoKit":
  In Podfile:
    CapacitorVideoKit (from `../../node_modules/capacitor-video-kit`)

Specs satisfying the `CapacitorVideoKit (from `../../node_modules/capacitor-video-kit`)` dependency were
found, but they required a higher minimum deployment target.
```

Two files carry the deployment target on a SwiftPM host and only one of them is worth editing:

1. `ios/App/App.xcodeproj/project.pbxproj`: set **every** `IPHONEOS_DEPLOYMENT_TARGET` in it to
   `16.0` or higher. Xcode's target editor changes the target's copy and leaves the project level
   one behind, so check the file rather than the inspector.
2. `ios/App/CapApp-SPM/Package.swift`: `platforms: [.iOS(.v16)]`.

The second file is generated, says so on its third line, and `npx cap sync ios` writes it again
every time from the **first** `IPHONEOS_DEPLOYMENT_TARGET` string in the pbxproj, of which it reads
exactly two characters (`getMajoriOSVersion` in `@capacitor/cli`). So an edit made only there is
undone on the next sync without a word, and a pbxproj that still holds a `15.0` above the ones you
changed undoes it just as quietly. Edit the pbxproj properly and the generated file looks after
itself: this app's is 18 and every sync writes `.v18` back.

A CocoaPods host edits the pbxproj the same way and `ios/App/Podfile` as well, to
`platform :ios, '16.0'`. That edit stays where it is put: `npx cap sync ios` rewrites the
`def capacitor_pods` block and the `require_relative` line of a Podfile and leaves every other line
alone. Editing only the Podfile is the trap, because nothing fails. `pod install` succeeds, the app
builds, and all that stands between the developer and an app that claims an iOS it cannot run on is
a linker warning:

```
ld: warning: building for iOS-15.0, but linking with dylib
'@rpath/CapacitorVideoKit.framework/CapacitorVideoKit' which was built for newer version 16.0
```

**Why 16 and not the 18 this package declared until it was measured.** `AVAssetExportSession`'s
`export(to:as:)` was the reason given for 18 and is not one: the SDK declares it available from
iOS 13 and back deploys the body, so it never held a floor anywhere. The two calls that genuinely
sit above 16 now have a second path beside them, chosen by `#available`: progress comes from
`states(updateInterval:)` on 18 and from the session's own `progress` below it, and the record
permission comes from `AVAudioApplication` on 17 and from `AVAudioSession` below it.

**Why not 15, which would need nothing of the host at all.** What holds the floor at 16 is
`AVAssetImageGenerator.image(at:)` and `images(for:)` in `Thumbnailer.swift`, and the pre 16
spelling of the second one is a completion handler called once per frame that would have to be
bridged back into an `AsyncSequence` by hand. That is a rewrite of the filmstrip rather than a
guard around it, on a path nothing here can run, and it is not worth one version. Below 15 it is
not close: `AVAsset.load(_:)` and `loadTracks(withMediaType:)` are iOS 15 and are used in ten
places across the two files that build a composition.

## iOS host setup

Everything an iOS host adds by hand, in one place. Little of it is optional where it applies,
because the way iOS reports a missing usage string is not a failed call but an app terminated at
the moment the call asks.

**The deployment target is iOS 16.** Follow [iOS deployment target](#ios-deployment-target), including which host files to edit before running sync.

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
| `NSMicrophoneUsageDescription` | `startVoiceRecording`, which `composerMediaHost` calls for the voiceover sheet unless it is given `voice: false` | the app is terminated when the first take starts |
| `NSCameraUsageDescription` | no call of the kit's: the editor's default pickers, which are `<input type="file">` elements, and a WKWebView offers the camera from every one that takes images or video | the app is terminated when somebody taps Take Photo or Video |

A host that only saves needs only the first key. Filing into an album is what the second is for on
such a host, and [Saving the finished video to the gallery](media.md#saving-the-finished-video-to-the-gallery) says what happens without it.

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
default: leave `pickAudio` out of `composerMediaHost`'s pickers ([Native media host](editor.md#native-media-host)), or out of a
media host of its own spread from `browserMediaHost()`. No file picker plugin is needed for sounds.

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

## Entry points

Every consumer resolves the built package through its exports map, and every entry below has been
resolved, loaded and type checked out of an `npm pack` tarball installed into a scratch directory.

| Specifier | What it is | Needs |
|---|---|---|
| `capacitor-video-kit` | Both plugin proxies, their definitions, the edit contract, the editor's render and media hosts over the composer (`composerRenderHost`, `composerMediaHost`, `probeMediaDuration`), `describeMedia` ([Reading what footage shows](media.md#reading-what-footage-shows)) and the glue a native host needs around them ([Native hosts](native-hosts.md#native-hosts)) | `@capacitor/core` |
| `capacitor-video-kit/editor` | The edit contract on its own, and the scenes `labelMedia`'s labels are read into (`MEDIA_SCENES`, `scenesFromLabels`, `mergeScenes`), reaching no `registerPlugin` call and no Capacitor at all | nothing |
| `capacitor-video-kit/ui` | The editor's public surface that is not a component: the host interface, the store, the catalogues, `setEditorAssetPath`, and the host helpers that call no plugin (`readFileBlob`, `readVoiceTake`, `filePickerCancelled`) | `@preact/signals-core` |
| `capacitor-video-kit/loader` | `defineCustomElements()`, which registers every component at once | `@preact/signals-core` |
| `capacitor-video-kit/dist/components/<tag>.js` | One component's `defineCustomElement()`, for a host that tree shakes | `@preact/signals-core` |
| `capacitor-video-kit/assets/*` | The 34 stickers and the 32 fonts, for a build step that copies them | nothing |

Both packages that column names are **optional** peer dependencies, and so is `@stencil/core`,
which the emitted component declarations name. Optional is not laziness: no consumer wants all
three. A Capacitor app that never renders the web editor would otherwise install 22 MB of Stencil
and a signals library it never loads, and a React host that will never run natively would otherwise
install a native bridge. The framework bindings are subpath imports of this package, not separate installs. A host that
renders the editor installs `@preact/signals-core` and its chosen framework, plus `@stencil/core`
if it type checks against the component declarations.

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
never render a component: npm does not install it, `npm ls` is clean with it absent, and editor
hosts install it explicitly when they need the component declarations.

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
