/**
 * What the rasteriser needs from its host, and what it hands back.
 *
 * The core draws every layer - text, emoji, stickers, photos, effects - but it does not own fonts,
 * sticker files or the way a native path becomes something the WebView can load. The host supplies
 * those through a [RasterContext], once, and both its preview and its render pass the same one.
 */

import type { EditOverlay } from './edit-manifest';

/** A text look: a font plus the few extras a canvas can draw identically everywhere. */
export interface TextStyleSpec {
  id: string;
  label: string;
  /** CSS family name, already declared by the host with `@font-face` (or a system family). */
  family: string;
  /** A full fallback stack appended after `family`. */
  fallback: string;
  weight: number;
  italic?: boolean;
  /** Draws the text in capitals whatever was typed. */
  uppercase?: boolean;
  /** Extra tracking, in em. */
  letterSpacingEm?: number;
  /** A soft glow in the text colour (the "Neon" look). */
  glow?: boolean;
  /** Line height as a multiple of the font size. Defaults to 1.2. */
  lineHeight?: number;
}

export interface RasterContext {
  /** The output frame the bitmaps are drawn for - the render's `output.width/height`. */
  output: { width: number; height: number };
  /** Never throws: an unknown id falls back to the host's default style. */
  textStyle(styleId: string): TextStyleSpec;
  /** A URL the WebView can load for a bundled sticker (SVG or PNG). */
  stickerUrl(assetId: string): string;
  /** A URL the WebView can load for a `file://` / `content://` path (Capacitor's `convertFileSrc`). */
  fileUrl(uri: string): string;
  /**
   * A bitmap already drawn for this layer against exactly this context, or null to have it drawn.
   *
   * Optional, and a host never writes it: the editor fills it in on the context it hands a render,
   * so `toComposeSpec` places the bitmaps the preview is already showing instead of drawing every
   * layer a second time - one after another, on the main thread, while the export screen sits at
   * 0%. It may only answer with a bitmap that drawing the layer again would reproduce byte for byte;
   * anything it is unsure of it answers null for, and that layer is drawn here as it always was.
   */
  drawn?(overlay: EditOverlay): RasterisedOverlay | null;
}

/**
 * A layer drawn to a transparent PNG.
 *
 * `wPx`/`hPx` are the size the layer covers on the OUTPUT frame. The PNG itself may be smaller -
 * an effect made of gradients or grain is drawn at half resolution to keep the bridge payload and
 * the native bitmap budget down, and a layer pinched past the bitmap cap is drawn smaller still -
 * and the native side scales it up to `wPx x hPx`. The preview sizes the image by
 * `wPx / output.width` of its own width, so it does the same.
 *
 * These are the size of the ARTWORK, not of the canvas it happened to be drawn on: a sticker or an
 * emoji has its empty margin trimmed off both sides of each axis and `wPx`/`hPx` shrink with it, so
 * the selection box the editor draws is the picture the customer sees.
 */
export interface RasterisedOverlay {
  /** `data:image/png;base64,...` */
  png: string;
  wPx: number;
  hPx: number;
}

export type EffectCategory = 'basic' | 'film' | 'light' | 'frame';

export interface EffectPreset {
  id: string;
  label: string;
  category: EffectCategory;
}
