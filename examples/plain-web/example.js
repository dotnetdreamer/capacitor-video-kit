/*
 * The whole of what a page has to do to put the editor on screen: point the package at its own
 * files, put the fonts in the document, define one tag, and set two properties on it.
 *
 * There is no host object here at all. The editor then runs on the browser defaults in
 * `host/defaults.ts`, which is a real editor rather than a degraded one: the pickers are file
 * inputs, the filmstrip is cut with a `<video>` and a canvas, and Next hands back the manifest
 * unrendered - because this page supplies no `render` host, not because a browser cannot encode.
 * It can: `VideoComposer` has a web implementation that renders and muxes a real MP4. Wiring it in
 * is the same two lines here as in a Capacitor application, and the README has that half.
 */

/* One tag. Under `dist-custom-elements` this call defines every tag `ve-editor` renders, and the
   report at the bottom of the page is that claim, checked. */
import { defineCustomElement as defineVideoEditor } from 'choisy-video-kit/dist/components/ve-editor.js';
import { installEditorFonts, setEditorAssetPath } from 'choisy-video-kit/dist/components/index.js';

/**
 * Two clips to open with.
 *
 * `key` is the editor's whole idea of a source: the manifest stores keys, never URLs, so an edit
 * can be put down and picked up again. The files are MDN's own example videos, so this page works
 * from a fresh clone with nothing downloaded. Point `playbackUrl` at a file of your own to see your
 * own footage.
 *
 * They come from another origin, which is why the timeline's lanes are grey here. The readme beside
 * this file has the whole of that, and it is the browser filmstrip rather than the example.
 */
const SOURCES = [
  {
    key: 'clip-a',
    fileName: 'flower.mp4',
    playbackUrl: 'https://mdn.github.io/shared-assets/videos/flower.mp4',
  },
  {
    key: 'clip-b',
    fileName: 'friday.mp4',
    playbackUrl: 'https://mdn.github.io/shared-assets/videos/friday.mp4',
  },
];

/* Where `serve.mjs` serves a copy of the package's `dist/components/assets`. The directory that
   HOLDS `assets`, not `assets` itself. */
setEditorAssetPath('/video-editor/');

/*
 * The faces the editor draws text in. It matters for correctness rather than looks: text is burned
 * into the finished video by a canvas, and a canvas never waits for a font, so a missing face is a
 * posted video that does not match what was approved. Loud here is cheap; loud there is not.
 */
installEditorFonts().catch((error) => report(String(error), true));

defineVideoEditor();

const stage = document.getElementById('stage');
const result = document.getElementById('result');

open();

function open() {
  const editor = document.createElement('ve-editor');
  /* A property, not an attribute: an attribute could only carry a string, and the editor hands
     these same objects back when the customer is done. */
  editor.sources = SOURCES;
  editor.maxSources = 10;
  /* `editor.manifest = saved` reopens a previous edit of the same sources. */

  editor.addEventListener('veDone', (event) => {
    const { sources, manifest, stitched } = event.detail;
    show(
      'Done',
      stitched
        ? `Rendered to ${stitched.fileName}`
        : 'No render host, so the edit comes back as a manifest for the application to render',
      { sources: sources.map((source) => source.key), manifest },
    );
  });

  editor.addEventListener('veCancel', (event) => {
    show('Cancelled', `The customer left with ${event.detail}`, null);
  });

  stage.replaceChildren(editor);
  result.hidden = true;
}

function show(title, note, payload) {
  /* The editor comes off the page, which is what a host does when one of the two events arrives:
     it is a screen, and the screen is over. Leaving it mounted also leaves a video playing. */
  stage.replaceChildren();
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-note').textContent = note;
  document.getElementById('result-json').textContent = payload ? JSON.stringify(payload, null, 2) : '';
  result.hidden = false;
}

document.getElementById('again').addEventListener('click', open);

/*
 * The roster, and the reason this page is here. Nothing below imports a component, registers a list
 * or names a barrel; the one `defineVideoEditor()` call above is what defines all of these, because
 * Stencil reads the child tags out of each component's own render and the graph is transitive.
 */
const TAGS = [
  've-editor',
  've-preview',
  've-timeline',
  've-toolbar',
  've-sheet',
  've-adjust-sheet',
  've-crop-sheet',
  've-effects-sheet',
  've-filter-sheet',
  've-layout-sheet',
  've-opacity-sheet',
  've-quality-sheet',
  've-sound-sheet',
  've-speed-sheet',
  've-sticker-sheet',
  've-text-sheet',
  've-voiceover-sheet',
  've-volume-sheet',
  've-alert',
  've-icon',
  've-progress',
  've-slider',
  've-spinner',
  've-toast',
];

const missing = TAGS.filter((tag) => !customElements.get(tag));
report(
  missing.length === 0
    ? `${TAGS.length} tags defined by one defineCustomElement() call`
    : `${TAGS.length - missing.length} of ${TAGS.length} tags defined, missing ${missing.join(', ')}`,
  missing.length > 0,
);

function report(text, bad) {
  const footer = document.getElementById('report');
  footer.textContent = text;
  footer.classList.toggle('bad', Boolean(bad));
}
