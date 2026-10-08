# Media and gallery access

[Documentation](README.md) / [Project overview](../README.md)

- [Saving the finished video to the gallery](#saving-the-finished-video-to-the-gallery)
- [Saving any other file to Downloads](#saving-any-other-file-to-downloads)
- [Reading the gallery, for a host that draws its own picker](#reading-the-gallery-for-a-host-that-draws-its-own-picker)
- [Reading what footage shows](#reading-what-footage-shows)
- [Keeping picked media](#keeping-picked-media)

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
`album` needs `NSPhotoLibraryUsageDescription` as well (see [iOS host setup](installation.md#ios-host-setup)), and without that key the kit never
asks for read access - iOS would terminate the app if it did - and saves to Recents. Android needs
nothing added - the kit's manifest declares the pre-API-29 storage permission, capped so modern
installs do not carry it.

The failures are `invalid_spec` for an option that cannot be honoured, `permission_denied`,
`unreadable_input` for a file that is missing or is not a video, `no_space` for a full disk,
`unsupported` from a browser that cannot download, and `unknown` for whatever else the platform
says. One of those is not yet true everywhere: Android looks for a full disk by the words of the
error rather than by its cause, misses a real `ENOSPC`, and reports it as `unreadable_input`.

## Saving any other file to Downloads

A gallery is for videos. A sound out of the library, or any other file a person wants to keep
outside the app, goes to their Downloads with `VideoComposer.saveToDownloads`:

```ts
const { saved, uri } = await VideoComposer.saveToDownloads({
  uri: sound.uri,           // a `file://` the kit handed back; on the web any URL a page can read
  fileName: 'holiday.m4a',  // extension included; defaults to the source's own name
});
```

Android inserts into the Downloads collection of MediaStore, which needs no permission from API 29,
inserted pending so no other app sees half a file, and answers with the `content://` row; a name
already in Downloads is MediaStore's to number, `holiday (1).m4a`. Below API 29 the file is written
into the public Download directory under a name nothing there has yet, after the same capped storage
permission `saveToGallery` asks for, and handed to the media scanner.

iOS has no Downloads folder an app can write into: the one in the Files app is a folder like any
other, in iCloud Drive or On My iPhone. So iOS puts up the system's own save sheet
(`UIDocumentPickerViewController` exporting a copy), where the person picks the place, Downloads
among them, and taps Save. Backing out resolves `{ saved: false }` rather than rejecting. The sheet
names the file after the one it is handed, so the kit puts a link to it under `fileName` in
`tmp/videokit-downloads/` first, and deletes that once the sheet has answered. A second call while a
sheet is up is refused with `already_picking`, as a second `pickAudioFile` is, and one with no
screen to present on with Capacitor's `UNAVAILABLE`. Nothing goes in `Info.plist`.

The web hands the file to the browser's own download, as `saveToGallery` does there.

A phone opens files and nothing else, so a page's `blob:` URL has to be written out first. That is
what `composerMediaHost` does for the editor's sound library on a phone, through the same staging a
render's page inputs go through, and why its Sound sheet can offer a download on every saved sound
(see [Sound library](editor-customization.md)).

The failures are `invalid_spec` for no `uri`, `permission_denied` for storage refused below API 29,
`unreadable_input` for a file that is not there, `no_space` for a full disk, `already_picking` on
iOS, `unsupported` from a browser that cannot download, and `unknown` for whatever else the
platform says.

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
phone as a copy until the host lets it go, with `releaseMedia` or `sweepMedia` ([Keeping picked media](#keeping-picked-media), below). A flat copy made by an earlier version of the kit is hard-linked into its new place
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

## Reading what footage shows

`labelMedia` asks the phone's own image recogniser what is in a picture, or in a few frames of a
video, and `describeMedia` reads its answer into **scenes** that are the same on every platform: the
call an app makes to pick a template by what somebody's clips show, sort a gallery, or tag a post.

```ts
import { describeMedia, mergeScenes } from 'capacitor-video-kit';

const clip = await describeMedia('file:///.../beach.mov');                 // a video: 5 frames by default
const photo = await describeMedia(pictureUri, { kind: 'image' });          // a picture: looked at once
// clip.scenes  -> [{ scene: 'beach', score: 0.71 }, { scene: 'sunset', score: 0.44 }, ...]
// clip.labels  -> the engine's own labels behind them, averaged over the frames
// null         -> nothing to ask here (the iOS simulator, a browser whose recogniser would not load, an older native build)

const trip = mergeScenes([clip, photo].flatMap((one) => (one ? [one.scenes] : [])));
```

Everything happens on the device, with nothing downloaded and no permission asked: Apple's Vision
(`VNClassifyImageRequest`) on iOS, which is part of the system from iOS 13 and adds nothing to the
app, and Google's ML Kit image labeling on Android (`com.google.mlkit:image-labeling` 17.0.9, Android
5.0 and later), whose base model the kit bundles into the app by default, so it answers offline from
the first call and on a phone without Play services. The kit adds that dependency itself; a host adds
nothing, unless it picks the lighter Play services form below. A browser has no recogniser, so there the
kit brings one, which the host serves; see **In a browser** below.

**What ML Kit weighs, and the lighter ways to have it.** It is the heaviest thing the kit puts in an
Android app: a native library for each CPU a build carries (11.0 MB for arm64-v8a, 6.9 MB for
armeabi-v7a, 12.5 and 12.1 MB for x86 and x86_64) and a 3.0 MB model. On an arm64 phone installing
from an app bundle, which Play splits by CPU, that is about 14 MB installed and 6.4 MB downloaded; a
universal APK carries all four libraries. A host picks another form in its `variables.gradle`:

```groovy
ext {
    videokitImageLabeling = 'playServices'   // or false; -PvideokitImageLabeling=... on the command line
}
```

- **`'playServices'`** takes ML Kit from Google Play services
  (`com.google.android.gms:play-services-mlkit-image-labeling` 16.0.8): about 200 KB in the app, and
  Play services downloads the model and library itself. The kit asks for them when the plugin loads;
  a host that also wants them fetched when the app is installed from Play adds this to its
  `AndroidManifest.xml`, inside `<application>`:

  ```xml
  <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="ica" />
  ```

  Until the model has arrived, and on a phone without Play services, `labelMedia` refuses as
  `unsupported` and `describeMedia` answers null, so a host carries on without scenes, as in a browser.
- **`false`** leaves ML Kit out altogether: `labelMedia` always refuses as `unsupported`, and
  `describeMedia` answers null.

Any other value fails the build rather than quietly bundling.

**In a browser**, where there is no recogniser to ask, the kit brings one: MediaPipe's image classifier
(`@mediapipe/tasks-vision`) running EfficientNet-Lite0 on the CPU through WebAssembly, so a picture
never leaves the page there either. All of it comes from files the host serves beside its page, fetched
at the first call and cached by the browser after that:

| File | From | Size |
|---|---|---|
| `labeling/vision_bundle.mjs` | `node_modules/@mediapipe/tasks-vision/` | 155 KB |
| `labeling/wasm/vision_wasm_internal.js`, `.wasm` and `vision_wasm_nosimd_internal.js`, `.wasm` | `node_modules/@mediapipe/tasks-vision/wasm/` | 11.8 MB (the browser fetches one of the two) |
| `labeling/efficientnet_lite0.tflite` | `node_modules/capacitor-video-kit/web-assets/labeling/` | 5.3 MB |

**None of it is in the host's bundle.** The kit imports MediaPipe's JavaScript from its URL, never
through the bundler, so a build of the app carries only the kit's loader for it (under 2 KB gzipped)
- which matters for a host whose web build is also what its phone apps are made from. For the same
reason the files belong in what is DEPLOYED, not in any build's output: an Angular `assets` entry
puts them in `www/`, and `cap sync` would put their 28 MB into both phone apps, which never load them.
LightSnip copies them into the folder it uploads (`tools/deploy/deploy-web.mjs`, `addLabeling`). `.mjs`
has to be served as JavaScript, or the browser refuses to import it.

A host that serves them elsewhere - a CDN, another folder - says where once, before the first call:

```ts
import { configureWebLabeling } from 'capacitor-video-kit';

configureWebLabeling({
  runtimeUrl: '/static/mediapipe/vision_bundle.mjs',
  wasmBaseUrl: '/static/mediapipe/wasm',
  modelUrl: '/static/efficientnet_lite0.tflite',
});
```

Both of the kit's builds, the ES module one and the CommonJS one (`plugin/cjs`, the `require` entry),
import the runtime from its URL with a real `import()`, so no bundler ever takes it in.

`prepareWebLabeling()` starts the download early - LightSnip calls it as One tap's picker opens - and
resolves `true` once the recogniser is ready or `false` when it will not load. It never rejects, so a
host that only wants the download started calls it and ignores what it answers. A host that times its
own label calls waits on it first, as LightSnip does, so a slow first download is not counted against
the first clips. The model comes down beside MediaPipe's runtime and WebAssembly rather than after
them, so that first wait is as short as the network allows. A load that fails is the answer for a
minute before one is tried again, so the warm-up and the call after it do not both fetch files that
are not there; the retry then imports the runtime under a URL of its own, since Chromium and Firefox
remember a failed import of the same one until the page reloads. `configureWebLabeling` lets a classifier go
only once the calls using it have finished, and never starts a load while another is running.

The calls keep the phones' pace: two at a time, and a video looked at for 8 s at most before the
frames read so far are the answer. The first frame is always tried however long it takes; after it
no new frame is started past the 8 s, whether or not the ones tried gave a picture (as on Android),
no seek is waited on for longer than is left of them, and a video whose decoder has failed is not
seeked again. The 8 s are counted from the call, a wait for a turn included, but not the
recogniser's download: a call made while it downloads counts from the moment it is ready.

**It needs WebGL**, though the model runs on the CPU: MediaPipe takes every picture in through a WebGL
context of its own. Where it cannot start - no WebAssembly, no WebGL (switched off, or a GPU the browser
blocks), or the files are not where it looks - `labelMedia` refuses as `unsupported` and `describeMedia`
answers null, as everywhere a recogniser is missing. A load tries the classifier on one pixel before it
counts as loaded, so a browser that cannot run it is found out there and not at every clip. A
classifier that stops working later - the browser takes its WebGL context back after a GPU reset, or
because the page holds too many - refuses the call it was answering the same way and is loaded afresh
by the next one.

A video the browser opens but decodes no picture for - HEVC in a browser with no decoder for it, which
then plays the file's sound alone - is `unreadable_input`, as on a phone that cannot read a file,
rather than labeled from empty frames. A call with no `kind` reads a file whose type is `video/*` as a
video, and one whose type names neither a picture nor a video (it has none, or it is
`application/octet-stream`) as a video too when its name ends in a video container's extension:
Safari's `<img>` decodes MP4, and would otherwise hand back a clip's first frame as a picture.

**MediaPipe reports its use to Google.** The pictures never leave the page, but MediaPipe's runtime
sends metrics about its own performance and use to Google, at `https://odml.pa.googleapis.com/v1/log`:
which task runs and how, the kind of device the browser says it is on, and how many pictures it
classified and how long that took - when the classifier is created, every minute while it is loaded,
and when it is closed. It has no switch to turn this off, and it starts with the first load: a
`prepareWebLabeling()` as a picker opens is enough. MediaPipe's privacy notice (in the `README.md` of
`@mediapipe/tasks-vision`) makes the app responsible for obtaining its users' informed consent to
Google's processing of that data, as the law that applies requires. So a host that needs that consent
asks for it before its first label call or `prepareWebLabeling()`, and says so in its privacy text.
The kit does not block the request, because whether to is the host's decision; a host that does can
leave the address out of the `connect-src` of its Content Security Policy, after which MediaPipe stops
reporting and goes on labeling.

The model knows ImageNet's 1000 classes (`golden retriever`, `seashore`, `web site`), so `engine` is
`'mediapipe'` and the labels are ImageNet's. Its scores are one softmax, so a picture's confidence is
split between the classes that fit it and `minConfidence` defaults to 0.02 here, not 0.1. It sees food,
pets, birthdays, travel, cities, homes, nature, beaches and screen-recorded games well, and has no class
at all for a person, a sunset or the night sky: in a browser `people` and `sunset` never come back, and
a sunset over the water reads as a beach.

| Scene | What it means |
|---|---|
| `screen` | a screen recording or a screenshot: a game, an app |
| `game` | a game, on a screen or on a table: a video game, a board game, cards, chess |
| `sport` | sport, fitness, and anything done on a board, a bike or skis |
| `food` | food and drink, a meal, a coffee |
| `party` | a night out, a concert, dancing, fireworks, a festive day |
| `birthday` | a birthday cake, candles, balloons, presents |
| `love` | a wedding, a couple (Vision sees a wedding and not a couple; ML Kit sees both) |
| `fashion` | what somebody is wearing: an outfit, shoes, a bag |
| `pet` | a dog, a cat, a pet of any kind |
| `kids` | a baby, a child, a playground, toys |
| `people` | people, a face, a selfie, a crowd: counted low, since somebody is in most footage |
| `home` | indoors at home: a living room, a bedroom, a kitchen |
| `sunset` | a sunset or a sunrise, the light of golden hour |
| `beach` | a beach, the sea, surfing, swimming |
| `nature` | landscape: mountains, forests, lakes, snow, fields |
| `city` | a city: buildings, skylines, streets |
| `travel` | being on the way: planes, luggage, roads, boats |
| `night` | the night sky, the moon, neon |

**Two vocabularies, one set of scenes.** Vision knows 1303 things and names them in `snake_case`
(`birthday_cake`); ML Kit knows 447 and names them in English (`Cake`). They score differently too:
Vision gives a parent label at least its child's confidence, so one cake is `food`, `dessert`,
`baked_goods` and `cake` at once, and ML Kit hands a few labels to nearly anything - `Dog` at 0.79
on a city bridge at night, `Event` at 0.94 on a sunset. `src/video-composer/scenes.ts` holds one
table per engine: a label says a scene with a weight, and a label that is right when it is sure and
wrong when it is not has a floor below which it counts for nothing (ML Kit's `Dog` below 0.9, where
`Pet` is the label that tells a pet from a picture it merely thinks has a dog in it). A label Vision
is never surer of than of a parent meaning another scene carries a weight above 1 - `birthday_cake`,
which always comes with `food` at least as sure - and no label counts for more than 1. In a frame a
scene is as strong as its strongest label, never the sum of them, and across frames it is the mean,
so a scene in the whole clip beats a stronger one in a single frame. `mergeScenes` averages a set
the same way.

The tables were tuned against both engines' real answers for 90 photographs of the themes a video
app gets (beaches, parties, food, pets, sport, cities, couples, outfits) and the frames of eight
screen-recorded games: Vision's two classifier revisions run on macOS, and the exact model file ML
Kit bundles, run with its own score calibration. The strongest scene is the one a person names for
the picture in 82% of them for Vision revision 2, 80% for revision 1 and 82% for ML Kit; most of the
rest are pictures a person would call ambiguous too - an empty basketball court. The same
photographs and captures were then run through `labelMedia` itself on an iPhone 14 Pro Max with iOS
26.6.2: Vision answered in about 23 ms a picture and under 0.7 s a video, its top label matched the
Mac's for 80 of the 90 photographs, and lighsnip's One tap chose the same templates from its answers
as from the Mac's (86% of random groups of one theme's photos, against 86%). A test holds every
label in both tables against the engine's own vocabulary, so a misspelt label cannot quietly never
match.

**Frames.** A video is looked at in 5 frames unless `frames` (1 to 20) or `timesMs` says otherwise,
each in the middle of its own share of the clip, so none is the first or the last, where a camera is
being raised or lowered. The two phones then cut them the way their decoders make cheap:

- [iOS](platforms.md#ios) cuts every one, letting its image generator snap to a keyframe no further than half the gap
  to the next time: with no limit, the frames of a screen recording, whose encoder writes a keyframe
  every few seconds, came back as one picture four times out of five. Past a keyframe it decodes
  forward on the hardware decoder, which costs next to nothing.
- **Android** takes each time at its nearest keyframe, looked up in the index first (`MediaExtractor`,
  which decodes nothing), two times at one keyframe being one frame, and cuts an exact frame only
  while that leaves fewer than three different ones. `MediaMetadataRetriever` decodes in software: on
  the Pixel 7 Pro emulator an exact frame of a 1080x1920 screen recording took 5.5 s against 0.7 s for
  a keyframe, and five exact frames made eight seconds of game take twenty to read. Now it takes about
  3 s there for a clip of any length, and a picture about 0.6 s. A phone's own video, with a keyframe
  every second or two, still gives every frame asked for.

`timeMs` on each frame is the frame the decoder actually handed over. A picture is decoded at 720
pixels on its long edge and turned upright by its orientation tag.

**The iOS simulator refuses, with `unsupported`.** Vision's classifier does not run there and does not
say so: on the simulator's CPU it answers every picture with the same labels - a skateboarder and a
black square both "outdoor, night_sky, moon" on iOS 26.1 and 18.5, and just as wrong on 16.4 - and it
cannot open the simulator's GPU at all. Labels that look like an answer would steer a host wrong, so
the simulator refuses as a browser does, once the file has been read. Test scene logic on a device,
or on the Android emulator, where ML Kit runs on the CPU as it does on a phone.

**What leaves the phone.** No picture, no frame and no label: both engines work on the device. ML Kit
does send Google metrics about how the API performs and is used, and Google asks every app that ships
it to say so to its users; see [ML Kit's data disclosure](https://developers.google.com/ml-kit/terms)
and its [Google Play data safety guidance](https://developers.google.com/ml-kit/android-data-disclosure).
Vision sends nothing.

`labelMedia` rejects `invalid_spec` without a `uri` or with a `kind` that is neither `video` nor
`image`, `unreadable_input` for a file that will not open, a picture that will not decode and a video
with no frame, `unsupported` in a browser and in the iOS simulator, and `unknown` when the engine
itself fails. `describeMedia` answers null for `unsupported` and for an app whose native build is older
than the call (`UNIMPLEMENTED`), and rejects for the rest.

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
asks for are the ones [Reading the gallery](#reading-the-gallery-for-a-host-that-draws-its-own-picker) has the host declare. The two that delete are the ones
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

A host with drafts uses the five like this, and [Native hosts](native-hosts.md#native-hosts) is the same glue with the
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
