import type { RasterisedOverlay } from '../editor';

/** What the customer has picked on the timeline or the preview. At most one thing at a time. */
export type EditorSelection =
  | { kind: 'clip'; id: string }
  | { kind: 'overlay'; id: string }
  | { kind: 'music' }
  | { kind: 'audio'; id: string }
  | { kind: 'voice'; id: string }
  | { kind: 'zoom'; id: string }
  | { kind: 'audioEffect'; id: string };

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
  | 'sound'
  | 'quality'
  | 'transition'
  | 'zoom'
  | 'animation'
  | 'background'
  | 'audioEffects';

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
export type VolumeTarget = { kind: 'clip'; id: string } | { kind: 'music' } | { kind: 'audio'; id: string } | { kind: 'voice'; id: string };

/** The sound the Sound sheet's next pick goes in place of, while a Replace tile has it open. */
export type SoundReplaceTarget = { kind: 'music' } | { kind: 'audio'; id: string };

/**
 * What a video source's own sound is filed under in `store.waveforms`.
 *
 * Prefixed, because that map is keyed by audio URI and a source is named by the host's key. The
 * two namespaces have no reason to agree and every reason not to collide.
 */
export function clipWaveKey(sourceKey: string): string {
  return `clip:${sourceKey}`;
}

/**
 * What the preview plays in the place of everything heard under audio effect layers: the post's sound
 * over the layers' windows and the tail they ring on for, put through them by the render's own
 * arithmetic, as a file this page made (`EditorMedia` makes them; [EditorStore.audioEffectCopies]).
 */
export interface AudioEffectCopy {
  /** A `blob:` URL of the file. */
  url: string;
  /** Where on the post the file's first moment is heard: the first layer's start. */
  startMs: number;
  /** Where the file ends on the post: past the last layer, by as much of the tails as the preview plays. */
  endMs: number;
  /**
   * Everything that went into the file but the layers' own effects, sliders and Slow: the sound under
   * them, and where the layers are. A copy whose sound is what the post's is now is the one to play
   * while a slider's new copy is made; one whose sound is not plays nowhere.
   */
  soundKey: string;
  /** The effects, sliders and Slow it was made with. */
  effectKey: string;
}

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
  /**
   * The frame (`RasterContext.output`) the bitmap was drawn against. Not implied by `key`: an
   * effect's key leaves the frame out, so the effect on screen can have been drawn for a frame the
   * post has since left. A render only places this bitmap, rather than drawing its own, when the
   * frame is the render's.
   */
  frameW: number;
  frameH: number;
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
