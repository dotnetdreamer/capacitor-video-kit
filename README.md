# choisy-video-kit

Two Capacitor plugins in one package, both **fully native**:

- **`VideoComposer`** — edits and encodes video on the device: concat, trim, speed, colour, bitmap
  overlays, music and voiceovers. Nothing is rendered in the WebView and no media bytes cross the
  bridge.
- **`PostPublisher`** — uploads the result and creates a post in a way that survives the app being
  backgrounded, swiped away or killed for memory.

They ship together because they are always used together and two installs for one feature is a
worse wart than an unused dependency. They stay two plugin *classes* because they share nothing at
runtime but a file path — the composer writes the video, the publisher uploads whatever path it is
handed.

| Platform | Composer | Publisher | Status |
|---|---|---|---|
| Android | Media3 Transformer 1.11.x | WorkManager + OkHttp | implemented, verified on device |
| iOS | AVFoundation | background `URLSession` | stub — calls reject `unimplemented` |
| Web | — | — | stub — `capabilities()` answers `supported: false` |

## Install

```jsonc
// package.json. Until this is published, a path to the sibling checkout
"choisy-video-kit": "file:../../choisy-video-kit"
```

`npm install` in this repository first, whose `prepare` script leaves a built `dist/` behind, then
`npm install && npx cap sync` in the host app. The host needs nothing in its `tsconfig.json`: this
package is resolved through `node_modules` and its exports map like any other dependency.

One npm package registers both plugin classes: the Capacitor CLI scans every `.kt` under
`android/src/main` and emits an entry per `@CapacitorPlugin` it finds.

Gradle versions come from the host's `android/variables.gradle` (`kotlin_version`, `media3Version`,
`workManagerVersion`, `okhttpVersion`, `kotlinxCoroutinesVersion`), with the plugin's own pins as a
fallback.

### Entry points

Every consumer, the Choisy app included, resolves the built package through its exports map, and
there are exactly two ways in.

| Specifier | What it is |
|---|---|
| `choisy-video-kit` | Both plugin proxies, their definitions and the editor core. Needs `@capacitor/core` installed |
| `choisy-video-kit/editor` | The editor core on its own, reaching no `registerPlugin` call and no Capacitor at all |

The root specifier imports `@capacitor/core` statically, so in a tree without it the import does not
resolve: Node says `ERR_MODULE_NOT_FOUND: @capacitor/core` and a bundler says the same in its own
words, and neither message names this package. Nothing in here can improve on that, because a static
import fails while the module graph is being linked, before any of this package's code runs; the
only way to catch it would be to make `VideoComposer` a promise, which is a worse package than a
documented requirement. So it is documented, here and in `src/index.ts`: **if you are not in a
Capacitor app, import `choisy-video-kit/editor`.**

Both resolve under Node ESM, under Vite and under TypeScript's `bundler`, `node16` and `nodenext`
resolution, and both carry declarations. Nothing else is reachable: `choisy-video-kit/src/...` is not
an entry point, and Node answers it with `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than handing out raw
TypeScript that only this repository's toolchain can compile.

`@capacitor/core` is an optional peer dependency for the same reason. A Capacitor app always has it
and nothing changes there, but npm installs a non-optional peer for every consumer, so left
mandatory it put a native bridge into the `node_modules` of every web host that only ever reaches
`choisy-video-kit/editor`.

`choisy-video-kit/editor` reaches no Capacitor type either, and that is what
`src/video-composer/plugin.ts` exists for. The editor names `ComposeSpec` and `FilterOp`, which live
in `src/video-composer/definitions.ts`, so that file is part of the subpath's declarations; the
`VideoComposerPlugin` interface is the only thing in the composer's contract that names
`PluginListenerHandle`, so it sits in its own file instead. Left where it was, a single `import type`
became `TS2307: Cannot find module '@capacitor/core'` inside the `node_modules` of every web host
that compiles without `skipLibCheck`. The package's public surface is unchanged: `plugin.ts` is
re-exported from `src/video-composer/index.ts` and from `src/index.ts`, so `VideoComposerPlugin` is
imported from `choisy-video-kit` exactly as before.

### What `npm pack` carries

`files` is `dist/` and nothing else, so a packed tarball is the JavaScript half only: no `src/`, no
`android/`, no `ios/`, no `Package.swift`.

Neither consumer loses anything by that, because neither reaches this package through a tarball.
The app installs it as `file:../../choisy-video-kit`, which npm resolves to a **symlink** at
`node_modules/choisy-video-kit` pointing back into this repository, and `files` has no say over what
is visible through a symlink: `npx cap sync` reads `android/` and `ios/` straight out of the working
tree, while the app's TypeScript reads `dist/` through the exports map. The other consumer is `@choisy/video-editor`, which vendors
`npm pack` of this package and bundles it into its own tarball; that reaches `choisy-video-kit/editor`
and nothing native, and before this narrowing it shipped 900 kB of Kotlin, Swift and TypeScript
source into every React, Vue and Angular application that installed the editor.

The consequence to know about: a tarball of this package is **not installable by a native app**, so
this is the one thing standing between here and an `npm publish` that a host could actually install.
When that day comes, put `android/src/main/`, `android/build.gradle`, `ios/Sources` and
`Package.swift` back into `files` and give the editor a web-only tarball instead.

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
| `reconcileManifest` | Brings a saved edit back in line with a clip list that changed meanwhile. Clips are referred to by the host's own keys — the core never needs to know the host's clip shape. |
| `toComposeSpec` | The one translation from an edit to a render. Rasterises text at output scale, computes the bitrate. |
| `FILTER_PRESETS`, `cssFor`, `filterPreset` | CSS Filter Effects maths shared by the live preview and the native colour matrix. |
| `videoBitrateFor`, `totalDurationMs`, `isUntouched` | Output policy: stay under the upload cap; skip the encode for one untouched clip. |
| `rasteriseText`, `rasteriseArrow` | Canvas → PNG at output pixel scale, the caller's half of the overlay contract. |

There is deliberately no UI here. An editor screen belongs to the host and its framework; this
package holds only what an editor needs in order to agree with the native render. Choisy's Angular
editor lives in the app at `src/app/modules/video-editor/`.

A host that wants only the editing half imports `choisy-video-kit/editor` instead. Nothing on that
path registers a plugin or imports `@capacitor/core` at runtime, so a web build that will never run
natively carries no Capacitor code: Vite tree-shakes an import of one constant from it down to
0.11 kB. `@choisy/video-editor`, the web components port of the editor screen, is its first consumer.

## The parts worth knowing about

### Composer

**A render outlives the screen that started it.** `compose()` resolves immediately and never holds a
`PluginCall` open. Results live in a process-wide registry, not in the plugin instance, because the
system may destroy the Activity while the render continues — a retained event on a dead Bridge
reaches nobody. A fresh instance replays whatever has not been acknowledged; `getState` is the
direct question; a `job_not_found` rejection means the process itself restarted.

**A foreground service keeps the encoder running.** `mediaProcessing` on API 35+, `dataSync` on 34,
untyped below. On API 35+ `startForeground` is called on the framework directly rather than through
`ServiceCompat`, whose type mask predates `mediaProcessing` and would reduce it to "no type" —
which a modern target rejects outright, leaving the render unprotected on exactly the devices that
need it most.

**Colour is CSS maths, folded into one matrix**, applied in a single gamma-space fragment pass. That
is what makes the native render and a browser preview agree by construction. The one known deviation
is documented in `ColorMatrix.kt`.

**Progress comes from frame timestamps, not `Transformer.getProgress`.** With music or a voiceover
in the composition, Transformer averages the progress of every sequence, and an audio sequence that
finished seconds ago keeps reporting 99 % — so the average reads 55 % while the video is at 10 %.
The colour pass already sees each frame's output-timeline timestamp, so that is what is published.

**Overlay bitmaps belong to the job, not to the shader chain.** Media3 rebuilds its shader programs
whenever it registers a new input stream — once per clip in a multi-clip sequence — and rebuilding
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
has to understand the post's schema — which matters for something that may run from a persisted
record days later. Plain string replacement, never a regex: the body carries customer-written text.

**Nothing is uploaded twice.** An id survives cancels and retries, and a file that was mid-flight
when the process died is looked up by its guid first. `publish()` on a post already in flight is a
no-op; the create step is idempotent on `postId`.

**Two workers, not one**, so a 503 on the create call retries only the create call.

**Retryable and not-retryable are different answers.** A network drop backs off silently (the caller
shows "waiting for connection"); a 401 stops at once and is retryable only once a fresh token
arrives; a 400 or a missing file is final.

**Progress is bytes, not files**, capped at 95 until the post actually exists.

## Failure codes

Composer: `unreadable_input` (blame `clipKey`), `encoder`, `muxer`, `interrupted`, `cancelled`,
`no_space` (carries `needBytes`), `unsupported`, `unknown`.

Publisher: `network`, `http`, `auth`, `server_rejected`, `file_missing`, `cancelled`, `unknown` —
each with `phase`, an optional `httpStatus`, and `retryable`.

## Build and test

The web half:

```sh
npm run build      # dist/esm and dist/cjs, each with declarations and a module-type marker
npm run typecheck
```

The sources keep extensionless relative imports because the app's Karma build resolves them through
webpack, which will not map a `./thing.js` specifier back to `./thing.ts`. `scripts/finish-build.mjs`
adds the extensions to the emitted ESM afterwards, where Node is the one that needs them.

The native half:

The plugin is a Capacitor Android library, so it is built through a host app rather than on its
own: the Gradle wrapper, the SDK location and `variables.gradle` all live there.

```powershell
cd <host app>/android
$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat :choisy-video-kit:compileDebugKotlin :choisy-video-kit:testDebugUnitTest
```

82 JVM tests cover the parts that fail silently: the colour matrices against the CSS spec, the
timeline arithmetic (speed, clamping, music repetitions, voiceover gaps, overlay coordinates), the
parsers' reject-versus-clamp boundary, the multipart wire format and the template substitution.

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
