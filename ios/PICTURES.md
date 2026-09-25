# iOS: pictures on the timeline

A picture (a still photo) can now be a clip on the editor's timeline, mixed with videos: trimmed,
cut, joined, reordered, cropped, fitted, and dressed with transitions like any clip. The web engine
and the Android engine render it. **The iOS engine does not**, and the iOS gallery does not list
photos. This is the work to close that gap. All of it is in this repo (`capacitor-video-kit`),
almost all of it in `ios/Sources/CapacitorVideoKitCore/`.

The editor UI is shared web code and already handles pictures, so there is no UI work here.

## Where things stand

- Hosts opt in with `editing.pictures` (`src/host/host.types.ts`). It is off by default.
- lighsnip turns it on everywhere except iOS (`lighsnip/src/app/core/media/pictures.ts`).
- choisy turns it off explicitly, and that stays as it is.
- So no iOS user can reach this code yet. Once the iOS engine renders pictures and the gallery
  lists them, the iOS exception in lighsnip can go.
- Today a spec with a picture fails on iOS in `SourceCache.source(for:)` (`CompositionBuilder.swift`,
  about line 140) with `unreadable(clip.key, "no video track")`, which reaches JS as `unreadable_input`.

## The contract (read this first)

`ComposeClip.image?: boolean` in `src/video-composer/definitions.ts`. When true:

- `uri` is a picture (JPEG, PNG, HEIC, WebP, anything the platform decodes), not a video.
- It is ONE frame held for `outMs - inMs` of output time, turned upright by its EXIF orientation.
- It has no sound and no speed: render it silent at 1x whatever `muted`, `volume` and `speed` say.
- Never clamp its trim to a probed duration, because a still has none.
- `crop`, `fit`, `rect` (placement and rotation) and transitions apply exactly as they do to a
  video frame.
- It can appear on the base track, on an extra layer (`tracks[].clips`), and as a transition's
  outgoing side (`clips[i].transitionIn.from`).

What JS actually sends (`toComposeSpec` in `src/editor/compose.ts`): pictures always arrive with
`inMs: 0`, `speed: 1`, `muted: true`. A transition's `from` on a picture has the same `uri` and an
`inMs` greater than 0.

```json
{ "key": "seg-2", "uri": "file:///.../IMG_0042.HEIC", "inMs": 0, "outMs": 3000,
  "speed": 1, "volume": 1, "muted": true, "fit": "cover", "image": true }
```

A spec with no `image` key anywhere must build exactly as it does today, with no extra work.

## Reference implementations to mirror

- **Android parser:** `android/.../ComposeSpecParser.kt`, `parseClip`. `image` forces speed 1 and
  muted true.
- **Android probe:** `android/.../Pictures.kt`, a header-only decode that fails early for a file
  that is not a picture. The picture branch of preflight is in `VideoComposerPlugin.kt`.
- **Android render:** `android/.../CompositionBuilder.kt`, `pictureItem`. Media3 has native image
  items, which AVFoundation does not, so the approach differs; the behaviour must not.
- **Web:** `src/video-composer/web/spec.ts` (`readClip`), `media.ts` (`StillReader`,
  `probePicture`), and `render.ts`.
- **Tests to mirror:** the picture cases in `android/src/test/.../ComposeSpecParserTest.kt` and
  `RenderPlanTest.kt`, and "a picture on the timeline, end to end" in
  `src/video-composer/web/render.cmp.test.ts`.

## 1. Parser (`ComposeSpecParser.swift`, `ComposeSpec.swift`)

- Add `let image: Bool` to `ComposeClip` (`ComposeSpec.swift`, about line 63).
- In `ClipDTO` (about line 639): add `image` to `CodingKeys` and read it with
  `c.flag(.image, false)` next to `muted`. Read it last, after `rect`, so an older field that is
  wrong is still the one reported.
- In `clip(_:transitionIn:)` (about line 161), which builds the `ComposeClip`: when `image` is true,
  set `speed` to 1 and `muted` to true.
- This one reader serves base clips, layer clips and transition `from`s, so all three get it.

## 2. Render (`CompositionBuilder.swift`)

AVFoundation cannot insert a still into an `AVMutableComposition`. So before the build, turn each
distinct picture `uri` into a short H.264 still-frame video, then let the existing code treat it as
a video source. Nothing downstream (transitions, layers, the compositor) should need to know.

**The choke point is `SourceCache.source(for:)`** (about line 132). Every clip goes through it:
base, layer and tail.

**How long each still must be.** At the start of `build(_:)` (about line 187), before the clip loop,
work out for each picture `uri` the longest length it is needed for: the max `outMs` over every clip
that names it. That includes base clips, `tracks[].clips`, and every `transitionIn.from`. The
builder clamps each source range to the video track's range, so the file must run at least that
long. Add a frame of margin.

**Writing the still** (`AVAssetWriter`), into the job folder, e.g.
`JobFolders.jobDir(spec.batchId)/pictures/<hash of uri>.mp4`. `JobFolders.cleanup` deletes the
whole job folder, so these files go with it.

- **Decode with ImageIO** (`CGImageSourceCreateThumbnailAtIndex` with
  `kCGImageSourceCreateThumbnailWithTransform: true`,
  `kCGImageSourceCreateThumbnailFromImageAlways: true`, and
  `kCGImageSourceThumbnailMaxPixelSize` about `min(4096, 2 * output long side)`). That turns the
  image upright by EXIF and never holds a 48 MP image in memory. Under a zoom (`ComposeSpec.camera`)
  the compositor samples the SOURCE through the camera, so the still's size is the ceiling on how
  sharp a zoomed picture can be: consider `min(4096, ComposeSpecParser.maxCameraScale * output long
  side)` there, weighing the extra encode time against it. ImageIO reads the file's content,
  not its extension: `prepareJob` names an input with no extension `.mp4`
  (`JobFolders.defaultExtension`), and a picture must still decode then.
- **Keep the picture's own shape.** Do not letterbox or crop it: the compositor measures fit and
  crop against the source's natural size. Round each side to an even number for H.264.
- **Orientation is baked in**, so `preferredTransform` stays identity. The file has no audio track.
- **Frames:** H.264, append the same pixel buffer at t=0 and at t = length − 1/30 s, then
  `endSession(atSourceTime: length)`. Load the result and assert its video `timeRange` covers
  `length`.
- **Reuse one file per `uri`** within a build. A picture cut in two, duplicated, or used as a tail
  is the same file.

**Loading the still.** Map the picture `uri` to the generated file and load it in `SourceCache`
exactly as a video. Its `audioTrack` is nil and `gain(of:)` (about line 818) is 0 for a muted clip.
Confirm a mixed spec (a video with sound, then a picture, then a video with sound) keeps each
video's sound in place and is silent over the picture.

**Failures.** A picture that will not open or decode must throw
`BuildError.unreadable(clip.key, "...")`, so JS gets `unreadable_input` naming the clip, as on
Android and the web. Respect cancellation while writing the stills.

**Transitions.** In and out of a picture should just work, because both sides are video tracks by
then (`EditCompositor.swift`, `TransitionRender.swift`). Verify a dissolve both ways.

## 3. Gallery (`GalleryLibrary.swift`, `VideoComposerPlugin.swift`)

The contract, in `definitions.ts`:

- `requestGalleryAccess({ images?: boolean })`.
- `listGalleryVideos({ offset, limit, images?: boolean })` returns items with
  `kind: 'video' | 'image'`, and `durationMs: 0` for a photo.
- `galleryThumbnail` and `resolveGalleryVideo` take a photo's id exactly as they take a video's.
- Without `images`, everything behaves exactly as today.

Changes:

- **`list`** (about line 74). With `images`, fetch photos and videos together, newest first by
  `creationDate` as now: `PHAsset.fetchAssets(with: options)` and a predicate
  `mediaType == image || mediaType == video`. Emit `kind` on each item.
- **`fileName(of:)`** (about line 189, with the resource choice at about line 186). For a photo,
  use the `.fullSizePhoto` resource, falling back to `.photo`. Keep `.fullSizeVideo` then `.video`
  for videos.
- **`resolve`** (about line 135). For a photo, write the image resource to a file where videos are
  written today, with its own extension (`.heic`, `.jpg`), and keep its format: the renderer decodes
  HEIC. Allow network access for iCloud, as videos already do. Return the `file://` URI and file
  name.
- **`thumbnail`.** It uses `PHImageManager`, which already serves photos. Verify it.
- **Access.** The photo library grant already covers photos and videos, so accept the `images`
  argument and change nothing else.
- **Plugin.** Read `images` in `listGalleryVideos` and pass it through, and add `kind` to each
  item's JSON.

## 4. Docs and the lighsnip switch

- **`src/video-composer/definitions.ts`.** In `ComposeClip.image` (about line 135), drop "iOS does
  not render pictures yet…". In `ListGalleryVideosOptions.images` (about line 634), drop "Android
  only for now…".
- **`src/host/host.types.ts`.** In `EditorEditingOptions.pictures`, drop the iOS caveat.
- **lighsnip `src/app/core/media/pictures.ts`.** Make it return true on iOS as well. lighsnip has
  no iOS project today, so this is ready for when it does.
- **choisy.** Leave `editing: { pictures: false }` alone.

## Acceptance

There is no Swift test target. Build the kit (`npm run build`) and use choisy-mobile's iOS project,
the only host with one. Drive `VideoComposer.compose` with hand-built specs from its lab page
(`src/app/modules/video-kit-lab/`), or turn `editing.pictures` on in a local debug build and revert
it before committing. Adding a Swift test target for the parser is welcome.

**Render** (pull the file and check frames):

1. 0.5 s of video then a 1 s picture (`fit: "cover"`): the file is 1.5 s long. At 1.0 s the frame
   is the picture edge to edge; at 0.25 s it is the video. Mirror the web test.
2. Only pictures: renders, with no sound unless music is set.
3. A dissolve from a picture into a video, and from a video into a picture: blended mid-window,
   and each side correct outside it.
4. A picture on an extra layer with a `rect` (picture in picture) and a rotation.
5. A portrait JPEG with EXIF orientation 6 renders upright, and a HEIC from the library renders.
6. A broken file with `image: true`: a `failed` event with code `unreadable_input` and that clip's
   `clipKey`.
7. A spec with no pictures renders exactly as before.

**Gallery:**

- `listGalleryVideos({ images: true })` returns photos with `kind: "image"`, and their thumbnails
  load.
- `resolveGalleryVideo` on a photo gives a file that `compose` accepts with `image: true`.
- Without `images`, the list is unchanged.

## Out of scope

- No TypeScript, Android or UI changes beyond the doc lines in step 4.
- The preview is web code and already handles pictures.
- Do not turn pictures on in choisy.
