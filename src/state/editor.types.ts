import { musicSpeed, normaliseSoundEffectId, normaliseSoundEffectSettings, soundEffectPlaysSpeedAsRecord, type EditMusic, type RasterisedOverlay } from '../editor';

/** What the customer has picked on the timeline or the preview. At most one thing at a time. */
export type EditorSelection =
  | { kind: 'clip'; id: string }
  | { kind: 'overlay'; id: string }
  | { kind: 'music' }
  | { kind: 'audio'; id: string }
  | { kind: 'voice'; id: string }
  | { kind: 'zoom'; id: string };

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

/** The sound the Effects sheet puts through an effect: a sound on a lane, or an older edit's one sound. */
export type SoundEffectTarget = { kind: 'music' } | { kind: 'audio'; id: string };

/** Frames cut from one source clip for the filmstrip, one every `stepMs` of SOURCE time. */
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
 * What a sound's copy through its effect is filed under in `store.soundCopies`, or null for a sound
 * that has none: the effect and the file, since one file through two effects is two copies and two
 * sounds of one file through the same effect - the halves of a cut - are one. Sliders moved off their
 * defaults, and the speed of an effect that plays it as a record does ([soundCopyRate]), follow on a
 * line of their own, since each is another copy; a line break is the one thing no URI holds, so what
 * is before it is always [soundCopyFamily]'s.
 */
export function soundCopyKey(sound: Pick<EditMusic, 'uri' | 'effect' | 'effectSettings' | 'speed'>): string | null {
  const family = soundCopyFamily(sound);
  if (!family) return null;
  const settings = normaliseSoundEffectSettings(sound.effect, sound.effectSettings);
  const rate = soundCopyRate(sound);
  const variant = `${settings ? JSON.stringify(settings) : ''}${rate !== 1 ? `@${rate}` : ''}`;
  return variant ? `${family}\n${variant}` : family;
}

/**
 * What every copy of one file through one effect is filed under, whatever its sliders say: the part
 * of a [soundCopyKey] before its line break, or all of one with none. Any of them is the same sound on
 * the same timeline, near enough to play while the one a slider asked for is still being made.
 */
export function soundCopyFamily(sound: Pick<EditMusic, 'uri' | 'effect'>): string | null {
  const effect = normaliseSoundEffectId(sound.effect);
  return effect ? `${effect}:${sound.uri}` : null;
}

/**
 * The rate a sound's copy is heard at, as a multiple of its file's own: the sound's speed when its
 * effect plays that speed as a record does, since the element plays the copy at it with the pitch let
 * go, and 1 for every other copy, which keeps its pitch whatever its speed. `sound-copy.ts` works the
 * effect out at that rate, so it comes out where the render, which treats the sound after slowing it,
 * puts it.
 */
export function soundCopyRate(sound: Pick<EditMusic, 'effect' | 'speed'>): number {
  return soundEffectPlaysSpeedAsRecord(sound.effect) ? musicSpeed(sound) : 1;
}

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
