# Platform behavior

[Documentation](README.md) / [Project overview](../README.md)

- [iOS](#ios)
- [Web](#web)

| Platform | Composer | Publisher | Status |
|---|---|---|---|
| Android | Media3 Transformer 1.11.x | WorkManager + OkHttp | implemented, verified on device |
| iOS | AVFoundation: `AVAssetReader` into `AVAssetWriter`, `AVAssetExportSession` as the fallback | background `URLSession` | implemented, 11,136 lines of Swift in 28 files; builds for device and for the iOS Simulator with no compiler warning, and 159 XCTest cases run on the simulator (see [Build and test](development.md#build-and-test)); no device run recorded here |
| Web | WebCodecs through Mediabunny, `MediaRecorder` as the fallback | `XMLHttpRequest`, files staged in IndexedDB | implemented, covered by the Vitest and Playwright Chromium suites; see [Web](#web) below |

## iOS

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
builder first needs it, and opened from then on like any video. [iOS pictures](../ios/PICTURES.md) has the details.

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
which the host forwards (see [iOS host setup](installation.md#ios-host-setup)); `PublishStore` is what survives the process dying,
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

## Web

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
is a runtime dependency of the package. It is reached exclusively through `src/video-composer/web/`,
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
finalize step is idempotent on the record being `done`, and the retry ladder is the same 30/60/120 seconds. A Web Lock
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
