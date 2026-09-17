import { MIN_LAYER_MS, clamp, type EditMusic } from '../../editor';

/*
 * What a finger on the timeline can be doing, and the arithmetic for the drags whose rules are not
 * already an edit op. Every drag keeps the values it STARTED from and recomputes from them on each
 * frame, never from the last previewed manifest: the store's ops clamp, and clamping a value that
 * was itself clamped a frame ago would make an edge drift away from the finger.
 */

/** What the element under a touch is, from its `data-hit` attribute. */
export type HitKind =
  | 'empty'
  | 'mute'
  | 'add-sound'
  | 'clip'
  | 'clip-in'
  | 'clip-out'
  /** A segment on the second video layer. It selects and nothing more - that lane is read-only. */
  | 'track-clip'
  | 'layer'
  | 'layer-start'
  | 'layer-end'
  | 'music'
  | 'music-start'
  | 'music-end'
  | 'voice';

/** A finger that is down but not yet a drag: it may still become a tap, a long press or a scroll. */
export interface Press {
  pointerId: number;
  kind: HitKind;
  id: string | null;
  x0: number;
  y0: number;
  /** Where the finger is now. */
  x: number;
  y: number;
  /** Whether it landed on the lanes, where a vertical swipe scrolls the lanes. */
  inLanes: boolean;
  /**
   * Set when the finger went down on a coasting fling. Landing on the timeline is how a fling is
   * stopped, and stopping one is all that press means: it must not also select, mute or open a
   * picker on the way up.
   */
  consumed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface DragBase {
  pointerId: number;
  /** Where the finger went down and where it is now, client px. */
  x0: number;
  y0: number;
  x: number;
  y: number;
  /** The scroller's `scrollLeft` when the drag began; edge auto-scroll moves it. */
  scroll0: number;
  /** The scroller's client rect, taken once: nothing on the page moves during a drag. */
  viewLeft: number;
  viewWidth: number;
  /** The target the dragged edge is stuck to, so the haptic fires once per snap. */
  snap: number | null;
  moved: boolean;
}

export interface TrimDrag extends DragBase {
  kind: 'trim';
  edge: 'in' | 'out';
  id: string;
  index: number;
  in0: number;
  out0: number;
  speed: number;
  slotStart: number;
  dur0: number;
  /** The last trim value previewed, so the preview is only re-seeked when the frame changes. */
  lastValue: number;
}

export interface LayerDrag extends DragBase {
  kind: 'layer';
  mode: 'start' | 'end' | 'move';
  id: string;
  start0: number;
  end0: number;
  /** 0, the end and every segment boundary. The centre line is added per frame. */
  targets: number[];
}

export interface MusicDrag extends DragBase {
  kind: 'music';
  mode: 'start' | 'end' | 'move';
  music0: EditMusic;
  /** The window's end when the drag began, output ms. */
  end0: number;
  targets: number[];
}

export interface VoiceDrag extends DragBase {
  kind: 'voice';
  id: string;
  start0: number;
  duration: number;
  targets: number[];
}

export interface ClipReorderDrag extends DragBase {
  kind: 'clip-reorder';
  id: string;
  from: number;
  to: number;
  count: number;
  /** Where the rail of thumbnails starts, relative to the viewport; edge auto-scroll moves it. */
  originX: number;
  size: number;
  pitch: number;
}

export interface LayerReorderDrag extends DragBase {
  kind: 'layer-reorder';
  id: string;
  from: number;
  to: number;
  count: number;
  laneY0: number;
  viewTop: number;
  viewHeight: number;
  row: HTMLElement | null;
}

export interface LanesScrollDrag extends DragBase {
  kind: 'lanes';
  laneY0: number;
  maxY: number;
  /** Lanes px per ms, positive when the lanes move up. Smoothed, for the fling on release. */
  velocity: number;
  lastY: number;
  lastT: number;
}

export type TimelineDrag =
  | TrimDrag
  | LayerDrag
  | MusicDrag
  | VoiceDrag
  | ClipReorderDrag
  | LayerReorderDrag
  | LanesScrollDrag;

/**
 * The music's left handle trims the START of what is heard: the track's in point and its place on
 * the timeline move together, so the sound that was under the handle stays where it was on the
 * video. It can go neither before the start of the video nor before the start of the track, and
 * must leave at least [MIN_LAYER_MS] of section.
 */
export function musicStartTrim(music0: EditMusic, newStartMs: number, totalMs: number): Partial<EditMusic> {
  const out = music0.outMs > 0 ? music0.outMs : music0.sourceDurationMs;
  const minDelta = Math.max(-music0.startMs, -music0.inMs);
  const maxDelta = Math.min(
    totalMs - MIN_LAYER_MS - music0.startMs,
    out > 0 ? out - MIN_LAYER_MS - music0.inMs : Number.POSITIVE_INFINITY,
  );
  const delta = Math.round(clamp(newStartMs - music0.startMs, minDelta, Math.max(minDelta, maxDelta)));
  return { startMs: music0.startMs + delta, inMs: music0.inMs + delta };
}

/**
 * The right handle sets how long the section runs. The bar can never run past the video, and the
 * section never past the end of the track. (A looping track has no end handle at all: it always
 * plays to the end of the video.)
 */
export function musicEndTrim(music0: EditMusic, newEndMs: number, totalMs: number): Partial<EditMusic> {
  const maxLength = music0.sourceDurationMs > 0 ? music0.sourceDurationMs - music0.inMs : Number.POSITIVE_INFINITY;
  const length = clamp(Math.min(newEndMs, totalMs) - music0.startMs, MIN_LAYER_MS, Math.max(MIN_LAYER_MS, maxLength));
  return { outMs: Math.round(music0.inMs + length) };
}
