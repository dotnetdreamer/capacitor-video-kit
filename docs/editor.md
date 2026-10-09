# Editor integration

[Documentation](README.md) / [Project overview](../README.md)

- [Editor core](#editor-core)
- [The editor as web components](#the-editor-as-web-components)
- [The editor's whole public surface](#the-editors-whole-public-surface)
- [Putting the editor on screen](#putting-the-editor-on-screen)
  - [A plain page, no framework and no build step](#a-plain-page-no-framework-and-no-build-step)
  - [React](#react)
  - [Vue](#vue)
  - [Angular](#angular)
  - [A Capacitor app, where the native engines do the rendering](#a-capacitor-app-where-the-native-engines-do-the-rendering)
  - [Native media host](#native-media-host)
  - [What is left in the application](#what-is-left-in-the-application)

## Editor core

`src/editor/` is the framework-free half of editing, what `web.ts` is to the plugins. An editor UI
in any framework builds an `EditManifest` and hands it to `toComposeSpec`:

```ts
import { reconcileManifest, toComposeSpec, cssFor, filterPreset, VideoComposer } from 'capacitor-video-kit';

// Start from a straight cut of the host's clips (or bring back a saved edit).
let manifest = reconcileManifest(saved, clipKeys, durationsByKey);

// Preview with the SAME maths the native render uses.
const { filter, tint } = cssFor(filterPreset(manifest.filterId).ops);
videoEl.style.filter = filter;

// Render.
const spec = toComposeSpec(manifest, uriByKey, { jobId, batchId });
await VideoComposer.compose(spec);
```

| Export | What it is for |
|---|---|
| `EditManifest`, `EditClip`, `EditOverlay`, `EditMusic`, `EditVoice` | The edit, in a form that survives being put down and picked up. Overlays keep their **text**, not a bitmap, so a reopened edit is still editable. |
| `reconcileManifest` | Brings a saved edit back in line with a clip list that changed meanwhile. Clips are referred to by the host's own keys - the core never needs to know the host's clip shape. |
| `toComposeSpec` | The one translation from an edit to a render. Rasterises text at output scale, computes the bitrate, writes the host's size ceiling when there is one. |
| `FILTER_PRESETS`, `cssFor`, `filterPreset` | CSS Filter Effects maths shared by the live preview and the native colour matrix. |
| `videoBitrateFor`, `totalDurationMs`, `isUntouched` | Output policy: the bitrate a frame of this size needs to look like its source, however big that makes the file; skip the encode for one untouched clip. |
| `rasteriseText`, `rasteriseArrow` | Canvas → PNG at output pixel scale, the caller's half of the overlay contract. |

There is deliberately no UI in `src/editor/` itself. A host is free to build its own screen on the
contract, and the first application on this package did exactly that, in Angular, until the
components below replaced it. The contract is what both were written against, which is why replacing
one editor with the other changed no manifest and no render.

A host that wants only the editing half imports `capacitor-video-kit/editor` instead. Nothing on that
path registers a plugin or imports `@capacitor/core` at runtime, so a web build that will never run
natively carries no Capacitor code: Vite tree-shakes an import of one constant from it down to
0.11 kB. The editor's own components are its first consumer, from inside this same package: they
import `../editor` relatively, which is what folding the two repositories into one was for.

## The editor as web components

The editor screen packaged so it can be dropped into a React, Vue or Angular application without
carrying Angular, Ionic or Capacitor with it. Twenty four custom elements, of which a host uses
exactly one: `<ve-editor>` is the screen, and the other twenty three are what it is made of.

| Import | What it is |
|---|---|
| `capacitor-video-kit` | the native plugins, plus everything above |
| `capacitor-video-kit/ui` | the components themselves, framework free, and the store they read |
| `capacitor-video-kit/react` | React components, generated from the components |
| `capacitor-video-kit/vue` | Vue components, generated from the components |
| `capacitor-video-kit/angular` | Angular standalone components, generated from the components |

One install carries all five, and a host imports the one line it needs. The three wrappers hold no
hand written component code at all: `stencil.config.ts` writes `packages/<framework>/src/generated/`
on every build, which is why those directories are ignored by git, and `build:wrappers` compiles
each into `angular/`, `react/` or `vue/` at the root, which the exports map points at.

**The wrapper and the components have to be the same build**, and being one package is what
guarantees it. A wrapper is generated from one particular build and hard codes that build's prop and
event names as strings, so a wrapper compiled against different components passes props that do not
exist and misses ones that do, with no error anywhere. A second copy of the components is worse
still: it registers the same custom element names against a registry that allows each exactly once.

That used to be an exact peer dependency between four separate packages - what `@ionic/react`,
`@ionic/vue` and `@ionic/angular` do with `@ionic/core` - and it was the rule nobody could satisfy
here, because none of these is on a registry: the peer edge sent npm to look the core package up
whenever its tarball was not installed first, and every such install ended in
`404 Not Found` against `registry.npmjs.org`.

There is nothing to version-match now, so nothing to get wrong. The frameworks themselves are
**optional peers** of this package: an application with only Angular in its tree is warned about
neither React nor Vue, and bundles neither, because nothing here imports a framework the host has
not asked for by writing its subpath.

## The editor's whole public surface

One element, four properties, two events.

```html
<ve-editor></ve-editor>
```

| Property | Type | Default | What it is |
|---|---|---|---|
| `sources` | `readonly EditorSource[]` | required | What the customer is editing. The editor hands these same objects back and never reads a field it did not put there, so a host can carry its own on them. |
| `manifest` | `EditManifest` | a straight cut of `sources` | A previous edit of these same sources, when the customer is stepping back into one. |
| `maxSources` | `number` | `10` | When Add stops offering itself. |
| `host` | `VideoEditorHost` | the browser defaults | The door to the device: pickers, the encoder, the keyboard, the back button. Absent is a real editor, not a degraded one. |

| Event | Detail | When |
|---|---|---|
| `veDone` | `VideoEditorResult` | The customer tapped Next and the render, if there was one, finished. |
| `veCancel` | `EditorCancelReason`, `'back'` or `'exit'` | They left without a video. Two reasons because a host's own navigation has to tell a back press from a discard. Back on an edit with changes asks first: "Discard edits?", or "Save and exit?" on a host that keeps drafts and says so with `editing.savesDrafts` ([The edits the host settles](editor-customization.md#the-edits-the-host-settles)). |

```ts
interface VideoEditorResult {
  /** The originals, in the order the customer left them and without the ones they removed. */
  sources: EditorSource[];
  manifest: EditManifest;
  /** Absent when there was nothing to render. A single untouched clip is not re-encoded. */
  stitched?: EditorSource;
}
```

All four properties are objects or numbers, so they are set as **DOM properties, not attributes**.
Every framework wrapper here does that for you; a plain page writes `element.sources = [...]`.

**That is the whole contract.** There is no imperative API, no `open()` that resolves with a result,
no service to construct. The editor is an element: a host puts it on screen however it puts anything
on screen, and takes it off when one of the two events arrives. What that buys is that the editor
has no opinion at all about navigation, and navigation is the part every application does
differently. An Ionic host opens it in an `ion-modal`, a React web application might route to it, and
neither has to be talked out of it.

The things a video editor needs that an element cannot do for itself are all in `host`, and the
split is the same one every time: **the editor owns the edit, the application owns the device.** The
manifest, the undo stack, every gesture, every sheet and every pixel are the package. Files,
encoding, the upload afterwards and anything that reaches Capacitor are the application, because
they are what differs between a native app and a web page, and a UI package that guessed at them
would be wrong wherever it guessed.

## Putting the editor on screen

Four steps, and only the third one changes between frameworks.

1. `setEditorAssetPath('/video-editor/')`, with a copy of the package's assets served there.
2. `installEditorFonts()`, at startup, where a failure is loud.
3. Define the tag, which is what a wrapper does for you and what a plain page does in one call.
4. Set `sources` and listen for `veDone`.

See [assets and fonts](editor-customization.md#two-things-a-host-has-to-call) for steps 1 and 2.

### A plain page, no framework and no build step

`examples/plain-web/` is this, checked in and runnable:

```sh
npm run build:package    # once, so dist/ exists
npm run example
```

It prints `http://localhost:5173`, and that page is the editor, on two of MDN's example videos, with
no application around it. Without the build first it says so and stops, naming the file it wanted:

```
/path/to/capacitor-video-kit/dist/components/ve-editor.js is not there.
Run "npm run build:package" in /path/to/capacitor-video-kit first.
```

`serve.mjs` is a static server with no dependencies: it serves the example directory, `node_modules/`
so that a bare specifier in the import map resolves to real files the way a bundler would resolve
it, and the package's `dist/components/assets` at `/video-editor/assets/`.

The page itself is three files. The import map, because there is no bundler to resolve a bare
specifier:

```html
<script type="importmap">
  {
    "imports": {
      "capacitor-video-kit/": "/node_modules/capacitor-video-kit/",
      "@preact/signals-core": "/node_modules/@preact/signals-core/dist/signals-core.mjs"
    }
  }
</script>
<script type="module" src="./example.js"></script>
```

and then the whole integration, which is `example.js` with its comments taken out:

```js
import { defineCustomElement as defineVideoEditor } from 'capacitor-video-kit/dist/components/ve-editor.js';
import { installEditorFonts, setEditorAssetPath } from 'capacitor-video-kit/dist/components/index.js';

const SOURCES = [
  { key: 'clip-a', fileName: 'flower.mp4', playbackUrl: 'https://mdn.github.io/shared-assets/videos/flower.mp4' },
  { key: 'clip-b', fileName: 'friday.mp4', playbackUrl: 'https://mdn.github.io/shared-assets/videos/friday.mp4' },
];

setEditorAssetPath('/video-editor/');
installEditorFonts().catch((error) => report(String(error), true));

defineVideoEditor();

const editor = document.createElement('ve-editor');
editor.sources = SOURCES;
editor.maxSources = 10;
editor.addEventListener('veDone', (event) => showResult(event.detail));
editor.addEventListener('veCancel', (event) => showCancelled(event.detail));
document.getElementById('stage').replaceChildren(editor);
```

`showResult` puts the manifest on the page and takes the editor off it, because one of those two
events is the end of the screen and an editor left mounted is a video left playing.

`defineVideoEditor()` is the only registration on the page and it defines all twenty four tags, for
the reason in [conventions](editor-customization.md#conventions-every-component-holds-to). The page prints how many it
found along the bottom, so that claim is checked rather than asserted.

There is no `host` object at all, which is the other thing this page is for. The editor then runs on
the browser defaults: the pickers are file inputs, the durations come from a throwaway `<video>`,
the filmstrip is cut with a canvas, and Next hands the manifest back unrendered, because the editor
is handed no `render` host and does not go looking for one. A page that wants the browser to encode
gives it one, exactly as a Capacitor app does - see [Web](platforms.md#web).

Both imports come out of `dist/components` on purpose. `capacitor-video-kit/ui` is the same code
compiled a second time for bundlers, so a page that took the element from one and
`setEditorAssetPath` from the other would download the editor twice. An import map also has no
exports map to read, so it can only name real files: `capacitor-video-kit/ui` is not a path that exists
on disk, while `dist/components/index.js` is.

The alternative to naming the element's own file is the lazy loader, which registers every tag at
once and fetches each component's code only when that tag turns up in the page:

```html
<script type="importmap">
  { "imports": { "@preact/signals-core": "/node_modules/@preact/signals-core/dist/signals-core.mjs" } }
</script>
<script type="module">
  import { defineCustomElements } from '/node_modules/capacitor-video-kit/loader/index.mjs';
  import { installEditorFonts, setEditorAssetPath } from '/node_modules/capacitor-video-kit/dist/capacitor-video-kit/index.esm.js';

  setEditorAssetPath('/video-editor/');
  defineCustomElements();
  void installEditorFonts();
</script>
```

The import map does not go away, because the lazy build imports the signals library by name too, and
nothing in this package can resolve a bare specifier for a browser. The second import is that same
lazy bundle's own entry rather than `dist/components/index.js`, so the page still holds one copy of
the editor and not two. A host with a bundler writes `from 'capacitor-video-kit/loader'` and
`from 'capacitor-video-kit/ui'` and never sees either path.

### React

```sh
npm install ../capacitor-video-kit/capacitor-video-kit-1.3.0.tgz
```

Once, wherever the application starts:

```ts
import { installEditorFonts, setEditorAssetPath } from 'capacitor-video-kit/ui';

setEditorAssetPath('/video-editor/');
void installEditorFonts();
```

Then the editor is a component:

```tsx
import { VeEditor } from 'capacitor-video-kit/react';
import type { EditorSource, VideoEditorResult } from 'capacitor-video-kit/ui';

const SOURCES: EditorSource[] = [
  { key: 'clip-a', fileName: 'flower.mp4', playbackUrl: '/media/flower.mp4' },
];

export function EditorScreen({ onDone }: { onDone: (result: VideoEditorResult) => void }) {
  return (
    <VeEditor
      sources={SOURCES}
      maxSources={10}
      onVeDone={(event) => onDone(event.detail)}
      onVeCancel={() => history.back()}
    />
  );
}
```

Nothing registers a custom element here, in any of the three frameworks. The generated wrapper holds
the component's own `defineCustomElement` and calls it as the module is imported, and that one call
defines the other twenty three tags. An event is a prop named `on` plus the event, capitalised, and
what the handler is given is the `CustomEvent` itself, so **the result is `event.detail`**.

### Vue

```sh
npm install ../capacitor-video-kit/capacitor-video-kit-1.3.0.tgz
```

```vue
<script setup lang="ts">
import { VeEditor } from 'capacitor-video-kit/vue';
import type { EditorSource, VideoEditorResult } from 'capacitor-video-kit/ui';

const sources: EditorSource[] = [
  { key: 'clip-a', fileName: 'flower.mp4', playbackUrl: '/media/flower.mp4' },
];

function onDone(event: CustomEvent<VideoEditorResult>) {
  console.log(event.detail.manifest);
}
</script>

<template>
  <VeEditor :sources="sources" :max-sources="10" @veDone="onDone" />
</template>
```

A prop may be written either way, `:max-sources` or `:maxSources`; Vue camelises what it is given
and the wrapper sets it on the element as a property, objects and arrays included. A listener is the
event's own name, and again the handler is given the `CustomEvent`.

`setEditorAssetPath` and `installEditorFonts` are the same two calls as in React, in `main.ts`.

### Angular

```sh
npm install ../capacitor-video-kit/capacitor-video-kit-1.3.0.tgz
```

```ts
import { Component } from '@angular/core';
import { VeEditor } from 'capacitor-video-kit/angular';
import type { EditorSource, VideoEditorResult } from 'capacitor-video-kit/ui';

@Component({
  selector: 'app-editor-screen',
  imports: [VeEditor],
  template: `
    <ve-editor
      [sources]="sources"
      [maxSources]="10"
      (veDone)="onDone($event)"
      (veCancel)="onCancel()"
    ></ve-editor>
  `,
})
export class EditorScreenComponent {
  readonly sources: EditorSource[] = [
    { key: 'clip-a', fileName: 'flower.mp4', playbackUrl: '/media/flower.mp4' },
  ];

  onDone(event: CustomEvent<VideoEditorResult>): void {
    console.log(event.detail.manifest);
  }

  onCancel(): void {}
}
```

The wrapper is a standalone component, so it goes in `imports` and there is no
`CUSTOM_ELEMENTS_SCHEMA` and no module. Inputs are camelCase, `[maxSources]`, and an output hands
over the `CustomEvent`, so `$event` is the event and `$event.detail` is the result. Under
`strictTemplates` a missing `[sources]` is a build error rather than an empty editor:

```
error NG8008: Required input 'sources' from component VeEditor must be specified.
```

A host installing this package from a checkout rather than a tarball also needs
`"preserveSymlinks": true` on both the `build` and the `test` target, for the reason in
[Install](installation.md#install).

### A Capacitor app, where the native engines do the rendering

Everything above is the same. What changes is that `host` is no longer left out, because on a phone
there is a real answer to every question the browser defaults were guessing at - including the
render, which the defaults leave null. The same object runs in a page too, which is where an app
under `ionic serve` finds itself: `composerMediaHost` is the browser defaults there and
`composerRenderHost` renders with the composer's web engine, so the one line that has to ask which it
is on is the app's own gallery pickers, handed over on a phone alone ([Native media host](#native-media-host) says why).

```ts
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { VideoComposer, composerMediaHost, composerRenderHost } from 'capacitor-video-kit';
import { registerBackHandlerWith, type VideoEditorHost } from 'capacitor-video-kit/ui';

const host: VideoEditorHost = {
  // The browser defaults with the composer behind the probe, the filmstrip and the microphone, and
  // here its sound library too (see Native media host). On a phone the clip pickers are the app's
  // own, resolving null on a cancel (see Native hosts); in a page they are the browser's file inputs.
  // `pickImage` and `pickAudio`, which on iOS is already the kit's own document picker (see iOS host
  // setup), stay the defaults.
  media: composerMediaHost({
    ...(Capacitor.isNativePlatform() ? { pickers: { pickVideo, pickMedia } } : {}),
    sounds: 'native',
    release: ({ kept, dropped }) => discardRecordings(kept, dropped),
  }),
  // The render, over the same composer, on a phone and in a page alike. See below.
  render: composerRenderHost(),
  platform: {
    // No `fileUrl`: the default is `webViewUrl`, which sends a device path through Capacitor's local
    // server wherever the page has Capacitor.
    haptic: (kind) => {
      switch (kind) {
        case 'light':     void Haptics.impact({ style: ImpactStyle.Light }); break;
        case 'medium':    void Haptics.impact({ style: ImpactStyle.Medium }); break;
        case 'selection': void Haptics.selectionChanged(); break;
        case 'success':   void Haptics.notification({ type: NotificationType.Success }); break;
        case 'warning':   void Haptics.notification({ type: NotificationType.Warning }); break;
      }
    },
    keyboard: {
      subscribe: (listener) => {
        const handles = [
          Keyboard.addListener('keyboardWillShow', (info) => listener(info.keyboardHeight)),
          Keyboard.addListener('keyboardWillHide', () => listener(0)),
        ];
        return () => void Promise.all(handles).then((all) => all.forEach((handle) => void handle.remove()));
      },
      show: () => void Keyboard.show(),
    },
    // At 101, ahead of Ionic's own overlay handler at 100, so the editor closes its sheet before a
    // modal decides the press was for it; a press it has nothing to close for goes on down. `ionic`
    // here is Ionic's own Platform service, not the `platform` key this sits in.
    registerBackHandler: registerBackHandlerWith(ionic),
    confirm: (request) => presentNativeAlert(request),
    measureInsets: () => VideoComposer.systemInsets(),
    debug: !environment.production,
  },
};
```

The render is `composerRenderHost()` from the package root: the editor's render host over
`VideoComposer`, the same on a phone and in a page, because the composer's web implementation renders
too and `isSupported` asks whichever implementation is loaded. Every host used to write the same
sixty lines of it by hand, and got the same few of them wrong. What differs between hosts is what
happens to the file afterwards, and that is what the options are for:

```ts
import { composerRenderHost, readRenderFile } from 'capacitor-video-kit';

// An app that keeps its renders, in drafts or the gallery: nothing to say.
const render = composerRenderHost();

// An app whose render is only ever on its way to an upload.
const uploadRender = composerRenderHost({
  // The upload sends a File, so the render is read into one: `edited-<jobId>.mp4`, or `.webm` for
  // a browser's WebM. `UploadClip` is the app's own source type: an `EditorSource` with the `File`
  // on it, which the editor hands back untouched.
  toSource: async (result, { jobId }): Promise<UploadClip> => {
    const file = await readRenderFile(result.uri, `edited-${jobId}`);
    return {
      key: `edited-${jobId}`,
      fileName: file.name,
      file,
      sourcePath: result.uri,
      thumbnailUrl: result.posterUri || undefined,
    };
  },
  // Each earlier render's folder deleted before the next starts, so an edit made twice leaves one file.
  discardPreviousRenders: { storageKey: 'my-app.render-folders' },
  // Every failed render's reason in the app's own log, in production too.
  log: (...details) => console.error(...details),
});

// ...and when the upload flow ends, either way, so the last render is not left on disk either:
await uploadRender.discardRenders();
```

| Option | What it is for | Left out |
|---|---|---|
| `toSource(result, { jobId, batchId, manifest })` | The finished file as the source `veDone` carries as `stitched`. The editor does nothing with that source but hand it back, so what it carries is the host's: a `File` for an upload, which `readRenderFile(result.uri, name?)` reads, a name for the gallery. It may be async. What it throws fails the render: a `RenderFailedError` as it is, anything else as `unknown`. It is not called for a job that finished after the customer called the render off, since the editor would throw its source away. | `{ key: 'edited-<jobId>', fileName: 'edited.mp4', sourcePath: result.uri, thumbnailUrl: result.posterUri }`, the name `edited.webm` for the WebM a browser with no MP4 encoder writes, and no thumbnail when no poster could be cut. No `playbackUrl`, because the editor plays a source without one through `platform.fileUrl(sourcePath)`. |
| `discardPreviousRenders` | `true`, or `{ storageKey, remember }`. Deletes the folder of every earlier render with `VideoComposer.cleanup` before each new render starts, and makes `discardRenders()` do the same when the host's flow ends. The ids are written down in `localStorage` as each render starts, so a run the app was killed in is cleaned up by the next one; an id whose cleanup fails is kept for next time, and so is the folder of a render on the page that has not settled yet, since `cleanup` forgets the job in it and that render would never hear how it ended. Only the newest `remember` are kept at all. A host that already kept such a list names its key, and the folders on it are still deleted; an entry that is not a folder id of its own (empty, `.` or `..`) is dropped rather than handed to `cleanup`. | Off. Nothing is written down or deleted, and `discardRenders()` does nothing, which is right for an app that keeps its renders. The defaults once on are `capacitor-video-kit.render-folders` and 16. |
| `log(...details)` | Where failures are reported: a spec `toComposeSpec` refused, a job the composer failed, an input that could not be staged, a `toSource` that threw, a cleanup that did not go through, a platform that could not be asked what it can encode. The editor can show only one of four fixed sentences, so this is the only record of why. | The package's debug switch, which the editor sets from `platform.debug`, so these lines appear exactly when the editor's own do. |
| `ids()` | The job id and the folder id of one render, called once per render. Both must be new each time: composing under the id of a job that already exists answers with that job. A folder id that is empty, `.` or `..` fails the render as `unknown` before anything starts, because the native halves keep dots and `cleanup` of `..` would delete every job folder and the one they are in. | `render-<time>-<random>` and `edit-<time>-<random>`, from `crypto.getRandomValues`, since `crypto.randomUUID` is missing from a page served over plain http. |

What it does for every host, which is the part that was written wrong by hand:

**It draws with the editor's own raster context.** The editor hands it over as
`RenderRequest.raster`, made for the frame this render is at, and the spec is built with it, so every
layer in the file is drawn exactly as the preview drew it. That is why there is no `platform` to
pass: the context resolves the sticker URLs against the asset base of the Stencil runtime the editor
was loaded with, which the plugin at the root does not have, and a context built there could point a
sticker at a different file than the customer saw. Its `output` being `manifest.output` is what keeps
a 4K post's caption from being drawn at 720p and burned in soft.

**It reads each clip by the URL its engine can open.** `sourcePath` whenever there is one. Without
one, in a browser, `playbackUrl`, since the web engine opens whatever the page can, an object URL
from the editor's own picker included. On a phone only a `blob:` URL, which it writes out as a file
first (below); a WebView URL such as Capacitor's local server is nothing a native engine can open,
so a clip with only that is refused before any job as `unreadable_input`, naming the clip.

**It hands the engine files, not blobs.** A page holds some of a post as `blob:` URLs in the
WebView's own memory - a sound from the browser's sound library, a track the default picker read in
on iOS, a clip a host kept as bytes - and neither native engine can open one. Every render goes
through `withNativeRenderInputs(spec, render, signal)`, which stages each distinct blob through
`stageRenderInput`, a mebibyte per call, renders a copy of the spec that names the staged files, and
releases them once the job has settled. In a browser it is the render and nothing else. An input
that cannot be staged rejects with a `RenderInputError` in the composer's own terms, and the job
never starts: a blob that will not read - revoked by whatever minted it, or empty - is
`unreadable_input` naming the clip whose URL it was, and a write the phone refused is `no_space`
for a full disk and `unknown` otherwise.

**It listens before it starts.** `compose` answers with the job id at once and the rest arrives as
events, and a two second clip can finish before an `await` comes back, so the three listeners are on
before `compose` is called, match on the job id, and come off however the job ends. The render
settles on the job's own `completed` or `failed`, never on `compose`'s answer, because the staged
inputs are deleted the moment it settles.

**It honours the signal at the moment a cancel can name the job.** The editor aborts when the
customer backs out of the export screen or leaves mid render. An abort before `compose` never starts
the job; one while `compose` is on its way is cancelled the moment the composer has the job, since a
cancel sent before then names an id it has never heard of and is lost, and the encode runs on with
nobody waiting. Once the signal is aborted, whatever fails after settles as the abort and is not logged:
the `cancelled` that answers its own cancel, an encoder that broke as the cancel landed, an iOS job
`interrupted` by a customer leaving the app on the way out, a `compose` that rejected, a spec
refused, an input that would not stage, a `toSource` that threw, even a `RenderFailedError` it
worded itself. The editor has let go of the render, and a line in the log would read as a broken
render nobody had. A cancel nobody here asked for, with the signal still live, is reported like any
other failure. A job that finishes after all, its cancel having lost the race with the last frame,
settles as the abort too, and `toSource` is not called for a file nobody will use. The abort listener comes off when the job
settles, so a finished render sends no cancel when the editor leaves.

**It passes the host's size ceiling on.** `RenderRequest.maxBytes`, the host's own
`output.maxBytes` handed back, goes to `toComposeSpec` as it comes, and writes nothing when it is
unset ([A size ceiling is the host's to set](editor-customization.md#a-size-ceiling-is-the-hosts-to-set)).

**It rejects with `RenderFailedError` on the editor's union, whatever failed.** The composer's
`no_space`, `unreadable_input` and `too_large` carry straight across, a `RenderInputError` from
staging is read the same way, and everything else - an encoder, a muxer, an interrupted job, a
listener the bridge refused, a `toSource` that threw - is `unknown` and logged, because the editor
shows one sentence per code and a code it does not know reads as a blank apology. A render the
customer called off rejects with the signal's reason instead. The composer blames a failure on the
SEGMENT that had it, since split and duplicate put several segments over one source, and the
failure's `sourceKey` is that segment's clip key, on the base track or on any layer, so the host
hears about its own source. `instanceof` holds whichever door the class came through: every
instance carries a `Symbol.for` brand, and every copy of the class on the page - the root's,
`/ui`'s, `dist/components`' and the editor's own chunk's - looks for it. The editor also reads an
error's `name` and code, so one built without the brand is still heard.

**It does not call `prepareJob`.** That call takes ownership of its inputs and MOVES them into the
job folder, and the originals still belong to whatever step recorded or picked them: the customer
can step back, watch them, remove one, and come forward again. The composer reads each source where
it already is, and the job folder only ever holds the output.

A host that renders some other way - its own engine, a server - implements `EditorRenderHost` itself:
`toComposeSpec(manifest, uriByKey, ids, request.raster, { maxBytes: request.maxBytes })`, its own job,
and a `RenderFailedError` with a code on the union for every failure. The class is exported from the
root and from `capacitor-video-kit/ui`, and the editor recognises either.

### Native media host

`composerMediaHost(options?)`, from the package root, is `host.media` for a Capacitor app: the browser
defaults, with the composer behind every member a phone has a better answer for. It sits at the root
beside `composerRenderHost` for the same reason, that it calls the plugin and `capacitor-video-kit/ui`
never reaches `@capacitor/core`. Every Capacitor host used to write these few lines over
`VideoComposer` for itself, and the copies differed in ways that were mistakes: a probe and an extract
that read `sourcePath!` of a source with none, a probe that called a file the composer had opened
unreadable because a `<video>` could not open it too, a voiceover take kept by a name its folder
forgets within a day.

```ts
import { Capacitor } from '@capacitor/core';
import { composerMediaHost } from 'capacitor-video-kit';

// An app whose drafts keep bytes: its own gallery pickers on a phone, and everything else the kit's.
const media = composerMediaHost(Capacitor.isNativePlatform() ? { pickers: { pickVideo, pickMedia } } : {});

// An app that uploads, whose pickers are a service of its own: the service passes itself, and
// gives back a dropped clip itself, its object URL and its recording both, so its pickers are safe
// to use in a page too. Its sounds are the composer's, a file each in app storage.
class EditorMediaService {
  readonly media = composerMediaHost({
    pickers: this, // its pickVideo and pickImage; pickAudio is left to the kit
    sounds: 'native',
    release: (request) => this.release(request),
  });
  async pickVideo(): Promise<UploadClip | null> { /* the app's picker plugin */ }
  async pickImage(): Promise<PickedImage | null> { /* likewise */ }
  release({ kept, dropped }: ReleaseRequest): void { /* the app's own URLs and files */ }
}
```

What it answers, member by member:

| Member | On a phone | In a page |
|---|---|---|
| `probeDuration` | `VideoComposer.probe` on `sourcePath`, rounded. The browser probe, reading the source as the preview plays it, for a source with no path, a file the composer could not read, and one it opened with no finite length, where a `<video>` element sometimes knows better. A file the composer opened is 0 long rather than unreadable when the element cannot open it either, since a rejection is the editor's sentence for a clip that has gone. | the browser's |
| `thumbnails` | `VideoComposer.thumbnails` on `sourcePath`, each frame through `webViewUrl`, since the WebView may load the composer's JPEGs only through Capacitor's local server. The browser's canvas for a source with no path. A failure rejects, and the editor shows the poster frame for it. | the browser's |
| `voice` | `startVoiceRecording` and `stopVoiceRecording`, with the codes the editor reads (`already_recording`, `permission_denied`) passed straight on. A take comes back as an object URL over its bytes, typed `audio/mp4`, or as its file when it could not be read quickly (below). | none, as the browser defaults have none: the web composer's recorder answers a `videokit-file:` name, which the preview cannot play |
| `sounds` | the browser library unless `sounds: 'native'` | the browser library either way: the web composer keeps its sounds in the same IndexedDB store |
| pickers, `release` | the host's, and the browser's where it brought none | the same |

**A voiceover take comes back as bytes, not as the recorder's file.** Both recorders write the take
into their cache folder, `video-composer/voice` under the app's caches, which the plugin's next load
empties of anything a day old and the system may empty sooner. The preview and the render would read
that file well enough, but a draft is kept for longer than a day, and a host that keeps a draft's
files by name - a path beats a copy, for a clip that is already in the customer's library - reopened
it to a voiceover with nothing behind it. So the take is read into the page through Capacitor's local
server and handed over exactly as a browser's sound is: the preview plays it, a draft keeps its bytes,
and a render on a phone writes it out as a file of its own again (`withNativeRenderInputs`), named
`.m4a` after its type. A take is AAC at 96 kbps in one channel, under a megabyte a minute. One that
cannot be read into the page, or not within three seconds, is handed over by its file instead, which
still plays and renders that day, rather than lost over a draft reopened tomorrow: the editor gives
the whole stop eight seconds, the recorder's own included, before it tells the customer the take could
not be saved. A host that keeps a draft past a day reads such a take with `readVoiceTake(uri)` from
`capacitor-video-kit/ui` before it files the draft: the read the kit makes, typed the same way.

The copy is held in memory for as long as the page lives, since no take's URL is revoked: `release`
names sources and never a take, and a kept take is read again after the editor has gone, by a draft,
a render or an edit opened again on the same manifest. A take the editor throws away is held too,
because a stop cannot say who is waiting on it: the microphone turned straight back off when the
sheet closed or lost its room while the permission prompt was up, or the editor taken away mid take.
Those are a moment long, or one take. A recording a reloaded page left running, which the sheet
stops after a start refused as `already_recording` and which can run for minutes, is handed back as
its file without being read.

The recorder is on by default on a phone, and it asks for the microphone on the first take: an iOS
host declares `NSMicrophoneUsageDescription` ([iOS host setup](installation.md#ios-host-setup)) or passes `voice: false`, since iOS
terminates an app that asks without one. Android's `RECORD_AUDIO` comes with the kit's own manifest.

| Option | What it is for | Left out |
|---|---|---|
| `pickers` | `{ pickVideo?, pickMedia?, pickImage?, pickAudio? }`, the app's own, on every platform, each resolving null on a cancel. Each is called as a method of the object it came on, so a service can pass itself. A host that brings `pickVideo` and no `pickMedia` gets no `pickMedia` at all, so that with `editing.pictures` on the editor's clip pickers fall back on its own `pickVideo` rather than on a file input that hands a phone a clip with no path. In a page, object URLs a host's picker mints (`pickMediaFiles` is one) are held until its own `release` revokes them, since the browser host's revokes only its own. So a host whose `release` gives back what its pickers mint, as the service above does, passes them everywhere, and one whose pickers are meant for a phone passes them only there: `composerMediaHost(Capacitor.isNativePlatform() ? { pickers } : {})`. | the browser host's: file inputs, and for `pickAudio` on iOS in a Capacitor app the kit's own document picker, which is why a native host leaves that one out |
| `release` | What the app gives back once the edit has settled what it dropped ([What the host supplies](editor-customization.md#what-the-host-supplies)). It runs after the browser host's own, which revokes only the object URLs its own pickers minted, so a host that keeps any browser picker has those given back too and never has one of its own revoked. | the browser host's alone |
| `sounds` | `'browser'`, `'native'`, or an `EditorSoundLibrary` of the host's own, used on every platform. `'native'` is the composer's library: a file per sound in the app's storage with a record beside it, the compressed track remuxed where the platform can manage it rather than decoded. A sound is a `file://` URI that the preview plays through `platform.fileUrl` and the engine reads where it is, so a draft that keeps paths keeps it for as long as it is in the library. `extract` reads `sourcePath`, or `playbackUrl` for a source with no path, and names the sound after the video without its extension, or leaves a source with no name to the composer, which names the sound after the file it read. `'browser'` keeps each sound in the page's IndexedDB as a WAV, about ten megabytes a minute, as a `blob:` URL a draft keeps the bytes of and a render stages. | `'browser'` |
| `soundCatalogue` | The app's music library, an `EditorSoundCatalogue`, used on every platform: ready-made tracks in categories, one tab each on the Sound sheet ([the music library](editor-customization.md#what-the-host-supplies)). Its two methods are called on the object they came on, so a service can pass itself. | none, and the sheet has no tabs |
| `voice` | `false` for no voiceover sheet, or an `EditorVoiceHost` of the host's own, used on every platform. | the composer's recorder on a phone, none in a page |

The platform is read once, when the host is made: it cannot change under a page, and whether `voice`
is there at all is what decides whether the editor offers the voiceover sheet.

### What is left in the application

The editor replaced one function, `VideoEditorService.open(clips)`, and the parts of it that were
never editing stayed where they were.

| The old call | Where it lives now |
|---|---|
| `open(clips, manifest, maxClips)` | `<ve-editor [sources] [manifest] [maxSources]>`, placed in whatever the application shows a full screen step in |
| the modal dismissing with `confirm` and data | `veDone`, with the same result object |
| the modal dismissing with `back` | `veCancel` |
| `VideoRenderService` | `host.render`: `composerRenderHost()` from the package root, with what the application does with the file in its `toSource` |
| `discardUnusedClips` | `host.media.release`, handed to `composerMediaHost({ release })` and still in the application, which is the only place that knows two keys can share one file |
| `VideoComposer.systemInsets()` | `host.platform.measureInsets` |
| the upload that follows | untouched. The editor hands back sources and a manifest and has no idea an upload exists |
