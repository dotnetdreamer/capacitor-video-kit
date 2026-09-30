# Editor assets and customization

[Documentation](README.md) / [Project overview](../README.md)

- [Two things a host has to call](#two-things-a-host-has-to-call)
- [Getting the assets served](#getting-the-assets-served)
- [What the host supplies](#what-the-host-supplies)
- [The edits the host settles](#the-edits-the-host-settles)
- [A size ceiling is the host's to set](#a-size-ceiling-is-the-hosts-to-set)
- [Theming](#theming)
- [Conventions every component holds to](#conventions-every-component-holds-to)

## Two things a host has to call

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

## Getting the assets served

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

## What the host supplies

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
| `platform.confirm` | The editor's questions: Discard edits? (or Save and exit? with `editing.savesDrafts`), and what to do when a render fails | the package's own alert |
| `platform.measureInsets` | What the status and navigation bars cover | `env(safe-area-inset-*, 0px)` |
| `platform.debug` | Whether the package says anything on the console | silence |

**The default filmstrip is blank for a clip served from another origin.** It draws each frame on a
canvas, and a cross origin video taints that canvas, so `toDataURL` throws `SecurityError: Tainted
canvases may not be exported` and the lane stays grey with nothing said. A file the customer picked
is an object URL and is fine; a clip from a CDN is not. A host in that position supplies
`media.thumbnails` of its own, which a Capacitor app has from `composerMediaHost` for every clip with
a path.

**A picker resolves with null on a cancel and rejects on a real failure.** The editor shows a
different thing for each, and a host that rejects on a cancel makes every picker look broken.

**The sound library is three calls and the host decides where the bytes live.** `list()` answers
with what is kept, newest first; `extract(source)` pulls the audio out of a video the EDITOR picked -
so the library never grows a picker of its own - keeps it, and answers with the record; `remove(id)`
deletes one. `extract` resolves with null for a video that carries no audio track, which is a fact
about the file rather than a failure, and the editor says so plainly instead of showing an error.

On a Capacitor host whose sounds should live with the composer, which owns the files and the records,
that is `composerMediaHost({ sounds: 'native' })` ([Native media host](editor.md#native-media-host)), and nothing to write.

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

## The edits the host settles

A few edits have more than one defensible answer, and the apps on this editor want different ones.
`editing` is where a host says which, along with the one thing about leaving that only the host
knows: whether the edit is kept once the editor has gone. Every field is optional and an absent one
keeps the editor's own default, so a host that says nothing edits exactly as it always has:

```ts
editor.host = {
  ...host,
  editing: { pictures: true, zoom: false },
};
```

| Field | Default | What it decides |
|---|---|---|
| `replaceKeepsLength` | `true` | Whether Replace trims the new footage to the length of the segment it fills, so nothing after it moves, or takes the whole of the new file |
| `pictures` | `false` | Whether the clip pickers - Add clip, a second video layer, Replace - offer stills beside videos, through `media.pickMedia`. The render has to be able to draw one, which all three of the package's engines can |
| `zoom` | `true` | Whether the Zoom tool is offered: the Zoom tile on the root tool row, between Crop and Layout, and Duplicate on a selected zoom's row, which are the only two ways a customer adds a zoom. `false` takes both away rather than dimming them, and the root row closes up around the gap |
| `savesDrafts` | `false` | Whether the host keeps the edit as a draft while it is made, from `veChange`. It decides what Back asks of an edit with changes: "Discard edits?" with a red Discard, or, on, "Save and exit?", "Your changes are kept as a draft", and Save and exit in the ordinary colour. Keep editing is the other button either way |

**`pictures` and `zoom` govern what the editor OFFERS, and nothing else.** A manifest or a draft that
already holds a picture or a zoom still shows it, edits it and renders it: a zoom is still on the
timeline's zoom row, and is still opened, changed, retimed, deleted and undone. Hiding it would leave
a camera move in the preview that nothing on screen can reach, and dropping it would change the post
behind the customer's back. The reasons behind each default are written on `EditorEditingOptions` in
`src/host/host.types.ts`.

**`savesDrafts` changes the words and nothing else.** The editor saves nothing itself, so both
questions do the same thing: Keep editing, or a dismissal, stays in the editor, and Discard or Save
and exit emits `veCancel('back')`. What the host does with that is the host's, which is why the
editor cannot find this out for itself. Turn it on only when every change from `veChange` really is
kept somewhere the customer can open it again. A host that saves only on Next, or on some screens
and not others, loses the changes on Back and should leave it off, because "kept as a draft" said by
a host that keeps nothing is the one wrong answer here that costs somebody their work. The words
name no screen, since the package cannot know what the host calls its drafts or where they are.

With a `platform.confirm` of the host's own, the question arrives there like any other, and Save
and exit carries the role `save`. The answer must be that role exactly as it came: a dialog that
answers only for the roles it knows reads the tap as a dismissal, and the customer cannot leave.
Ionic's `AlertController` hands any role back as it was given, so a host built on it needs nothing
new for this button. The one role such a host turns into null is `backdrop`, which is Ionic's answer
for a tap outside and for the hardware back button, on this question as on every other.

`zoom` holds agents too when the host passes it on, and to a stricter line. The MCP server is never
handed the editor's host, so it takes the same field for itself:
`createVideoKitMcpServer({ editing: { zoom: false } })` in code, or `--no-zoom` on the stdio
process's command line. Off, no post on that server holds a zoom at all: every zoom op is refused,
and so is a manifest handed in with a zoom in it, a saved draft's included. [No zoom on the server at
all](mcp.md#no-zoom-on-the-server-at-all) says why the server goes further than the editor here. A server
nobody told still adds zooms, and a manifest it built with one in it opens in an editor with Zoom off
as any other manifest holding one does.

## A size ceiling is the host's to set

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

## Theming

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

## Conventions every component holds to

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
