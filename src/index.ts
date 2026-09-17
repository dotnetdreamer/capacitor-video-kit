/**
 * `choisy-video-kit/ui`: the editor's public surface, everything in it that is not a component.
 *
 * It is a subpath rather than the package root because the root is the Capacitor plugin, which a
 * React or Vue host never wants and which imports `@capacitor/core` statically. Nothing here does.
 *
 * Components are deliberately not exported from here either. A host reaches them through the
 * wrapper for its own framework, or through `choisy-video-kit/loader` when it wants a script tag
 * and no build step. What belongs here is the rest of the public surface: the host interface the
 * editor is handed, the types a caller needs to read a result, and the two functions that have to
 * run before the editor renders.
 */


/*
 * What the host supplies. Only the resolver and the browser defaults are values; the rest is the
 * shape a host implements.
 */
export type {
  ConfirmRequest,
  EditorCancelReason,
  EditorKeyboardHost,
  EditorMediaHost,
  EditorPlatformHost,
  EditorRenderHost,
  EditorSource,
  EditorVoiceHost,
  HapticKind,
  PickedAudio,
  PickedImage,
  RenderFailureCode,
  RenderRequest,
  ResolvedEditorHost,
  ResolvedPlatformHost,
  ThumbnailRequest,
  VideoEditorHost,
  VideoEditorResult,
} from './host/host.types';
export { RenderFailedError } from './host/host.types';
export { browserMediaHost, resolveEditorHost, visualViewportKeyboard } from './host/defaults';
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

