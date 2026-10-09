# Video composition

[Documentation](README.md) / [Project overview](../README.md)

- [Use](#use)
- [Composer](#composer)
- [Failure codes](#failure-codes)

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

## Composer

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
one post, and the library is not one of them, so it copies without having to ask (see [iOS](platforms.md#ios)).

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
the first clip and then fails the whole export at the first item boundary. (See the [device checks](development.md#on-a-device).)

**Music repeats explicitly.** `setIsLooping` repeats the whole sequence including its leading gap,
so a track starting three seconds in would go silent for three seconds on every repeat. The plan
lays out numbered repetitions and clips the last one, in microseconds, to the video's exact end -
or to `ComposeMusic.endMs`, when the music was given a stop before that (the editor's end handle on
a looping sound sets it; `EditMusic.endMs` of 0 means "until the end"). A pass is as long as the
probe reads the file when the spec asks for the end of it, which is how the editor sends a sound it
did not trim at its end (`ComposeMusic.outMs`). A sound the probe cannot read is logged, not failed,
and is laid as one pass to the stop: it plays once, to the end of its file, and is silent after it.

**Fades multiply, they do not replace.** Media3's `DefaultGainProvider.addFadeAt` overrides the
default gain inside the fade window, so a 60 %-volume track would ramp to 100 % and then drop.

**Music fades belong to the time it is heard, not to a repetition.** The fade in runs from
`ComposeMusic.startMs` and the fade out ends where the music stops - its stop, the end of the video,
or the end of a section that plays once - with each repetition given its share of the one line, so
the line runs straight across the seams and the two multiply where they overlap
(`ComposeMusic.fadeInMs` has the rule every engine and the preview share). Hung off the last
repetition instead, a fade out was lost whenever that repetition was shorter than the fade: a stop
dropped just past a seam, or a video a sliver longer than a whole number of passes. A last
repetition shorter than a frame is still left off (Media3 fails an item under a millisecond), and
the fade out then ends where the one before it stops.

**Music at a speed is sped up pass by pass, at its own pitch.** `ComposeMusic.speed` does to the
trimmed section what a clip's speed does to its trim: `inMs`, `outMs` and `phaseMs` stay places in
the file, and every length the plan lays is on the output, a pass being the section divided by the
speed. Android puts Media3's Sonic time-stretch first among each pass's audio processors, ahead of
its exact length and its gain, so both count in output time as the plan does. Not `setSpeed`, which a
clip uses: Media3 refuses it beside a processor that changes an item's length, and the exact length is
one. iOS scales each pass
into its place as it inserts it, under the `.spectral` pitch algorithm the music track already has.
The web stretches each pass with the SOLA the clips use, together with the first moments of the pass
after it, so a loop has no gap at its seams.

**A sound's effect is a few plain steps, run the same way by every engine.** `ComposeMusic.effect`
is not a name: the editor keeps the names (`SOUND_EFFECTS` in `src/editor/sound-effects.ts`) and
sends what an effect is made of - cookbook biquads, a soft-clipping drive measured against the
sound's own peak, a gain, and whether to fold the channels into one - with the arithmetic written down
in `definitions.ts`. A new effect built from those steps needs no new engine. Every engine runs them
after a pass's speed change and before its volume and fades, from a state at 0 for each pass: Android
as a `SoundEffectProcessor` after Sonic and ahead of the exact length and the gain, iOS as an
`MTAudioProcessingTap` created pre-effects on the sound's own mix parameters, so it runs ahead of the
volume ramps in both the export session and the reader, and the web on each pass's samples before
they are added into the mix. The same golden fragment is asserted in all three engines' tests. The
preview cannot put a filter on an `<audio>` element, so it plays a copy of the file made through the
same TypeScript (`src/web-runtime/sound-copy.ts`): the whole file on its own timeline, so every
position the player puts the element at is the same in the copy, at 22.05 kHz for an effect that
passes nothing above a fifth of that.

**Inputs are taken, not referenced.** `prepareJob` moves app-owned files and copies everything else
into `filesDir/video-batches/<id>/`. A picker's `content://` grant dies with the Activity that got
it. Only `cleanup` deletes a job folder.

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

`saveToDownloads`: the same, and `already_picking` on iOS while its save sheet is up. Backing out
of that sheet is `{ saved: false }`, not a failure.

`labelMedia`: `invalid_spec`, `unreadable_input`, `unsupported` (web and the iOS simulator),
`unknown`.

Publisher: `network`, `http`, `auth`, `server_rejected`, `file_missing`, `cancelled`, `unknown` - each with `phase`, an optional `httpStatus`, and `retryable`.
