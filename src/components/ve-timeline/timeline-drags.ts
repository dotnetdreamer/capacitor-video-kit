import { MIN_LAYER_MS, clamp, type ClipDropTarget, type EditMusic } from '../../editor';

import type { DropRow } from './timeline-geometry';

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
  /**
   * A segment on one of the extra video layers. It selects like a segment on the base track and
   * lifts like one; what it has no handles for is trimming, which is still the base track's alone.
   */
  | 'track-clip'
  | 'layer'
  | 'layer-start'
  | 'layer-end'
  | 'music'
  /** The grip on the end of the ruler, which is how long the post runs. */
  | 'end'
  | 'music-start'
  | 'music-end'
  | 'voice';

/** A finger that is down but not yet a drag: it may still become a tap, a long press or a scroll. */
export interface Press {
  pointerId: number;
  /**
   * Which of the three input kinds this is. A mouse is the one that changes what a sideways drag
   * means: a finger or a pen gets the browser's own `pan-x` scroll with its momentum, and a mouse
   * gets nothing at all, so a mouse drag has to be read as a scrub by hand.
   */
  pointerType: string;
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
  /** The row the segment is on: null for the base track. */
  trackId: string | null;
  index: number;
  in0: number;
  out0: number;
  speed: number;
  /** The segment's left edge on the OUTPUT timeline, the layer's own start included. */
  slotStart: number;
  /** That layer's start when the drag began; only a `movesTrack` drag changes it. */
  trackStart0: number;
  /**
   * Whether this handle carries the whole layer with it, which the FIRST segment of a layer's left
   * handle does and nothing else does.
   *
   * A layer has a start of its own, and that start IS its first segment's left edge: trimming the
   * front off without moving it would leave the edge where it was and shrink the layer from the far
   * end instead - a handle pulled one way and a bar shortening the other. So the two move together
   * and the rest of the layer stays where it was on the video, which is exactly what the music bar's
   * left handle has always done. Every other handle ripples inside its own row, as the base track's
   * always have.
   */
  movesTrack: boolean;
  dur0: number;
  /** The last trim value previewed, so the preview is only re-seeked when the frame changes. */
  lastValue: number;
}

/**
 * The end of the POST being pulled out past the base track, or let back in.
 *
 * Past the base track's last frame the picture is black, and the tail is there so that something can
 * be put in it: a second video that plays after the first, a title, a sound that runs on. `minMs` is
 * the base track, which the end may never be dragged inside - the base is the spine of the post, and
 * trimming it by pulling something else is not a trim anybody asked for.
 */
export interface EndDrag extends DragBase {
  kind: 'end';
  duration0: number;
  minMs: number;
  targets: number[];
}

/**
 * A video layer carried along the timeline by a segment on it.
 *
 * The WHOLE layer moves, not the segment under the finger: a track is a sequence with no gaps in it,
 * so its segments have no place of their own to be moved to - what a layer has is one start, and
 * that is what this drag writes.
 */
export interface TrackDrag extends DragBase {
  kind: 'track';
  trackId: string;
  start0: number;
  /** How long the layer runs, so its far edge can stick to something too. */
  lengthMs: number;
  targets: number[];
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

/**
 * A segment lifted by a long press, which is two drags in one.
 *
 * SIDEWAYS it reorders the row it came from, and the row collapses into a rail of square thumbnails
 * to do it - segments can be any width, and a 40-second one could never be carried past its
 * neighbours on a screen 400 px wide. DOWNWARDS (or back up) it leaves that row altogether and is
 * carried to another video layer, or to a layer of its own opened between two rows; the rail goes
 * away there, because what the customer is aiming at is the rows themselves.
 *
 * `drop` is which of the two is live. Null is the rail, and `to` is the answer; anything else is the
 * layer under the finger, and `atMs` is where the segment would land on the output timeline.
 */
export interface ClipReorderDrag extends DragBase {
  kind: 'clip-reorder';
  id: string;
  /** The layer the segment was lifted from: null for the base track. */
  fromTrackId: string | null;
  from: number;
  to: number;
  count: number;
  /** Where the rail of thumbnails starts, relative to the viewport; edge auto-scroll moves it. */
  originX: number;
  size: number;
  pitch: number;
  /** The video rows as they were drawn when the lift began; nothing moves them during one. */
  rows: DropRow[];
  /** The timeline's own top, client px: the origin the lifted thumbnail is placed against. */
  tlTop: number;
  /** Where the layer under the finger is, or null while the finger is still on its own row. */
  drop: ClipDropTarget | null;
  /** Where the segment started on the OUTPUT timeline, and where it would land now. */
  atMs0: number;
  atMs: number;
  /** 0, the end and every segment boundary of the base track, for the drop to stick to. */
  targets: number[];
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

/**
 * A mouse dragging the timeline along, which is the one gesture the browser does not give us: a
 * finger's sideways swipe is a native `pan-x` scroll with a fling on the end of it, and a mouse
 * pressed on a scroller and moved does nothing whatsoever. Everything about it - where it may
 * start, when it ends, what it seeks - is the same as that native scroll; only the pixels have to
 * be moved by hand.
 */
export interface ScrubDrag extends DragBase {
  kind: 'scrub';
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
  | TrackDrag
  | EndDrag
  | LayerDrag
  | MusicDrag
  | VoiceDrag
  | ClipReorderDrag
  | LayerReorderDrag
  | LanesScrollDrag
  | ScrubDrag;

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
