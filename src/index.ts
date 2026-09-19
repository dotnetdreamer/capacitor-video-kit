/**
 * `choisy-video-kit/ui`: the editor's public surface, everything in it that is not a component.
 *
 * It is a subpath rather than the package root because the root is the Capacitor plugin, which a
 * React or Vue host never wants and which imports `@capacitor/core` statically. Nothing here does.
 *
 * The editor is ONE element. A host places `<ve-editor>`, sets four properties on it and listens
 * for two events; everything else in this package is something that element renders.
 *
 * ```ts
 * import { installEditorFonts, setEditorAssetPath } from 'choisy-video-kit/ui';
 * import { defineCustomElement } from 'choisy-video-kit/dist/components/ve-editor.js';
 *
 * defineCustomElement();                 // ve-editor, and with it the other twenty tags
 * setEditorAssetPath('/video-editor/');  // where this package's `assets` directory is served
 * void installEditorFonts();             // the faces the render burns into the finished video
 *
 * const editor = document.createElement('ve-editor');
 * editor.sources = clips;                // the sources the step before left
 * editor.manifest = previousEdit;        // optional, when stepping back into an edit
 * editor.maxSources = 10;
 * editor.host = { media, render, platform };
 * editor.addEventListener('veDone', (event) => post(event.detail));
 * editor.addEventListener('veCancel', () => back());
 * document.body.append(editor);
 * ```
 *
 * Defining that one tag is all the registration there is: under `dist-custom-elements` a
 * component's generated `defineCustomElement` also defines every tag it renders, transitively. A
 * React, Vue or Angular host uses the wrapper for its framework instead, and a page with no build
 * step uses `choisy-video-kit/loader`.
 *
 * The component classes themselves are deliberately not exported from here, because those three
 * doors are what a host actually uses and a fourth one that needs `@stencil/core` at the call site
 * is not a door. The element's own property and event types are here all the same, through the
 * generated `components.d.ts` at the bottom of this file.
 *
 * What else belongs here: the host interface the editor is handed, the types a caller needs to read
 * a result, the editor's own state for a host that wants to drive it from outside, the catalogues
 * the sheets are built from, and the two functions that have to run before the editor renders. The
 * manifest itself - `EditManifest` and the edit operations over it - is the contract the Swift and
 * Kotlin engines are written against, so it lives at `choisy-video-kit` and `choisy-video-kit/editor`
 * rather than here.
 */


/*
 * What the host supplies. Only the resolver and the browser defaults are values; the rest is the
 * shape a host implements.
 */
export type {
  ConfirmRequest,
  EditorCancelReason,
  EditorEncodeSupport,
  EditorInsets,
  EditorKeyboardHost,
  EditorMediaHost,
  EditorOutputOptions,
  EditorPlatformHost,
  EditorRenderHost,
  EditorSoundLibrary,
  EditorSource,
  EditorVoiceHost,
  HapticKind,
  PickedAudio,
  PickedImage,
  ReleaseRequest,
  RenderFailureCode,
  RenderRequest,
  ResolvedEditorHost,
  ResolvedOutputOptions,
  ResolvedPlatformHost,
  SavedSound,
  ThumbnailRequest,
  VideoEditorHost,
  VideoEditorResult,
} from './host/host.types';
export { RenderFailedError } from './host/host.types';
export { browserMediaHost, browserSoundLibrary, envSafeAreaInsets, resolveEditorHost, visualViewportKeyboard } from './host/defaults';
export { installEditorFonts } from './host/fonts';

/* The editor's own state, for a host that wants to read the edit or drive it from outside. */
export type {
  EditorPanel,
  EditorPlayer,
  EditorSelection,
  Filmstrip,
  OverlayBitmap,
  ToolbarMode,
  VolumeTarget,
} from './state/editor.types';
export { EditorStore, type PreviewVideoLayer } from './state/editor-store';
export { EditorMedia } from './state/editor-media';
export type { EditorContext } from './bridge/editor-context';
export { OverlayBitmaps } from './state/overlay-bitmap';
export { createEditorRasterContext } from './state/editor-raster-context';
export { computedWith } from './state/computed-with';

/* The catalogues the sheets are built from, so a host can search or preselect without the UI. */
export {
  STICKERS,
  STICKER_CATEGORIES,
  stickerById,
  stickerUrl,
  type StickerAsset,
  type StickerCategory,
} from './data/stickers';
export {
  DEFAULT_TEXT_STYLE_ID,
  TEXT_STYLES,
  TEXT_STYLE_CATEGORIES,
  textStyleById,
  type TextStyleCategory,
  type TextStyleEntry,
} from './data/text-styles';
export { EMOJI_GROUPS, searchEmoji, type EmojiGroup, type EmojiItem } from './data/emoji';

/*
 * Where the package's own files are served from. A wrapper consumer has to call this: the
 * standalone build the wrappers render starts with no resources URL at all, and `host/asset-path.ts`
 * says why the base cannot simply be Stencil's.
 */
export { setEditorAssetPath } from './host/asset-path';

export type * from './components.d.ts';

