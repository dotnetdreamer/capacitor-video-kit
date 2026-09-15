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
// package.json
"choisy-video-kit": "file:capacitor-plugins/video-kit"
// tsconfig.json — consumed from source, so a contract change is a type error immediately
"paths": { "choisy-video-kit": ["./capacitor-plugins/video-kit/src/index.ts"] }
```

`npm install && npx cap sync android`. One npm package registers both plugin classes: the Capacitor
CLI scans every `.kt` under `android/src/main` and emits an entry per `@CapacitorPlugin` it finds.

Gradle versions come from the host's `android/variables.gradle` (`kotlin_version`, `media3Version`,
`workManagerVersion`, `okhttpVersion`, `kotlinxCoroutinesVersion`), with the plugin's own pins as a
fallback.

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

Full contracts: `src/video-composer/definitions.ts` and `src/post-publisher/definitions.ts`.

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

```powershell
cd choisy-mobile/android
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
