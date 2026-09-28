# Native host helpers

[Documentation](README.md) / [Project overview](../README.md)

- [Native hosts](#native-hosts)

## Native hosts

A Capacitor app with drafts was writing the same glue around the [media retention calls](media.md#keeping-picked-media) whatever it edited:
turning a pick into a source that lasts, turning a gallery item into one, giving the engine files
rather than blobs, and letting go of copies nothing uses. That glue is in the kit - at
`capacitor-video-kit`, or at `capacitor-video-kit/ui` for the few parts that call no plugin - so what
is left in the app is its picker plugin, its keys and its drafts. The whole of it:

```ts
import { Capacitor } from '@capacitor/core';
import { FilePicker, type PickedFile } from '@capawesome/capacitor-file-picker';
import {
  VideoComposer,
  composerMediaHost,
  composerRenderHost,
  gallerySource,
  retainPickedFile,
} from 'capacitor-video-kit';
import { filePickerCancelled, type EditorSource } from 'capacitor-video-kit/ui';

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

// The app's picker plugin, with a cancel as the null every editor picker answers one with and
// anything else as the failure it is. `@capawesome/capacitor-file-picker` here.
async function pickOne(pick: () => Promise<{ files: PickedFile[] }>): Promise<PickedFile | null> {
  try {
    return (await pick()).files[0] ?? null;
  } catch (error) {
    if (filePickerCancelled(error)) return null;
    throw error;
  }
}

// The editor's media host: the probe, the filmstrip and the microphone over the composer, with the
// clip pickers the app's on a phone, since their object URLs in a page would outlive the edit (see
// Native media host). `pickAudio` stays the default, which on iOS is already the kit's own document
// picker, so there is no audio picker to write.
const media = composerMediaHost(
  Capacitor.isNativePlatform()
    ? {
        pickers: {
          async pickVideo() {
            const file = await pickOne(() => FilePicker.pickVideos({ limit: 1 }));
            return file ? sourceFor(file) : null;
          },
          async pickMedia() {
            // With editing.pictures on: the same, offering stills.
            const file = await pickOne(() => FilePicker.pickMedia({ limit: 1 }));
            return file ? sourceFor(file) : null;
          },
        },
      }
    : {},
);

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

**`composerMediaHost(options?)`** is the editor's media host over the composer, and [Native media host](editor.md#native-media-host) has its options and what it does: the host brings its pickers and its `release`, and the kit
answers the probe, the filmstrip, the voiceover and, when asked, the sound library.

**`composerRenderHost(options?)`** is the editor's render host over the composer, and [A Capacitor app, where the native engines do the rendering](editor.md#a-capacitor-app-where-the-native-engines-do-the-rendering) has its options and what it does. The host it
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

**`probeMediaDuration(uri, kind = 'video')`** is `composerMediaHost`'s probe for a file that is not
a source yet: a track the app's own audio picker chose, a clip before it becomes one. On a phone a
device file - a bare path, a `file://` or a `content://` URI - is asked of `VideoComposer.probe`
first, and the page's own `<video>` or `<audio>`, as `kind` says, through `webViewUrl`, is the
fallback for a file the composer could not read or found no length in, and the only probe for a
`blob:`, `data:` or `http(s):` URL and for anything in a page. It answers milliseconds, 0 for a file
that opens with no length to give, and null for one that neither can open, which a picker refuses
rather than letting a render fail on it later.

**`readFileBlob(uri)`**, from `capacitor-video-kit/ui`, is the bytes behind a file the way a page has
to read them: a device path, `file://` or `content://` through `webViewUrl`, and anything the page
loads as it is. It takes the iOS local server's answer for a whole file, which has no HTTP status and
so is not `ok`, as the file it is, and rejects with a plain `Error` naming the URI for a fetch that
failed, an HTTP error, a file of no bytes or no URI at all. The type is as the bytes came, which
from the iOS local server is none. `readRenderFile`, the default audio picker on iOS and the
voiceover recorder all read through it. **`readVoiceTake(uri)`**
is the same read typed `audio/mp4`, what both recorders write, for a host that keeps a take the
media host handed over as its file ([Native media host](editor.md#native-media-host)).

**`filePickerCancelled(error)`**, from `capacitor-video-kit/ui`, says whether
`@capawesome/capacitor-file-picker` rejected because the customer backed out, for the picker's
`catch` above. The plugin rejects a cancel exactly as it rejects a failure, with no code on any
platform, so the test is its own message and all of it: `pickFiles canceled.`, which every pick call
answers on iOS, Android and the web whether the sheet was cancelled, swiped away or finished with
nothing chosen, and `pickDirectory canceled.`. Anything looser silences real failures, since on iOS a
photo that could not be loaded rejects with the system's own sentence, in the customer's language.
It reads the error's shape and does not depend on the plugin.

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

**The editor's default `pickAudio`** is the kit's document picker on iOS ([iOS host setup](installation.md#ios-host-setup) says
why), so a native host keeps it by leaving `pickAudio` out of `composerMediaHost`'s pickers.

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
