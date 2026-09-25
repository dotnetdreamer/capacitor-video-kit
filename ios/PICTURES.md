# iOS: pictures on the timeline

A picture (a still photo) can be a clip on the editor's timeline, mixed with videos: trimmed, cut,
joined, reordered, cropped, fitted and dressed with transitions like any clip. Every engine renders
one now - web, Android and iOS - and the iOS gallery lists photos beside videos when it is asked to.
This file was the work order for the iOS half. It is now the record of how that half works, and of
the little that is still open, for whoever touches it next.

The contract is `ComposeClip.image` in `src/video-composer/definitions.ts`, and the implementations
iOS was held to are Android's `pictureItem` in `CompositionBuilder.kt` with `Pictures.kt`, and the
web's `StillReader` and `probePicture` in `src/video-composer/web/media.ts`. The editor's UI is
shared web code and needed nothing.

## Who turns it on

- Hosts opt in with `editing.pictures` (`src/host/host.types.ts`), off by default. It governs what
  the pickers offer; a manifest that already holds a picture is rendered either way.
- lighsnip answers true everywhere, iOS included (`lighsnip/src/app/core/media/pictures.ts`). That
  is right only with a kit that has both halves below, so lighsnip must not ship on iOS against an
  older one: a post with a picture would fail at the very end, after the editing.
- choisy leaves it off, and that stays as it is.

## The parser (`ComposeSpecParser.swift`, `ComposeSpec.swift`)

`ComposeClip.image` is read by the one clip reader that serves base clips, layer clips and every
transition's `from`, so all three get it. It is read last, after `rect`, so a clip that is wrong in
an older field still reports that field, and a value that is not a boolean reads as a video, the
lenient reading `muted` gets. A picture is forced to speed 1 and muted; everything else - trim,
fit, volume, crop, placement - is kept exactly as sent. A spec with no `image` key anywhere parses
as it always did.

## The render (`PictureStills.swift`, `CompositionBuilder.swift`)

AVFoundation has no still-image item: an `AVMutableComposition` is built from time ranges of tracks,
and a JPEG has no track. So each distinct picture becomes a short H.264 file of one frame, and from
then on nothing downstream can tell it from a video. Orientation, crop, fit, placement, turn and every
transition apply to a picture because they apply to a frame.

- **Where.** `SourceCache.source(for:)` is the choke point every clip goes through - base, layer and
  transition tail - and it asks `PictureStills` first. The still is written the first time its `uri`
  is asked for, into `pictures/<digest of the uri>.mp4` in the job folder, and one file serves every
  clip that names the picture: a picture cut in two, duplicated, or used as a transition's tail.
- **How long.** Before the first clip is laid, one pass over the spec finds the furthest `outMs` any
  clip asks of each picture, because a transition's tail reads the same picture from later on. The
  still runs that long plus one frame at 30 fps of margin, is read back, and is refused if its track
  comes out short.
- **Decoding.** ImageIO's thumbnail path, which turns the picture upright by its EXIF orientation,
  never holds a 48 MP photo whole, and reads the file's content rather than its name - so a picture
  `prepareJob` named `.mp4` still decodes. At most twice the output's long side, capped at 4096 and
  at H.264's 3840x2160 area.
- **Shape and colour.** The still keeps the picture's own shape, never letterboxed or cropped, because
  the compositor measures fit and crop against a source's natural size; each side is rounded down to
  an even number. It is drawn into sRGB, so a Display P3 photo lands in the space the compositor
  blends in, and tagged BT.709. There is no audio track. A transparent picture is drawn over black,
  because H.264 has no alpha.
- **Order and blame.** Pictures and videos are opened in one pass in the builder's order, which is
  Android's preflight order for every spec the editor builds, so when a broken video comes before a
  broken picture both platforms name the video. A picture that will not open or decode fails with
  `BuildError.unreadable(clip.key, ...)`, which reaches JS as `unreadable_input` naming the first clip
  that uses it. A still the writer cannot encode surfaces as the writer's own error, sorted by
  `ErrorMapping` like an export's.
- **Cancellation** is checked before each still and while one is written, and a cancelled still is
  deleted rather than left half written.
- **Lifetime.** A still is the render's alone, about 0.4 MB per 12 MP photo. `JobRegistry.run`
  deletes `pictures/`, with the links `RenderInputs` made in `named/`, once the export has finished,
  failed or been cancelled, or the build has thrown, and before it reports how the render ended, so a
  retry the app starts on `failed` never has its own stills deleted under it. A render whose app was
  killed leaves them for `JobFolders.cleanup` or the launch sweep.
- **Sound.** A picture is silent, and the clips either side of one keep their own level right up to
  their cut: `CompositionBuilder.hold` sets each level again a millisecond before its range ends,
  because AVFoundation otherwise draws a straight line from one clip's volume to the next and a video
  before a picture faded out across its whole length.

A spec with no picture in it never creates `pictures/` and reads no byte more than it did.

## The gallery (`GalleryLibrary.swift`, `VideoComposerPlugin.swift`)

- `listGalleryVideos({ images: true })` fetches photos and videos in one `PHAsset` fetch, newest first
  by `creationDate` - the order the Photos app shows; Android orders by the date a file was added,
  which PhotoKit has no public key for. Every item carries `kind`, and a photo's `durationMs` is 0.
  Without `images` the list is videos alone, as before.
- `galleryThumbnail` serves a photo as it serves a video, through `PHImageManager`, fitted inside a
  `maxSize` square.
- `resolveGalleryVideo` on a photo copies its image resource in the format it is stored in - a HEIC
  stays a HEIC, which the renderer decodes - into the same `videokit-gallery/<id>/<version>/<name>`
  scheme videos use. The copied resource is `.fullSizePhoto`, falling back to `.photo`, so an edit
  made in Photos is what renders; the name is the original's, with the extension of the bytes copied.
- `requestGalleryAccess` accepts `images` and changes nothing: the one photo library grant covers
  photos and videos alike.
- A photo stays a copy, like a video, until the host lets it go with `releaseMedia` or `sweepMedia`
  (README, **Keeping picked media**). One picked through the system picker rather than this gallery
  is kept with `retainMedia`, which moves it out of Caches into `videokit-picked/` under its own
  extension, so a HEIC stays a HEIC there too; `requestMediaAccess` answers granted without a prompt
  whatever `images` says. `gallerySource` and `retainPickedFile`, from `capacitor-video-kit`, are
  that glue for a host, the first marking a listed photo `kind: 'image'` (README, **Native hosts**).

## How it is checked

In the package's own test target, on the iOS Simulator (`README.md`, **Build and test**).
`PicturesParserTests` covers a picture on the base track, on a layer and as a transition's side, a
clip without the key, and what a picture keeps. `PicturesRenderTests` renders real files and reads
frames and sound back:

1. 0.5 s of video then a 1 s cover picture is a 1.5 s file, the picture edge to edge at 1.0 s and the
   video at 0.25 s, and a cover picture keeps its own shape.
2. Pictures alone render with no sound track, and with their music when there is some.
3. A dissolve from a picture into a video and from a video into a picture.
4. A picture on a layer with a `rect` and a turn.
5. EXIF orientation 6 renders upright, a HEIC renders, and a picture named as a video still decodes.
6. A broken picture fails as `unreadable_input` naming its clip, and a broken video before it is the
   clip blamed instead.
7. Cancelling while stills are written leaves no part of one.
8. A spec with no pictures writes no stills.
9. The sound either side of a picture stays whole, on the base track and on a layer.
10. A render through the registry leaves neither `pictures/` nor `named/` behind, whether it
    finished or its build failed after a still was written.

The gallery's PhotoKit paths cannot run there, because the test runner cannot be granted the photo
library. They were run in a throwaway app on the simulator instead: listing with kinds, thumbnails,
and eight photos and nine videos resolved.

## Still open

- **Nothing here has run on a device.** In particular the H.264 size cap for stills, a HEIC or a
  ProRAW picture from a real library, and limited photo library access, which the simulator cannot
  grant.
- **The two halves have not met.** The render and the gallery were each checked on their own, so a
  photo resolved out of the library and then composed with `image: true` has not been run end to
  end on iOS. It is the first thing to try with the two together.
- **A zoom deeper than 2x is as sharp as the still, not the photo.** Under a zoom
  (`ComposeSpec.camera`) the compositor samples the SOURCE through the camera, and for a picture the
  source is the still, decoded at most twice the output's long side. The web engine decodes up to the
  camera track's deepest scale times that side, still capped at 4096; doing the same here (the
  track's largest `scale`, itself held under `ComposeSpecParser.maxCameraScale`) costs encode time
  and has not been weighed.
