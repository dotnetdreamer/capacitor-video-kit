import type { RasterisedOverlay } from '../editor';

/** What the customer has picked on the timeline or the preview. At most one thing at a time. */
export type EditorSelection =
  | { kind: 'clip'; id: string }
  | { kind: 'overlay'; id: string }
  | { kind: 'music' }
  | { kind: 'voice'; id: string };

/**
 * The sheets that can slide up over the timeline and the toolbar. One at a time; opening one closes
 * whatever was open.
 */
export type EditorPanel =
  | 'text'
  | 'stickers'
  | 'effects'
  | 'filters'
  | 'adjust'
  | 'crop'
  | 'layout'
  | 'speed'
  | 'volume'
  | 'opacity'
  | 'voiceover'
  | 'quality';

/**
 * What the bottom row shows when nothing more specific applies. `root` is the main tool list; the
 * others are the second-level rows a tool opens before anything is selected (TikTok's "Text" row
 * with Add text / Captions, for instance).
 */
export type ToolbarMode = 'root' | 'text';

/**
 * What a volume sheet is adjusting. The clips' own sound has no level of its own - the timeline's
 * speaker and the voiceover sheet turn it on and off - so it is not one of these.
 */
export type VolumeTarget =
  | { kind: 'clip'; id: string }
  | { kind: 'music' }
  | { kind: 'voice'; id: string };

/** Frames cut from one source clip for the filmstrip, one every `stepMs` of SOURCE time. */
export interface Filmstrip {
  stepMs: number;
  /** WebView-loadable URLs, index `i` being the frame at `i * stepMs`. */
  urls: string[];
}

/** A layer's bitmap as the preview shows it and the render will place it. */
export interface OverlayBitmap extends RasterisedOverlay {
  /** [overlayRasterKey] the bitmap was drawn for; a different key means it is stale. */
  key: string;
  /**
   * The layer's `scale` when it was drawn. While a pinch changes the scale faster than bitmaps can
   * be redrawn, the preview stretches the old bitmap by `overlay.scale / bitmap.scale` so the layer
   * follows the fingers, and swaps in the sharp one when it lands.
   */
  scale: number;
}

/**
 * The preview's transport, as the rest of the editor sees it. The preview component owns the media
 * elements and implements this; everything else asks the store, which forwards here.
 */
export interface EditorPlayer {
  /** Moves the playhead. Keeps playing if it was playing. */
  seek(outputMs: number): void;
  play(): void;
  pause(): void;
}
