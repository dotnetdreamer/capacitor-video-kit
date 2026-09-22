import { Component, Element, Host, Prop, Watch } from '@stencil/core';
import { computed, effect, signal, untracked } from '@preact/signals-core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { stickerById, stickerUrl } from '../../data/stickers';
import {
  MAX_POST_MS,
  MIN_CLIP_MS,
  MIN_LAYER_MS,
  clamp,
  effectPreset,
  findClip,
  findOverlay,
  findVideoTrack,
  moveLayerTo,
  musicSectionMs,
  musicWindow,
  overlayEndMs,
  timelineSlots,
  totalDurationMs,
  trackIdOfClip,
  type ClipDropTarget,
  type EditOverlay,
  type OverlayKind,
} from '../../editor';
import { computedWith } from '../../state/computed-with';
import type { EditorSelection } from '../../state/editor.types';
import {
  musicEndTrim,
  musicStartTrim,
  type ClipReorderDrag,
  type DragBase,
  type EndDrag,
  type TrackDrag,
  type HitKind,
  type LanesScrollDrag,
  type LayerDrag,
  type LayerReorderDrag,
  type MusicDrag,
  type Press,
  type ScrubDrag,
  type TimelineDrag,
  type TrimDrag,
  type VoiceDrag,
} from './timeline-drags';
import {
  LANE_PITCH,
  MAX_PPS,
  MIN_ITEM_PX,
  MIN_PPS,
  SEGMENT_GAP_PX,
  TRACK2_H,
  TRACK_H,
  TRACK_H_COMPACT,
  durationChip,
  dropTargetAt,
  frameUrl,
  nearestSnap,
  snapTargets,
  rulerLabel,
  rulerStepMs,
  segmentTiles,
  touchDistance,
  type DropRow,
  type FilmTile,
} from './timeline-geometry';

/** Movement that turns a press into a scroll or a drag, and cancels a long press. */
const MOVE_SLOP_PX = 8;
const LONG_PRESS_MS = 350;
/** A drag this close to the side of the timeline scrolls it, faster the closer it gets. */
const EDGE_ZONE_PX = 36;
const EDGE_SPEED_PX = 12;
/** The same, for the lanes while a layer is being lifted to another row. */
const LANE_EDGE_PX = 24;
const LANE_AUTO_PX = 6;
/** Seeks to a segment's right edge land this far inside it, so the preview shows ITS last frame. */
const EDGE_FRAME_MS = 50;
/** A scroll with no event for this long, finger up, has come to rest. */
const SCROLL_SETTLE_MS = 160;
/**
 * A press that lands this soon after a fling's last scroll is the press that stopped the fling
 * (touching the screen ends a compositor fling), so it does nothing else on the way up.
 */
const FLING_STOP_MS = 120;
/**
 * The player writes the playhead about every 33 ms while playing. The timeline estimates the time in
 * between from the clock so it scrolls on every frame, but never runs further ahead than this.
 */
const FOLLOW_LEAD_MS = 50;
/** How far the rail of lifted thumbnails slides per frame while the finger holds at an edge. */
const REORDER_RAIL_PX = 6;

/** The add button's own size and the air it keeps, both from the edge of the screen and from the
 *  end of the video it follows. Its width is the usual 44px finger target. */
const ADD_SIZE_PX = 44;
const ADD_GAP_PX = 12;

/*
 * The mouse's three numbers.
 *
 * A wheel reports its delta in one of three units and says which in `deltaMode`; the constants are
 * the DOM's own (0 pixels, 1 lines, 2 pages), written out because `WheelEvent` is not a global in
 * the hydrate build. A "line" is taken as 16px, which is what every browser that still reports
 * lines means by it.
 */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const WHEEL_LINE_PX = 16;
/**
 * How hard a zoom wheel bites: the zoom is multiplied by `e^(-delta / this)`, so one ordinary notch
 * of about 100 moves it by a factor of 1.7 and a trackpad's much smaller deltas move it smoothly.
 * Exponential rather than additive because zoom is a ratio - a step that feels right at 6 pixels
 * per second is imperceptible at 320.
 */
const WHEEL_ZOOM_DIVISOR = 180;

interface SegmentView {
  id: string;
  x: number;
  w: number;
  /** A temporary translate while the left trim handle is held, so nothing slides under the finger. */
  shift: number;
  selected: boolean;
  chip: string;
  tiles: FilmTile[];
  /** Its file could not be opened. The segment says so rather than showing an empty strip. */
  missing: boolean;
}

/**
 * One segment of an extra video layer. It carries no `shift`, because the left trim handle that
 * nudges a segment is the base track's alone: a layer's row can be tapped, and lifted onto another
 * layer, but its edges are not pulled. That is why it is a view of its own rather than a
 * [SegmentView] with the drag parts left empty.
 */
interface TrackSegmentView {
  id: string;
  x: number;
  w: number;
  selected: boolean;
  chip: string;
  tiles: FilmTile[];
  /** Its file could not be opened. The segment says so rather than showing an empty strip. */
  missing: boolean;
}

/** One extra video layer's row, nearest the base track first - the order they are drawn in. */
interface TrackRowView {
  id: string;
  segments: TrackSegmentView[];
}

/**
 * Where a selected thing's two edge handles are drawn, in content px.
 *
 * Always ON its own two edges, so they travel with it as the timeline scrolls instead of standing
 * still against the viewport. An edge that is off the screen is reached by scrolling to it or by
 * zooming out - [MIN_PPS] takes a video over a minute long in at one glance.
 *
 * Placed against the ROW rather than inside the item so that every kind of handle - a segment's, a
 * layer's, a sound's - is positioned by the same arithmetic. A segment is the one that needs it:
 * it is DRAWN narrower than its duration is worth, by the gap it leaves for the cut after it.
 */
interface EdgeHandlesView {
  inX: number;
  outX: number;
}

interface TrimHandlesView extends EdgeHandlesView {
  id: string;
}

/** The same, for a segment's handles, which are drawn in whichever row the segment is on. */
interface ClipHandlesView extends TrimHandlesView {
  trackId: string | null;
}

interface MusicHandlesView extends EdgeHandlesView {
  canTrimEnd: boolean;
}

interface LayerLaneView {
  id: string;
  kind: OverlayKind;
  x: number;
  w: number;
  selected: boolean;
  label: string;
  emoji: string | null;
  image: string | null;
}

interface MusicLaneView {
  x: number;
  w: number;
  label: string;
  selected: boolean;
  canTrimEnd: boolean;
}

interface VoiceLaneView {
  id: string;
  x: number;
  w: number;
  selected: boolean;
}

interface ClipReorderView {
  id: string;
  /** The layer the segment was lifted from: null for the base track. */
  fromTrackId: string | null;
  to: number;
  size: number;
  pitch: number;
  thumbs: { id: string; url: string | null }[];
  liftedUrl: string | null;
  /** The rail's and the lifted tile's positions when the lift began; the drag moves them directly. */
  ox0: number;
  lx0: number;
  ly0: number;
  /** Where the rail is drawn, `.tl`-relative px: on the row the segment came off. */
  railTop: number;
  /** The layer a drop would land on, or null while the drag is still a reorder of its own row. */
  drop: ClipDropTarget | null;
}

interface PinchState {
  startDistance: number;
  distance: number;
  startPps: number;
  /** The time under the centre line when the pinch began; it stays there while the zoom changes. */
  ms: number;
}

/**
 * TikTok's timeline: a ruler, the base video track as a filmstrip, and under it a row for every
 * extra video layer and a lane for every overlay, the sound and the voiceover - all on one
 * horizontal native scroller that moves under a WHITE playhead fixed at the centre. Scrolling IS
 * seeking.
 *
 * A long press lifts a segment, and a lifted segment is two drags in one. Carried SIDEWAYS it
 * reorders the row it came off, which collapses into a rail of square thumbnails to do it. Carried
 * DOWN it leaves that row: the row under the finger lights up, the gap under each row opens a video
 * layer that is not there yet, and letting go puts the segment there. That is the whole of how a
 * post gets more than one picture on the frame from the timeline.
 *
 * Two directions of truth meet here, and keeping them from feeding each other is most of this file:
 *  - the customer's finger (and the fling after it) moves the scroller, which seeks the store;
 *  - everything else - playback, undo, a split, a sheet - moves the store's playhead, which scrolls
 *    the scroller.
 * A scroll only seeks while the customer's own scroll is live (from touchstart until the fling has
 * settled); in every other state a scroll event is ours, and is only used to move the render window.
 *
 * Gestures are handled by delegation on the scroller, with every frame coalesced into one
 * `requestAnimationFrame`. What a touch means is read from the `data-hit` of the element under it.
 * The browser keeps doing what it does best: the content is `touch-action: pan-x`, so a horizontal
 * swipe anywhere is a native, compositor-driven scroll with momentum, while a vertical one is
 * refused by the browser and handed to us as pointer events (Chrome decides the axis from the first
 * movement past the touch slop and zeroes the other axis for the whole gesture) - which is how
 * everything under the base track scrolls vertically, the video layers included, under a fixed ruler
 * and filmstrip without the two directions ever mixing. Handles and selected items are
 * `touch-action: none`, so dragging them never scrolls anything.
 */
@Component({
  tag: 've-timeline',
  styleUrl: 've-timeline.css',
  shadow: true,
})
export class VeTimeline {
  @Prop() ctx!: EditorContext;

  /** The slim arrangement above a compact sheet: the filmstrip only (and the voiceover lane while recording). */
  @Prop() compact = false;

  @Element() el!: HTMLElement;

  private readonly watcher = new SignalWatcher(this);

  /**
   * `compact` again, as a signal. A `@Prop` is a plain field: a computed that read `this.compact`
   * would track nothing and keep its first answer for the life of the element, so every computed
   * below reads this instead.
   */
  private readonly compactSig = signal(false);

  @Watch('compact')
  compactChanged(next: boolean) {
    this.compactSig.value = next;
  }

  /* -- geometry ---------------------------------------------------------------------------- */

  /**
   * Measured once the scroller exists. The timeline spans the screen, so the window's width is the
   * first guess - it keeps the first frame from laying everything out with no padding at all.
   */
  private readonly viewportWidth = signal(typeof window === 'undefined' ? 0 : window.innerWidth);
  /**
   * `scrollLeft` rounded down to half a viewport. The filmstrip and the ruler only render what is
   * near the viewport, and reading this instead of the raw scroll position re-renders them twice a
   * screen's width of scrolling rather than on every frame.
   */
  private readonly scrollChunk = signal(0);

  /**
   * The content width a trim drag started with. Trimming the end shortens the video, and a scroller
   * scrolled to its end would be clamped back under the finger - which the drag would read as the
   * finger moving further, and trim further, and run away. The content keeps its width until the
   * finger lifts.
   */
  private readonly holdWidth = signal(0);

  /**
   * What the cursor is while a drag is live: nothing, the closed hand, or the resize arrows.
   *
   * It is put on the whole timeline rather than on the item being dragged because a drag captures
   * the pointer - the cursor then follows the pointer wherever it goes, including well off the lane
   * it started on, and a hand that turned back into an arrow halfway through a move would read as
   * the drag having been dropped.
   *
   * A signal rather than a field because the class it draws sits on `.tl`, which the vdom owns: a
   * class added by hand would be wiped by the next repaint, and a drag repaints constantly.
   */
  private readonly dragCursor = signal<DragCursor>(null);

  private readonly pad = computed(() => this.viewportWidth.value / 2);
  private readonly totalPx = computed(() => (this.ctx.store.totalMs.value / 1000) * this.ctx.store.pps.value);
  /**
   * The black tail: where the base track's footage stops and where the post does, content px, or
   * null while the two are the same place.
   *
   * Drawn so that the empty stretch reads as deliberate. A timeline that simply ran on past the
   * filmstrip with nothing in it looks like a bug, and a customer who has just dragged the end out
   * needs to see the room they made.
   */
  private readonly tail = computed<{ x: number; w: number } | null>(() => {
    const store = this.ctx.store;
    const baseMs = store.baseMs.value;
    const extraMs = store.totalMs.value - baseMs;
    if (extraMs <= 0) return null;
    const pps = store.pps.value;
    return { x: this.pad.value + (baseMs / 1000) * pps, w: (extraMs / 1000) * pps };
  });
  /**
   * Whether the post is already as short as its footage, so the end grip can only be pulled OUT.
   *
   * The same question [tail] answers by returning null, asked in the one place that has to say it
   * out loud: `startEndDrag` floors the drag at the base track's length, because the grip makes
   * room PAST the footage and never cuts into it. Pulled left at the floor it simply does not move,
   * and nothing on screen said why - which reads as a grip that has failed rather than one that has
   * run out of room. The cursor says it; see `.tl__end--min`.
   */
  private readonly atMinDuration = computed(() => this.tail.value === null);
  private readonly contentWidth = computed(() => Math.max(this.viewportWidth.value + this.totalPx.value, this.holdWidth.value));
  private readonly tileW = computed(() => (this.compactSig.value ? TRACK_H_COMPACT : TRACK_H));

  /** Content px worth rendering: the viewport, a viewport either side, and some. */
  private readonly renderWindow = computed(() => {
    const vw = this.viewportWidth.value || 400;
    const chunk = this.scrollChunk.value;
    return { left: chunk - vw, right: chunk + vw * 2.5 };
  });

  /**
   * The six computeds that rebuild an array all carry a comparison of their own, because the
   * timeline is on screen while the preview's own gestures rewrite the manifest on every frame of a
   * drag. Handing back the previous array is what stops a pinch on a sticker, an opacity drag or a
   * filter change from repainting several hundred filmstrip tiles thirty times a second for a
   * picture that did not move.
   */
  private readonly ruler = computedWith(
    () => {
      const store = this.ctx.store;
      const pps = store.pps.value;
      const total = store.totalMs.value;
      const pad = this.pad.value;
      const stepMs = rulerStepMs(pps);
      const stepPx = (stepMs / 1000) * pps;
      if (!(stepPx > 0)) return { labels: [] as { ms: number; x: number; text: string }[], dotSize: 'auto' };
      const win = this.renderWindow.value;
      const first = Math.max(0, Math.floor((win.left - pad) / stepPx));
      const last = Math.min(Math.floor(total / stepMs), Math.ceil((win.right - pad) / stepPx));
      const labels: { ms: number; x: number; text: string }[] = [];
      for (let i = first; i <= last; i++) {
        const ms = i * stepMs;
        labels.push({ ms, x: pad + i * stepPx, text: rulerLabel(ms) });
      }
      return { labels, dotSize: `${stepPx}px 100%` };
    },
    (a, b) => a.dotSize === b.dotSize && sameList(a.labels, b.labels, (x, y) => x.ms === y.ms && x.x === y.x),
  );

  /**
   * While a left trim handle is held: which ROW is nudged, from which segment, and by how far. The
   * row matters now that every layer has handles of its own - a nudge is one row's ripple, and the
   * others must not move with it.
   */
  private readonly trimShift = signal<{ trackId: string | null; index: number; px: number } | null>(null);

  private readonly segments = computedWith<SegmentView[]>(
    () => {
      const store = this.ctx.store;
      const pps = store.pps.value;
      const pad = this.pad.value;
      const tileW = this.tileW.value;
      const strips = store.filmstrips.value;
      const selection = store.selection.value;
      const win = this.renderWindow.value;
      const shift = this.trimShift.value;
      const slots = store.slots.value;
      const missing = store.unreadable.value;
      return slots.map((slot, i) => {
        const clip = slot.clip;
        const last = i === slots.length - 1;
        const x = pad + (slot.startMs / 1000) * pps;
        const full = (slot.durationMs / 1000) * pps;
        const nudge = shift && shift.trackId === null && i >= shift.index ? shift.px : 0;
        return {
          id: clip.id,
          x,
          w: Math.max(2, last ? full : full - SEGMENT_GAP_PX),
          shift: nudge,
          selected: selection?.kind === 'clip' && selection.id === clip.id,
          chip: durationChip(slot.durationMs),
          tiles: segmentTiles({
            inMs: clip.inMs,
            outMs: clip.outMs,
            speed: clip.speed,
            pps,
            tileW,
            segX: x + nudge,
            winLeft: win.left,
            winRight: win.right,
            strip: strips.get(clip.clipKey),
          }),
          missing: missing.has(clip.clipKey),
        };
      });
    },
    (a, b) =>
      sameList(a, b, (x, y) => x.id === y.id && x.x === y.x && x.w === y.w && x.shift === y.shift && x.selected === y.selected && x.chip === y.chip && sameTiles(x.tiles, y.tiles)),
  );

  /**
   * One row per extra video layer, nearest the base track first, each holding that layer's segments
   * at their real place on the output timeline - offset by the layer's own start, and cut where the
   * base track ends, because the base track's length is the length of the post and the render cuts
   * everything to it.
   *
   * A segment here selects and lifts exactly as one on the base track does: the same tap opens the
   * same tools, and the same long press carries it to another layer. What it has no handles for is
   * trimming, which stays the base track's - an extra layer has a `startMs` of its own and a left
   * trim there is a question about whether the layer moves with the cut or ripples inside it, which
   * is a drag of its own rather than a variation on this one.
   */
  private readonly trackRows = computedWith<TrackRowView[]>(
    () => {
      const store = this.ctx.store;
      // Compact is the slim arrangement above a sheet: the filmstrip, and nothing that is not needed
      // to keep one's place in the video.
      if (this.compactSig.value) return [];
      const tracks = store.videoTrackRows.value;
      if (!tracks.length) return [];
      const pps = store.pps.value;
      const pad = this.pad.value;
      const strips = store.filmstrips.value;
      const selection = store.selection.value;
      const win = this.renderWindow.value;
      const total = store.totalMs.value;
      const shift = this.trimShift.value;

      const missing = store.unreadable.value;
      return tracks.map(track => {
        const segments: TrackSegmentView[] = [];
        for (const slot of timelineSlots({ clips: track.clips })) {
          const startMs = track.startMs + slot.startMs;
          const durationMs = Math.min(slot.durationMs, total - startMs);
          if (durationMs <= 0) continue;
          const clip = slot.clip;
          const nudge = shift && shift.trackId === track.id && slot.index >= shift.index ? shift.px : 0;
          const x = pad + (startMs / 1000) * pps + nudge;
          segments.push({
            id: clip.id,
            x,
            w: Math.max(2, (durationMs / 1000) * pps),
            selected: selection?.kind === 'clip' && selection.id === clip.id,
            chip: durationChip(durationMs),
            tiles: segmentTiles({
              inMs: clip.inMs,
              // The cut above is in OUTPUT time; the strip is grided on SOURCE time, so it is the
              // trim the cut leaves that decides which tiles there are to draw.
              outMs: Math.min(clip.outMs, clip.inMs + durationMs * (clip.speed || 1)),
              speed: clip.speed,
              pps,
              tileW: TRACK2_H,
              segX: x,
              winLeft: win.left,
              winRight: win.right,
              strip: strips.get(clip.clipKey),
            }),
            missing: missing.has(clip.clipKey),
          });
        }
        return { id: track.id, segments };
      });
    },
    (a, b) =>
      sameList(
        a,
        b,
        (x, y) =>
          x.id === y.id &&
          sameList(x.segments, y.segments, (p, q) => p.id === q.id && p.x === q.x && p.w === q.w && p.selected === q.selected && p.chip === q.chip && sameTiles(p.tiles, q.tiles)),
      ),
  );

  /**
   * Where to draw the selected segment's trim handles, or null when there is nothing to trim or too
   * little of the segment is on screen to put a finger on.
   *
   * Each handle is held inside the viewport on ITS OWN side only - the left one never crosses to the
   * right, nor the right one to the left - so the two can neither swap nor stack, and a handle that
   * is pinned says so rather than pretending to be the real edge.
   */
  private readonly trimHandles = computed<ClipHandlesView | null>(() => {
    const store = this.ctx.store;
    const selection = store.selection.value;
    if (selection?.kind !== 'clip') return null;
    const manifest = store.manifest.value;
    const trackId = trackIdOfClip(manifest, selection.id);
    if (trackId === undefined) return null;
    const pps = store.pps.value;
    const shift = this.trimShift.value;
    const nudged = (index: number): number => (shift && shift.trackId === trackId && index >= shift.index ? shift.px : 0);

    if (trackId === null) {
      const slots = store.slots.value;
      const slot = slots.find(s => s.clip.id === selection.id);
      if (!slot) return null;
      const x = this.pad.value + (slot.startMs / 1000) * pps + nudged(slot.index);
      // The width the segment is DRAWN with, gap included, not the width its duration is worth.
      // Every segment but the last gives [SEGMENT_GAP_PX] back to the cut after it, and an end
      // handle placed on the duration instead would stand that far past the border it holds.
      const full = (slot.durationMs / 1000) * pps;
      const last = slot.index === slots.length - 1;
      return { trackId, id: slot.clip.id, ...edgeHandles(x, Math.max(2, last ? full : full - SEGMENT_GAP_PX)) };
    }

    // A layer's segments are drawn with no gap between them and cut where the base track ends, so
    // their handles are placed on the width the row really drew - the same arithmetic `trackRows`
    // uses, for the same reason the base track's handles use the base track's.
    const track = findVideoTrack(manifest, trackId);
    const slot = track && timelineSlots({ clips: track.clips }).find(s => s.clip.id === selection.id);
    if (!track || !slot) return null;
    const startMs = track.startMs + slot.startMs;
    const durationMs = Math.min(slot.durationMs, store.totalMs.value - startMs);
    if (durationMs <= 0) return null;
    const x = this.pad.value + (startMs / 1000) * pps + nudged(slot.index);
    return { trackId, id: slot.clip.id, ...edgeHandles(x, Math.max(2, (durationMs / 1000) * pps)) };
  });

  /** The selected layer's two edge handles, on its own two edges. */
  private readonly layerHandles = computed<TrimHandlesView | null>(() => {
    const lane = this.layerLanes.value.find(l => l.selected);
    return lane ? { id: lane.id, ...edgeHandles(lane.x, lane.w) } : null;
  });

  /** The sound bar's, when it is selected. A looping track has no end to catch. */
  private readonly musicHandles = computed<MusicHandlesView | null>(() => {
    const music = this.musicLane.value;
    return music?.selected ? { canTrimEnd: music.canTrimEnd, ...edgeHandles(music.x, music.w) } : null;
  });

  /** One lane per layer, FRONT-MOST FIRST: the top lane is the layer drawn on top. */
  private readonly layerLanes = computedWith<LayerLaneView[]>(
    () => {
      const store = this.ctx.store;
      const m = store.manifest.value;
      const total = store.totalMs.value;
      const pps = store.pps.value;
      const pad = this.pad.value;
      const selection = store.selection.value;
      const lanes: LayerLaneView[] = [];
      for (let i = m.overlays.length - 1; i >= 0; i--) {
        const overlay = m.overlays[i];
        const start = Math.min(overlay.startMs, total);
        const end = Math.max(start, overlayEndMs(overlay, total));
        lanes.push({
          id: overlay.id,
          kind: overlay.kind,
          x: pad + (start / 1000) * pps,
          w: Math.max(MIN_ITEM_PX, ((end - start) / 1000) * pps),
          selected: selection?.kind === 'overlay' && selection.id === overlay.id,
          ...this.laneContent(overlay),
        });
      }
      return lanes;
    },
    (a, b) =>
      sameList(a, b, (x, y) => x.id === y.id && x.x === y.x && x.w === y.w && x.selected === y.selected && x.label === y.label && x.emoji === y.emoji && x.image === y.image),
  );

  private readonly musicLane = computed<MusicLaneView | null>(() => {
    const store = this.ctx.store;
    const music = store.manifest.value.music;
    if (!music) return null;
    const pps = store.pps.value;
    const { startMs, endMs } = musicWindow(music, store.totalMs.value);
    return {
      x: this.pad.value + (startMs / 1000) * pps,
      w: Math.max(MIN_ITEM_PX, ((endMs - startMs) / 1000) * pps),
      label: music.fileName || 'Sound',
      selected: store.selection.value?.kind === 'music',
      canTrimEnd: !music.loop,
    };
  });

  /** TikTok's "Add sound" bar runs the length of the video, but never shorter than its label. */
  private readonly addSoundWidth = computed(() => Math.max(160, this.totalPx.value));

  private readonly voiceLane = computedWith<VoiceLaneView[]>(
    () => {
      const store = this.ctx.store;
      const pps = store.pps.value;
      const pad = this.pad.value;
      const selection = store.selection.value;
      return store.manifest.value.voiceovers.map(take => ({
        id: take.id,
        x: pad + (take.startMs / 1000) * pps,
        w: Math.max(MIN_ITEM_PX, (take.durationMs / 1000) * pps),
        selected: selection?.kind === 'voice' && selection.id === take.id,
      }));
    },
    (a, b) => sameList(a, b, (x, y) => x.id === y.id && x.x === y.x && x.w === y.w && x.selected === y.selected),
  );

  /** The take being recorded, growing from where it started to the playhead. */
  private readonly recording = computed(() => {
    const store = this.ctx.store;
    const from = store.recordingFromMs.value;
    if (from === null) return null;
    const pps = store.pps.value;
    const to = Math.max(from, store.playheadMs.value);
    return { x: this.pad.value + (from / 1000) * pps, w: Math.max(MIN_ITEM_PX, ((to - from) / 1000) * pps) };
  });

  private readonly showVoiceLane = computed(() => {
    const store = this.ctx.store;
    const any = store.manifest.value.voiceovers.length > 0 || store.recordingFromMs.value !== null;
    return any && (!this.compactSig.value || store.panel.value === 'voiceover');
  });

  private readonly showLanes = computed(() => !this.compactSig.value || this.showVoiceLane.value);

  /**
   * The speaker's state on its own, rather than read off the manifest in the render. The render is
   * the whole of this component's dependency tracking, and a read of `manifest` there would repaint
   * every tile on every frame of a gesture anywhere else in the editor.
   */
  private readonly originalMuted = computed(() => this.ctx.store.manifest.value.originalMuted);

  /* -- reordering -------------------------------------------------------------------------- */

  private readonly clipReorder = signal<ClipReorderView | null>(null);

  /** The other segments' thumbnails, each in the slot it would take if the lifted one landed now. */
  private readonly reorderSlots = computedWith<{ id: string; url: string | null; x: number }[]>(
    () => {
      const r = this.clipReorder.value;
      if (!r) return [];
      return r.thumbs.filter(thumb => thumb.id !== r.id).map((thumb, i) => ({ ...thumb, x: (i < r.to ? i : i + 1) * r.pitch }));
    },
    (a, b) => sameList(a, b, (x, y) => x.id === y.id && x.url === y.url && x.x === y.x),
  );

  private readonly layerReorder = signal<{ id: string; from: number; to: number } | null>(null);

  /* -- gesture state (plain fields: read and written per frame) ------------------------------ */

  private press: Press | null = null;
  private drag: TimelineDrag | null = null;
  private pinch: PinchState | null = null;
  /**
   * The identifiers of the touches that went down on the timeline. `event.touches` counts EVERY
   * finger on the screen, and a finger resting on the preview or on an open sheet is not ours: it
   * must neither start a pinch here nor hold the timeline waiting for a lift it will never hear.
   */
  private readonly ourTouches = new Set<number>();
  /**
   * The nodes those touches began on, each listening for its own end. A touch's end is dispatched to
   * the node it started on, and a lane item that re-renders mid-gesture takes that node out of the
   * document - where the event reaches no listener of ours and the flags below would stay set.
   */
  private readonly touchTargets = new Set<HTMLElement>();
  /** A finger is on the timeline. */
  private touching = false;
  /** When a fling's scroll last ran, so the press that stops the fling can be told from a tap. */
  private flingAt = 0;
  /** The customer's own scroll (or its fling) is live, so scroll events are seeks. */
  private userScrollActive = false;
  /** Set while a drag owns the finger: touchmove's default (a native scroll) is refused. */
  private blockTouchScroll = false;
  private scrollX = 0;
  private laneY = 0;
  private revealedKey = '';

  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private tickRaf = 0;
  private seekRaf = 0;
  private pendingSeekMs: number | null = null;
  private pinchRaf = 0;
  private followRaf = 0;
  private inertiaRaf = 0;
  private unbind: (() => void) | null = null;
  private stopFollowEffect: (() => void) | null = null;
  private stopPlayingEffect: (() => void) | null = null;

  /* -- the elements -------------------------------------------------------------------------- */

  /*
   * One stable function per element rather than a fresh arrow per render: a new value is a changed
   * value to Stencil, and every ref would run again on every repaint. Three of the five elements
   * are behind a condition, and Stencil calls a ref with null on the way out, so each one clears
   * what it held.
   */
  private tlEl?: HTMLDivElement;
  private scrollerEl?: HTMLDivElement;
  private contentEl?: HTMLDivElement;
  private lanesViewEl?: HTMLDivElement;
  private lanesEl?: HTMLDivElement;
  private reorderEl?: HTMLDivElement;

  private readonly keepTl = (el?: HTMLDivElement | null) => {
    this.tlEl = el ?? undefined;
  };
  private readonly keepScroller = (el?: HTMLDivElement | null) => {
    this.scrollerEl = el ?? undefined;
  };
  private readonly keepContent = (el?: HTMLDivElement | null) => {
    this.contentEl = el ?? undefined;
  };
  private readonly keepLanesView = (el?: HTMLDivElement | null) => {
    this.lanesViewEl = el ?? undefined;
  };
  private readonly keepLanes = (el?: HTMLDivElement | null) => {
    this.lanesEl = el ?? undefined;
  };
  private readonly keepReorder = (el?: HTMLDivElement | null) => {
    this.reorderEl = el ?? undefined;
  };

  /* ========================================================================================= */
  /* Lifecycle                                                                                 */
  /* ========================================================================================= */

  connectedCallback() {
    this.startEffects();
    // Stencil does not render an element again when one that has already loaded is put back into
    // the document, so a re-attach would otherwise come back with its listeners gone.
    this.ensureBound();
  }

  componentWillLoad() {
    this.compactSig.value = this.compact;
  }

  componentDidRender() {
    this.ensureBound();
    this.clampLanes();
    // A repaint that changed the length of the video, the zoom, or the width of the screen moves
    // the end the add button follows without any scroll having happened.
    this.placeAdd(this.scrollX);
  }

  disconnectedCallback() {
    this.teardown();
    this.watcher.stop();
  }

  /**
   * The two effects that cannot be a render hook, created here and dropped on the way out.
   *
   * Neither body writes to the store while the store is part way through a change of its own, which
   * is what would make them `deferredEffect` instead: the first only scrolls, and the second only
   * runs when the player starts or stops.
   */
  private startEffects(): void {
    const store = this.ctx.store;

    // The store's playhead moved while nobody is scrolling: bring it under the centre line. This
    // reads `playheadMs`, which the render does not, so it cannot be a render hook - playback, undo
    // and a sheet that moves the playhead would all leave the content where it was.
    this.stopFollowEffect = effect(() => {
      const pps = store.pps.value;
      const playhead = store.playheadMs.value;
      const playing = store.playing.value;
      const width = this.contentWidth.value;
      untracked(() => {
        if (!this.scrollerEl) return;
        // The width the content is about to be laid out with, written now rather than waited for:
        // a scroller near its end clamps `scrollLeft` against the width it has THIS frame, and the
        // clamped value reads back as a seek to the wrong time.
        if (this.contentEl) this.contentEl.style.width = `${width}px`;
        if (this.pinch) {
          this.scrollLaneTo((this.pinch.ms / 1000) * pps, true);
          return;
        }
        // While playing, the frame loop below owns the scroll position.
        if (playing || this.drag || this.userScrollActive) return;
        this.scrollLaneTo((playhead / 1000) * pps, true);
      });
    });

    this.stopPlayingEffect = effect(() => {
      const playing = store.playing.value;
      untracked(() => {
        if (!playing) {
          this.stopFollowLoop();
          return;
        }
        // Play tapped while a fling is still coasting: the fling would keep seeking against the
        // playback. Playback wins, as it does in TikTok.
        if (!this.touching && this.userScrollActive) {
          this.stopFling();
          this.endUserScroll();
        }
        this.startFollowLoop();
      });
    });
  }

  /* ========================================================================================= */
  /* Template helpers                                                                          */
  /* ========================================================================================= */

  /** The other layer lanes slide a row up or down to show where the lifted one would land. */
  private laneShift(index: number): string | null {
    const r = this.layerReorder.value;
    if (!r || index === r.from) return null;
    if (r.from < r.to && index > r.from && index <= r.to) return `translateY(${-LANE_PITCH}px)`;
    if (r.from > r.to && index >= r.to && index < r.from) return `translateY(${LANE_PITCH}px)`;
    return null;
  }

  private readonly addClip = () => {
    const { store, media } = this.ctx;
    if (media.busy.value) return;
    store.pause();
    void media.addClip();
  };

  /** What a layer's lane shows: a line of its text, its sticker, a thumbnail of its photo, its effect. */
  private laneContent(overlay: EditOverlay): Pick<LayerLaneView, 'label' | 'emoji' | 'image'> {
    switch (overlay.kind) {
      case 'text': {
        const line = overlay.text.split('\n').find(l => l.trim()) ?? '';
        return { label: line.trim() || 'Text', emoji: null, image: null };
      }
      case 'sticker':
        // An emoji lane is labelled like every other lane: the glyph on its own said nothing about
        // what the row was, and two emoji lanes looked like two of the same thing.
        if (overlay.emoji) return { label: 'Sticker', emoji: overlay.emoji, image: null };
        return {
          label: (overlay.assetId && stickerById(overlay.assetId)?.label) || 'Sticker',
          emoji: null,
          image: overlay.assetId ? this.stickerImage(overlay.assetId) : null,
        };
      case 'image':
        return { label: 'Photo', emoji: null, image: overlay.uri ? this.ctx.store.host.platform.fileUrl(overlay.uri) : null };
      case 'effect':
        return { label: effectPreset(overlay.effectId)?.label ?? 'Effect', emoji: null, image: null };
    }
  }

  /**
   * A sticker's file, or null when nothing has told the package where its own assets are served
   * from. `stickerUrl` throws in that case rather than handing back a URL that would 404, and a
   * lane is not where that should be discovered: the row still carries its label, so it draws
   * without the picture.
   */
  private stickerImage(assetId: string): string | null {
    try {
      return stickerUrl(assetId);
    } catch {
      return null;
    }
  }

  /* ========================================================================================= */
  /* Listeners                                                                                 */
  /* ========================================================================================= */

  private scroller(): HTMLDivElement {
    // Every caller runs from a listener bound to the scroller or from a loop one of them started,
    // so there is no path here before the first render has put it on screen.
    return this.scrollerEl as HTMLDivElement;
  }

  private ensureBound(): void {
    if (this.unbind || !this.scrollerEl || !this.tlEl) return;
    this.unbind = this.bind(this.scrollerEl, this.tlEl);
  }

  private bind(el: HTMLDivElement, tl: HTMLDivElement): () => void {
    const offs: Array<() => void> = [];
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (event: HTMLElementEventMap[K]) => void, options: AddEventListenerOptions, target: HTMLElement = el): void => {
      target.addEventListener(type, fn, options);
      offs.push(() => target.removeEventListener(type, fn, options));
    };
    const passive = { passive: true };

    on('scroll', this.onScroll, passive);
    on('scrollend', this.onScrollEnd, passive);
    // Touches are heard on the whole timeline, not just the scroller: the add button floats over the
    // filmstrip outside it, and a swipe that starts on the button still scrolls the scroller under
    // it. Heard only on the scroller, that scroll was never the customer's - the content moved while
    // the playhead, the clock and the preview stayed where they were.
    //
    // On `.tl` rather than on the host, because a listener on the host is outside the shadow root:
    // every touch would arrive retargeted to the host, `trackTouch` would refuse it, the per-touch
    // listeners would never be attached and `touching` would stick true the first time a lane item
    // re-rendered mid-gesture - after which every scroll is read as the customer's own.
    on('touchstart', this.onTouchStart, passive, tl);
    // Not passive: a drag and a pinch refuse the native scroll by cancelling touchmove. Chrome only
    // waits on this listener for the first move of a touch, so an ordinary scroll starts as before.
    on('touchmove', this.onTouchMove, { passive: false }, tl);
    on('touchend', this.onTouchEnd, passive, tl);
    on('touchcancel', this.onTouchEnd, passive, tl);
    // Not passive: a plain wheel is the timeline's own scroll and must not also scroll the page,
    // and a ctrl wheel would otherwise zoom the whole WebView, which this layout does not survive.
    on('wheel', this.onWheel, { passive: false });
    on('pointerdown', this.onPointerDown, passive);
    on('pointermove', this.onPointerMove, passive);
    on('pointerup', this.onPointerUp, passive);
    on('pointercancel', this.onPointerCancel, passive);
    // A long press is a reorder here, never the WebView's context menu.
    on('contextmenu', event => event.preventDefault(), { passive: false });

    const resize = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width !== this.viewportWidth.value) this.viewportWidth.value = width;
      this.updateChunk(el.scrollLeft);
    });
    resize.observe(el);
    offs.push(() => resize.disconnect());

    this.viewportWidth.value = el.clientWidth;
    this.scrollX = el.scrollLeft;
    this.updateChunk(this.scrollX);
    return () => offs.forEach(off => off());
  }

  private teardown(): void {
    this.unbind?.();
    this.unbind = null;
    this.stopFollowEffect?.();
    this.stopFollowEffect = null;
    this.stopPlayingEffect?.();
    this.stopPlayingEffect = null;
    this.unbindTouchTargets();
    this.ourTouches.clear();
    this.cancelPress();
    if (this.drag) this.endDrag(true);
    this.pinch = null;
    this.clearSettle();
    this.stopFollowLoop();
    this.stopLaneInertia();
    for (const id of [this.tickRaf, this.seekRaf, this.pinchRaf]) if (id) cancelAnimationFrame(id);
  }

  /* ========================================================================================= */
  /* Scroll = seek                                                                             */
  /* ========================================================================================= */

  private readonly onScroll = (): void => {
    const store = this.ctx.store;
    const el = this.scroller();
    const x = el.scrollLeft;
    this.scrollX = x;
    this.updateChunk(x);

    if (this.pinch) {
      // A pinch that began as a one-finger scroll can still carry the scroll along with its focal
      // point; the time under the centre line is pinned instead.
      const pinned = (this.pinch.ms / 1000) * store.pps.value;
      if (Math.abs(x - pinned) > 1) this.scrollLaneTo(pinned, true);
      return;
    }
    // Everything else that scrolls - playback, a drag's edge auto-scroll, a clamp - is not a seek.
    if (this.drag || !this.userScrollActive) return;
    if (!this.touching) {
      // Nobody is touching and the content is still moving: this is the fling after the swipe.
      this.flingAt = performance.now();
      this.armSettle();
    }

    this.pendingSeekMs = (x / store.pps.value) * 1000;
    if (!this.seekRaf) {
      this.seekRaf = requestAnimationFrame(() => {
        this.seekRaf = 0;
        const ms = this.pendingSeekMs;
        this.pendingSeekMs = null;
        if (ms !== null) store.seek(ms);
      });
    }
  };

  private readonly onScrollEnd = (): void => {
    if (this.touching || this.pinch) return;
    this.endUserScroll();
  };

  private readonly onTouchStart = (event: TouchEvent): void => {
    const store = this.ctx.store;
    // Whatever the browser no longer reports has been lifted, however its end reached us - or did
    // not reach us at all, which is why this runs before every new touch is counted.
    this.reconcileTouches(event.touches);
    for (const touch of Array.from(event.changedTouches)) this.trackTouch(touch);
    this.touching = this.ourTouches.size > 0;
    this.userScrollActive = true;
    this.clearSettle();
    this.stopLaneInertia();
    if (store.playing.value) {
      store.pause();
      // The frame loop runs a few ms ahead of the player's last write; line the content up with
      // the frame playback actually stopped on before the finger starts moving it.
      this.scrollLaneTo((store.playheadMs.value / 1000) * store.pps.value, true);
    }
    const ours = this.ourTouchList(event.touches);
    if (ours.length >= 2 && !this.pinch) this.startPinch(ours);
  };

  private readonly onTouchMove = (event: TouchEvent): void => {
    const pinch = this.pinch;
    if (pinch) {
      const ours = this.ourTouchList(event.touches);
      if (ours.length < 2) return;
      if (event.cancelable) event.preventDefault();
      pinch.distance = touchDistance(ours);
      this.schedulePinch();
      return;
    }
    if (this.blockTouchScroll && event.cancelable) event.preventDefault();
  };

  /**
   * Heard both on the timeline and on each touch's own node, so the same end can arrive twice; every
   * step here is idempotent.
   */
  private readonly onTouchEnd = (event: TouchEvent): void => {
    for (const touch of Array.from(event.changedTouches)) this.ourTouches.delete(touch.identifier);
    this.reconcileTouches(event.touches);
    if (this.pinch && this.ourTouches.size < 2) this.endPinch();
    if (this.ourTouches.size === 0) {
      this.touching = false;
      this.armSettle();
    }
  };

  /** The fingers of `touches` that went down on the timeline, in the order the browser reports them. */
  private ourTouchList(touches: TouchList): Touch[] {
    const ours: Touch[] = [];
    for (let i = 0; i < touches.length; i++) {
      if (this.ourTouches.has(touches[i].identifier)) ours.push(touches[i]);
    }
    return ours;
  }

  private trackTouch(touch: Touch): void {
    const tl = this.tlEl;
    const target = touch.target;
    // Fingers that land on two elements in the same instant can be reported in one event; only the
    // ones that came down on the timeline are the timeline's. Asked of `.tl` rather than of the
    // host, because a shadow tree is not a descendant of its host in the node tree: the host's own
    // `contains` is false for every element this component draws. The host is still accepted, for
    // the browser that hands a listener inside the shadow root a touch retargeted to it anyway.
    if (!tl || !(target instanceof Node) || !(tl.contains(target) || target === this.el)) return;
    this.ourTouches.add(touch.identifier);
    if (!(target instanceof HTMLElement) || target === tl || this.touchTargets.has(target)) return;
    this.touchTargets.add(target);
    target.addEventListener('touchend', this.onTouchEnd, { passive: true });
    target.addEventListener('touchcancel', this.onTouchEnd, { passive: true });
  }

  /** Drops the touches the browser no longer reports, and unbinds the nodes once none are left. */
  private reconcileTouches(touches: TouchList): void {
    if (this.ourTouches.size > 0) {
      const live = new Set<number>();
      for (let i = 0; i < touches.length; i++) live.add(touches[i].identifier);
      for (const id of this.ourTouches) {
        if (!live.has(id)) this.ourTouches.delete(id);
      }
    }
    if (this.ourTouches.size === 0) this.unbindTouchTargets();
  }

  private unbindTouchTargets(): void {
    for (const target of this.touchTargets) {
      target.removeEventListener('touchend', this.onTouchEnd);
      target.removeEventListener('touchcancel', this.onTouchEnd);
    }
    this.touchTargets.clear();
  }

  /** Ends the customer's scroll once nothing has moved for a moment (for WebViews without `scrollend`). */
  private armSettle(): void {
    this.clearSettle();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (!this.touching) this.endUserScroll();
    }, SCROLL_SETTLE_MS);
  }

  /**
   * The customer's scroll is over. Its last seek goes out now rather than a frame later, and if the
   * playhead was moved by something else while the finger held the timeline (the follow is paused
   * for as long as a scroll is live), the content catches up with it.
   */
  private endUserScroll(): void {
    const store = this.ctx.store;
    this.clearSettle();
    if (!this.userScrollActive) return;
    this.userScrollActive = false;
    if (this.seekRaf) {
      cancelAnimationFrame(this.seekRaf);
      this.seekRaf = 0;
    }
    const pending = this.pendingSeekMs;
    this.pendingSeekMs = null;
    if (pending !== null) store.seek(pending);
    if (!store.playing.value && !this.drag && !this.pinch) {
      this.scrollLaneTo((store.playheadMs.value / 1000) * store.pps.value, true);
    }
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  /**
   * Stops a coasting fling. Chrome runs flings on the compositor, where script cannot reach them;
   * a scroller that briefly stops being user-scrollable makes the fling end itself.
   */
  private stopFling(): void {
    const el = this.scrollerEl;
    if (!el) return;
    el.style.overflowX = 'hidden';
    requestAnimationFrame(() => (el.style.overflowX = ''));
  }

  /**
   * Follows playback on every frame. The playhead signal arrives at about 30 Hz; between two writes
   * the time is estimated from the clock, and a write that lands a hair behind the estimate never
   * pulls the content backwards.
   */
  private startFollowLoop(): void {
    if (this.followRaf) return;
    const store = this.ctx.store;
    let seenMs = store.playheadMs.value;
    let seenAt = performance.now();
    let lastTarget = seenMs;
    const step = (now: number): void => {
      this.followRaf = requestAnimationFrame(step);
      if (this.pinch || this.drag || this.userScrollActive) return;
      const ms = store.playheadMs.value;
      if (ms !== seenMs) {
        seenMs = ms;
        seenAt = now;
      }
      let target = Math.min(store.totalMs.value, ms + clamp(now - seenAt, 0, FOLLOW_LEAD_MS));
      if (target < lastTarget && lastTarget - target < FOLLOW_LEAD_MS * 2) target = lastTarget;
      lastTarget = target;
      this.scrollLaneTo((target / 1000) * store.pps.value, false);
    };
    this.followRaf = requestAnimationFrame(step);
  }

  private stopFollowLoop(): void {
    if (this.followRaf) cancelAnimationFrame(this.followRaf);
    this.followRaf = 0;
  }

  /**
   * A programmatic scroll of the lanes. `exact` compares against the element itself (a layout read,
   * fine off the frame loop); otherwise against the last position seen, which is enough to skip
   * no-op writes.
   *
   * Not `scrollTo`: under `dist-custom-elements` a component class IS its element, so that name
   * would replace `Element.prototype.scrollTo` on `<ve-timeline>` with a method of a different
   * shape, and anything scrolling the element from outside would land here instead.
   */
  private scrollLaneTo(x: number, exact: boolean): void {
    const el = this.scrollerEl;
    if (!el) return;
    const current = exact ? el.scrollLeft : this.scrollX;
    if (Math.abs(current - x) < 0.5) return;
    el.scrollLeft = x;
    this.scrollX = x;
    this.updateChunk(x);
  }

  private updateChunk(x: number): void {
    const half = Math.max(80, this.viewportWidth.value / 2);
    const chunk = Math.floor(x / half) * half;
    if (chunk !== this.scrollChunk.value) this.scrollChunk.value = chunk;
    this.placeAdd(x);
  }

  /**
   * Puts the add button just after the end of the video, or against the right edge once the end has
   * been scrolled off past it.
   *
   * On a phone the two are almost always the same place - the filmstrip fills the width - which is
   * why the button could simply live at the right edge. On a monitor they are not: the timeline is
   * three or four times as wide, and scrolling to the end of the video, which is exactly where
   * somebody reaches for "add another clip", left the button most of a screen away from the clip it
   * would be added after.
   *
   * Written as a property rather than through the render because it answers to `scrollLeft`, which
   * changes on every frame of a scroll and is not state the vdom has any business repainting for.
   * The CSS reads it with no fallback on purpose: until this has run, `left` is invalid and the
   * button keeps the `right: 12px` the stylesheet gives it.
   */
  private placeAdd(scrollX: number): void {
    const tl = this.tlEl;
    if (!tl) return;
    const width = this.viewportWidth.value;
    if (width <= 0) return;
    const afterVideo = this.pad.value + this.totalPx.value - scrollX + ADD_GAP_PX;
    const atEdge = width - ADD_SIZE_PX - ADD_GAP_PX;
    tl.style.setProperty('--tl-add-x', `${Math.round(Math.max(0, Math.min(afterVideo, atEdge)))}px`);
  }

  /**
   * The output time under the centre line. Deliberately not clamped to the video's length: while a
   * trim shortens the video the line can sit past the new end, and a line clamped to the end would
   * follow the edge being trimmed and hold it there as a snap target. `seek` clamps on its own.
   */
  private centreMs(pps = this.ctx.store.pps.value): number {
    return Math.max(0, (this.scroller().scrollLeft / pps) * 1000);
  }

  /* ========================================================================================= */
  /* Wheel and trackpad                                                                        */
  /* ========================================================================================= */

  /**
   * What a mouse has instead of a swipe and a pinch.
   *
   * A finger gets both from the browser: the content is `touch-action: pan-x`, so a sideways swipe
   * is a native scroll with a fling on the end of it, and two fingers are a pinch this component
   * reads as a zoom. A mouse gets neither - a vertical wheel over a scroller that only scrolls
   * sideways is left to the browser's own guess about what was meant, and a pinch has no mouse at
   * all - so both are answered here. Ctrl is the zoom modifier every timeline uses, and it is also
   * what a trackpad pinch sends whether or not a key is down; Cmd is the same gesture from a Mac
   * keyboard.
   */
  private readonly onWheel = (event: WheelEvent): void => {
    if (event.cancelable) event.preventDefault();
    if (this.drag || this.pinch) return;
    const store = this.ctx.store;
    this.stopLaneInertia();

    const unit = event.deltaMode === DOM_DELTA_LINE ? WHEEL_LINE_PX : event.deltaMode === DOM_DELTA_PAGE ? this.viewportWidth.value : 1;

    if (event.ctrlKey || event.metaKey) {
      /*
       * Any scrub still in flight is committed first. The effect that re-centres the content at the
       * new zoom stands aside for as long as a scroll of the customer's own is live, so without
       * this the timeline would keep the pixels it had and the picture under the line would stop
       * agreeing with the clock beside it. Committed, that effect puts the playhead back under the
       * centre line at the new scale - which is what makes the zoom happen around the line rather
       * than around the start of the video.
       */
      this.endUserScroll();
      const pps = clamp(store.pps.value * Math.exp((-event.deltaY * unit) / WHEEL_ZOOM_DIVISOR), MIN_PPS, MAX_PPS);
      if (Math.abs(pps - store.pps.value) > 0.01) store.pps.value = pps;
      return;
    }

    // A trackpad reports a sideways swipe as deltaX; a wheel has only deltaY, and the one direction
    // a timeline goes in is along itself. Whichever axis was pushed harder is the one that is meant.
    const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
    if (!delta) return;

    // From here it is the same scroll a finger makes, and it seeks through the same path: the write
    // below fires `scroll`, which seeks for as long as a scroll of the customer's own is live.
    this.userScrollActive = true;
    if (store.playing.value) {
      store.pause();
      this.scrollLaneTo((store.playheadMs.value / 1000) * store.pps.value, true);
    }
    const el = this.scroller();
    this.scrollLaneTo(clamp(el.scrollLeft + delta, 0, Math.max(0, el.scrollWidth - el.clientWidth)), true);
    this.armSettle();
  };

  /* ========================================================================================= */
  /* Pinch zoom                                                                                */
  /* ========================================================================================= */

  private startPinch(touches: readonly Touch[]): void {
    this.cancelPress();
    if (this.drag) this.endDrag(true);
    const distance = touchDistance(touches);
    if (distance < 10) return;
    this.pinch = { startDistance: distance, distance, startPps: this.ctx.store.pps.value, ms: this.centreMs() };
  }

  private schedulePinch(): void {
    if (this.pinchRaf) return;
    this.pinchRaf = requestAnimationFrame(() => {
      this.pinchRaf = 0;
      const pinch = this.pinch;
      if (!pinch) return;
      const store = this.ctx.store;
      const pps = clamp((pinch.startPps * pinch.distance) / pinch.startDistance, MIN_PPS, MAX_PPS);
      // The scroll position follows in the effect above, once the new width is laid out.
      if (Math.abs(pps - store.pps.value) > 0.01) store.pps.value = pps;
    });
  }

  private endPinch(): void {
    if (this.pinchRaf) cancelAnimationFrame(this.pinchRaf);
    this.pinchRaf = 0;
    this.pinch = null;
  }

  /* ========================================================================================= */
  /* Pointers                                                                                  */
  /* ========================================================================================= */

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A second finger belongs to the pinch, which listens to touches.
    if (this.drag || this.press || this.pinch) return;
    this.stopLaneInertia();

    const store = this.ctx.store;
    // `HTMLElement` rather than `Element`, which this file imports from Stencil as the decorator:
    // every hit target here is an ordinary element, and an icon's SVG is inside its own shadow root
    // and arrives retargeted to the `ve-icon` element.
    const target = event.target instanceof HTMLElement ? event.target : null;
    const hitEl = target?.closest<HTMLElement>('[data-hit]') ?? null;
    const kind = (hitEl?.dataset['hit'] as HitKind | undefined) ?? 'empty';
    const id = hitEl?.dataset['id'] ?? null;

    // Handles are drags from the first pixel.
    if (kind === 'clip-in' || kind === 'clip-out') {
      if (id) this.startTrim(this.dragBase(event.pointerId, event.clientX, event.clientY), id, kind === 'clip-in' ? 'in' : 'out');
      return;
    }
    if (kind === 'layer-start' || kind === 'layer-end') {
      if (id) this.startLayerDrag(this.dragBase(event.pointerId, event.clientX, event.clientY), id, kind === 'layer-start' ? 'start' : 'end');
      return;
    }
    if (kind === 'music-start' || kind === 'music-end') {
      this.startMusicDrag(this.dragBase(event.pointerId, event.clientX, event.clientY), kind === 'music-start' ? 'start' : 'end');
      return;
    }
    if (kind === 'end') {
      this.startEndDrag(this.dragBase(event.pointerId, event.clientX, event.clientY));
      return;
    }

    const press: Press = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      kind,
      id,
      x0: event.clientX,
      y0: event.clientY,
      x: event.clientX,
      y: event.clientY,
      inLanes: !!target?.closest('.tl__lanes-view'),
      // The fling is still running a hair before this finger landed, and landing is what stopped it.
      // Never true of a mouse: a compositor fling is something a FINGER stops by touching the
      // screen, and a click a moment after a wheel is a click rather than a brake.
      consumed: event.pointerType !== 'mouse' && this.userScrollActive && performance.now() - this.flingAt < FLING_STOP_MS,
      timer: null,
    };
    // A base segment lifts once there is a second one: with only one, there is nothing to reorder it
    // past and nowhere to carry it either, because the base track may not be emptied. A segment on a
    // layer always lifts - it has the base track and every other layer to go to, and the gap under
    // any of them.
    const canLift = (kind === 'clip' && store.slots.value.length > 1) || kind === 'track-clip' || (kind === 'layer' && store.layerCount.value > 1);
    if (canLift) press.timer = setTimeout(() => this.onLongPress(press), LONG_PRESS_MS);
    this.press = press;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag) {
      if (event.pointerId !== drag.pointerId) return;
      if (drag.kind === 'lanes') {
        const dt = event.timeStamp - drag.lastT;
        if (dt > 0) drag.velocity = drag.velocity * 0.2 + (-(event.clientY - drag.lastY) / dt) * 0.8;
        drag.lastY = event.clientY;
        drag.lastT = event.timeStamp;
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (!drag.moved && Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 2) drag.moved = true;
      this.scheduleTick();
      return;
    }

    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    press.x = event.clientX;
    press.y = event.clientY;
    const dx = press.x - press.x0;
    const dy = press.y - press.y0;
    if (Math.hypot(dx, dy) < MOVE_SLOP_PX) return;

    // Moved: no longer a tap or a long press. A horizontal move on an unselected thing is the
    // browser's scroll, which announces itself with pointercancel; only these two are ours.
    this.cancelPress();
    const vertical = Math.abs(dy) > Math.abs(dx);
    if (!vertical && this.isSelectedBody(press)) {
      this.startBodyDrag(press);
    } else if (vertical && press.inLanes) {
      this.startLanesScroll(press, event);
    } else if (!vertical && press.pointerType === 'mouse') {
      // Sideways, from a mouse, on something that is not a selected item: the timeline itself is
      // being pulled along. A finger never reaches here - the browser has already claimed a
      // horizontal swipe as its own `pan-x` scroll and said so with a pointercancel.
      this.startScrub(press);
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.drag) {
      if (event.pointerId === this.drag.pointerId) this.endDrag(false);
      return;
    }
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    this.cancelPress();
    this.onTap(press);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag && event.pointerId === drag.pointerId) {
      // A reorder the system interrupted is put back; a trim or a move keeps what was shown.
      this.endDrag(drag.kind === 'clip-reorder' || drag.kind === 'layer-reorder');
      return;
    }
    if (this.press?.pointerId === event.pointerId) this.cancelPress();
  };

  private cancelPress(): void {
    if (this.press?.timer) clearTimeout(this.press.timer);
    this.press = null;
  }

  private onTap(press: Press): void {
    // The press that caught a coasting fling has already done its job by stopping it.
    if (press.consumed) return;
    const { store, media } = this.ctx;
    const id = press.id;
    switch (press.kind) {
      case 'mute':
        store.toggleOriginalMuted();
        return;
      case 'add-sound':
        media.openSound();
        return;
      case 'clip':
      // A segment on either layer selects the same way; the tools it opens differ, not the tap.
      case 'track-clip':
        if (id) this.toggleSelection({ kind: 'clip', id });
        return;
      case 'layer':
        if (id) this.toggleSelection({ kind: 'overlay', id });
        return;
      case 'music':
        this.toggleSelection({ kind: 'music' });
        return;
      case 'voice':
        if (id) this.toggleSelection({ kind: 'voice', id });
        return;
      default:
        if (store.selection.value) store.select(null);
    }
  }

  private toggleSelection(selection: EditorSelection): void {
    const store = this.ctx.store;
    store.select(store.isSelected(selection) ? null : selection);
    store.haptic('light');
  }

  private onLongPress(press: Press): void {
    if (this.press !== press || this.drag || this.pinch) return;
    press.timer = null;
    this.press = null;
    if (press.kind === 'clip' || press.kind === 'track-clip') this.startClipReorder(press);
    else if (press.kind === 'layer') this.startLayerReorder(press);
  }

  private isSelectedBody(press: Press): boolean {
    const store = this.ctx.store;
    switch (press.kind) {
      case 'layer':
        return !!press.id && store.isSelected({ kind: 'overlay', id: press.id });
      // A selected segment on a LAYER is a body to drag; one on the base track is not. The base
      // track has no start of its own to move - it is the post - so a sideways drag there is the
      // timeline being pulled along, which is what it has always been.
      case 'track-clip':
        return !!press.id && store.isSelected({ kind: 'clip', id: press.id });
      case 'music':
        return store.musicSelected.value;
      case 'voice':
        return !!press.id && store.isSelected({ kind: 'voice', id: press.id });
      default:
        return false;
    }
  }

  /* ========================================================================================= */
  /* Drags                                                                                     */
  /* ========================================================================================= */

  private dragBase(pointerId: number, x0: number, y0: number): DragBase {
    const el = this.scroller();
    const rect = el.getBoundingClientRect();
    return {
      pointerId,
      x0,
      y0,
      x: x0,
      y: y0,
      scroll0: el.scrollLeft,
      viewLeft: rect.left,
      viewWidth: rect.width,
      snap: null,
      moved: false,
    };
  }

  private beginDrag(drag: TimelineDrag): void {
    this.drag = drag;
    this.dragCursor.value = dragCursor(drag);
    this.blockTouchScroll = true;
    try {
      this.scroller().setPointerCapture(drag.pointerId);
    } catch {
      // The pointer is already gone; pointerup/cancel has been or will be delivered anyway.
    }
    if (drag.moved) this.scheduleTick();
  }

  /**
   * 0, the end of the post, and the start and end of every segment on EVERY row - what clips,
   * layers, sound and voice all snap to. See [snapTargets], which is where the rule is written.
   */
  private snapTargets(): number[] {
    const store = this.ctx.store;
    const manifest = store.manifest.value;
    return snapTargets({
      totalMs: store.totalMs.value,
      rows: [
        { startMs: 0, durationsMs: store.slots.value.map(slot => slot.durationMs) },
        ...manifest.videoTracks.map(track => ({
          startMs: track.startMs,
          durationsMs: timelineSlots({ clips: track.clips }).map(slot => slot.durationMs),
        })),
      ],
    });
  }

  private startTrim(base: DragBase, id: string, edge: 'in' | 'out'): void {
    const store = this.ctx.store;
    const manifest = store.manifest.value;
    const trackId = trackIdOfClip(manifest, id);
    if (trackId === undefined) return;
    const track = trackId === null ? null : findVideoTrack(manifest, trackId);
    if (trackId !== null && !track) return;
    const slot = (track ? timelineSlots({ clips: track.clips }) : store.slots.value).find(s => s.clip.id === id);
    if (!slot) return;
    const trackStart0 = track?.startMs ?? 0;
    store.beginGesture();
    this.holdWidth.value = this.contentWidth.value;
    const drag: TrimDrag = {
      ...base,
      kind: 'trim',
      edge,
      id,
      trackId,
      index: slot.index,
      in0: slot.clip.inMs,
      out0: slot.clip.outMs,
      speed: slot.clip.speed || 1,
      slotStart: trackStart0 + slot.startMs,
      trackStart0,
      movesTrack: track !== null && edge === 'in' && slot.index === 0,
      dur0: slot.durationMs,
      lastValue: edge === 'in' ? slot.clip.inMs : slot.clip.outMs,
    };
    this.beginDrag(drag);
  }

  /**
   * A selected segment on a layer, dragged sideways: the layer goes with it.
   *
   * The whole row and not the one segment, because a track is a sequence with no gaps in it - there
   * is no place inside one for a segment to be moved TO. Carrying a segment somewhere of its own is
   * the long press, which puts it on a layer of its own.
   */
  private startTrackDrag(base: DragBase, clipId: string): void {
    const store = this.ctx.store;
    const trackId = trackIdOfClip(store.manifest.value, clipId);
    if (typeof trackId !== 'string') return;
    const track = findVideoTrack(store.manifest.value, trackId);
    if (!track) return;
    store.beginGesture();
    this.beginDrag({
      ...base,
      kind: 'track',
      trackId,
      start0: track.startMs,
      lengthMs: totalDurationMs({ clips: track.clips }),
      targets: this.snapTargets(),
    });
  }

  /**
   * The grip on the end of the ruler: how long the post runs.
   *
   * `holdWidth` is taken for the reason a trim takes it. The content is as wide as the post, so
   * pulling the end IN shrinks it under a scroller that may be scrolled to it - and a `scrollLeft`
   * clamped back under the finger reads as the finger having moved further, which drags further,
   * which clamps again.
   */
  private startEndDrag(base: DragBase): void {
    const store = this.ctx.store;
    store.beginGesture();
    this.holdWidth.value = this.contentWidth.value;
    const drag: EndDrag = {
      ...base,
      kind: 'end',
      duration0: store.totalMs.value,
      /*
       * The base track's length USED to be the floor, and that is what made this grip feel broken:
       * a post nobody had stretched was already sitting on it, so the one drag anybody tries first
       * - pulling the end in to shorten the video - moved nothing at all and gave no reason why.
       *
       * The floor is now the shortest post there can be. Past the content the grip stops giving
       * back empty tail and starts CUTTING, through every row at once; see [applyEnd] and
       * [cutPostTo].
       */
      minMs: MIN_CLIP_MS,
      targets: this.snapTargets(),
    };
    this.beginDrag(drag);
  }

  private startLayerDrag(base: DragBase, id: string, mode: LayerDrag['mode']): void {
    const store = this.ctx.store;
    const overlay = findOverlay(store.manifest.value, id);
    if (!overlay) return;
    const total = store.totalMs.value;
    store.beginGesture();
    this.beginDrag({
      ...base,
      kind: 'layer',
      mode,
      id,
      start0: Math.min(overlay.startMs, total),
      end0: overlayEndMs(overlay, total),
      targets: this.snapTargets(),
    });
  }

  private startMusicDrag(base: DragBase, mode: MusicDrag['mode']): void {
    const store = this.ctx.store;
    const music = store.manifest.value.music;
    if (!music || (mode === 'end' && music.loop)) return;
    store.beginGesture();
    this.beginDrag({
      ...base,
      kind: 'music',
      mode,
      music0: music,
      end0: musicWindow(music, store.totalMs.value).endMs,
      targets: this.snapTargets(),
    });
  }

  private startBodyDrag(press: Press): void {
    const store = this.ctx.store;
    // From where the finger went down, so the item catches up with the slop instead of lagging it.
    const base = { ...this.dragBase(press.pointerId, press.x0, press.y0), x: press.x, y: press.y, moved: true };
    if (press.kind === 'layer' && press.id) {
      this.startLayerDrag(base, press.id, 'move');
    } else if (press.kind === 'track-clip' && press.id) {
      this.startTrackDrag(base, press.id);
    } else if (press.kind === 'music') {
      this.startMusicDrag(base, 'move');
    } else if (press.kind === 'voice' && press.id) {
      const take = store.selectedVoice.value;
      if (!take || take.id !== press.id) return;
      store.beginGesture();
      const drag: VoiceDrag = {
        ...base,
        kind: 'voice',
        id: take.id,
        start0: take.startMs,
        duration: take.durationMs,
        targets: this.snapTargets(),
      };
      this.beginDrag(drag);
    }
  }

  /**
   * The mouse's answer to a finger's swipe. From where the button went down rather than from where
   * the slop was crossed, so the timeline catches those first pixels up instead of lagging them,
   * and the playback it interrupts stops exactly the way a touch stops it.
   */
  private startScrub(press: Press): void {
    const store = this.ctx.store;
    this.userScrollActive = true;
    this.clearSettle();
    if (store.playing.value) {
      store.pause();
      // The frame loop runs a few ms ahead of the player's last write; line the content up with the
      // frame playback actually stopped on before the mouse starts moving it.
      this.scrollLaneTo((store.playheadMs.value / 1000) * store.pps.value, true);
    }
    this.beginDrag({
      ...this.dragBase(press.pointerId, press.x0, press.y0),
      x: press.x,
      y: press.y,
      moved: true,
      kind: 'scrub',
    });
  }

  private startLanesScroll(press: Press, event: PointerEvent): void {
    const maxY = this.laneMaxY();
    if (maxY <= 0) return;
    const drag: LanesScrollDrag = {
      ...this.dragBase(press.pointerId, press.x0, press.y0),
      x: press.x,
      y: press.y,
      moved: true,
      kind: 'lanes',
      laneY0: this.laneY,
      maxY,
      velocity: 0,
      lastY: event.clientY,
      lastT: event.timeStamp,
    };
    this.beginDrag(drag);
  }

  /**
   * A long press on a segment lifts it, and a lifted segment is two drags in one.
   *
   * SIDEWAYS its own row collapses into a rail of square thumbnails - the lifted one under the
   * finger - because segments can be any width, and a 40-second segment could never be carried past
   * its neighbours on a screen 400 px wide. DOWNWARDS it leaves that row: the rows come back, the
   * one under the finger lights up, and the gap under each of them opens a video layer of its own.
   */
  private startClipReorder(press: Press): void {
    const store = this.ctx.store;
    const id = press.id;
    if (!id) return;
    const manifest = store.manifest.value;
    const trackId = trackIdOfClip(manifest, id);
    if (trackId === undefined) return;
    const track = trackId === null ? null : findVideoTrack(manifest, trackId);
    if (trackId !== null && !track) return;

    const rows = this.videoRows();
    const row = rows.find(r => r.trackId === trackId);
    if (!row) return;

    const slots = timelineSlots({ clips: track ? track.clips : manifest.clips });
    const from = slots.findIndex(slot => slot.clip.id === id);
    if (from < 0) return;

    const base = { ...this.dragBase(press.pointerId, press.x, press.y) };
    const tlTop = this.tlEl?.getBoundingClientRect().top ?? 0;
    // The tiles are square and as tall as the row they came off, which is the whole point of the
    // rail: it reads as the same strip, laid out so a finger can carry one tile past another.
    const size = (trackId === null ? this.tileW.value : TRACK2_H) - 8;
    const pitch = size + 8;
    const rel = press.x - base.viewLeft;
    const originX = rel - (from * pitch + size / 2);
    const railTop = row.top - tlTop + (row.bottom - row.top - size) / 2;
    const strips = store.filmstrips.value;
    const thumbs = slots.map(slot => ({
      id: slot.clip.id,
      url: frameUrl(strips.get(slot.clip.clipKey), slot.clip.inMs),
    }));
    const atMs0 = (track?.startMs ?? 0) + slots[from].startMs;
    const drag: ClipReorderDrag = {
      ...base,
      kind: 'clip-reorder',
      id,
      fromTrackId: trackId,
      from,
      to: from,
      count: slots.length,
      originX,
      size,
      pitch,
      rows,
      tlTop,
      drop: null,
      atMs0,
      atMs: atMs0,
      targets: this.snapTargets(),
    };
    this.beginDrag(drag);
    this.clipReorder.value = {
      id,
      fromTrackId: trackId,
      to: from,
      size,
      pitch,
      thumbs,
      liftedUrl: thumbs[from].url,
      ox0: originX,
      lx0: rel - size / 2,
      ly0: press.y - tlTop - size / 2,
      railTop,
      drop: null,
    };
    store.haptic('medium');
  }

  /**
   * The video rows as they are on the screen, TOP FIRST: the base track's filmstrip, then every
   * layer. Measured when a lift begins and not again - the rows do not move during one, and
   * re-measuring under a finger is how a drop target starts drifting.
   */
  private videoRows(): DropRow[] {
    const nodes = this.contentEl?.querySelectorAll<HTMLElement>('[data-vrow]');
    if (!nodes?.length) return [];
    return Array.from(nodes, node => {
      const rect = node.getBoundingClientRect();
      return { trackId: node.dataset['vrow'] === 'base' ? null : (node.dataset['vrow'] ?? null), top: rect.top, bottom: rect.bottom };
    });
  }

  private startLayerReorder(press: Press): void {
    const store = this.ctx.store;
    const lanes = this.layerLanes.value;
    const from = lanes.findIndex(lane => lane.id === press.id);
    if (!press.id || from < 0 || lanes.length < 2) return;
    const rect = this.lanesViewEl?.getBoundingClientRect();
    const row = this.lanesEl?.querySelector<HTMLElement>(`[data-lane-id="${CSS.escape(press.id)}"]`) ?? null;
    const drag: LayerReorderDrag = {
      ...this.dragBase(press.pointerId, press.x, press.y),
      kind: 'layer-reorder',
      id: press.id,
      from,
      to: from,
      count: lanes.length,
      laneY0: this.laneY,
      viewTop: rect?.top ?? 0,
      viewHeight: rect?.height ?? 0,
      row,
    };
    this.beginDrag(drag);
    const id = press.id;
    this.layerReorder.value = { id, from, to: from };
    store.haptic('medium');
  }

  private scheduleTick(): void {
    if (!this.tickRaf) this.tickRaf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (): void => {
    this.tickRaf = 0;
    const drag = this.drag;
    if (drag && this.applyDrag(drag, true)) this.scheduleTick();
  };

  /** One frame of a drag. Returns whether another frame is wanted while the finger holds still. */
  private applyDrag(drag: TimelineDrag, autoScroll: boolean): boolean {
    switch (drag.kind) {
      case 'trim':
      case 'track':
      case 'end':
      case 'layer':
      case 'music':
      case 'voice': {
        if (!drag.moved) return false;
        const scrolling = autoScroll && this.edgeAutoScroll(drag);
        if (drag.kind === 'trim') this.applyTrim(drag);
        else if (drag.kind === 'track') this.applyTrack(drag);
        else if (drag.kind === 'end') this.applyEnd(drag);
        else if (drag.kind === 'layer') this.applyLayer(drag);
        else if (drag.kind === 'music') this.applyMusic(drag);
        else this.applyVoice(drag);
        return scrolling;
      }
      case 'clip-reorder':
        return this.applyClipReorder(drag, autoScroll);
      case 'layer-reorder':
        return this.applyLayerReorder(drag, autoScroll);
      case 'lanes':
        this.setLaneY(drag.laneY0 - (drag.y - drag.y0), drag.maxY);
        return false;
      case 'scrub':
        this.applyScrub(drag);
        return false;
    }
  }

  /**
   * One frame of a mouse pulling the timeline along: the content moves the way the mouse did, and
   * scrolling the timeline is the same thing as seeking it.
   *
   * The seek is made here rather than left to the `scroll` listener, which stands down for as long
   * as a drag is live - it has to, because a trim's edge auto-scroll is a scroll that is
   * emphatically not a seek. Recomputed from where the button went down and the scroll position it
   * had then, never from the last frame's, so a clamp at either end of the video cannot accumulate.
   */
  private applyScrub(drag: ScrubDrag): void {
    const store = this.ctx.store;
    const el = this.scroller();
    const x = clamp(drag.scroll0 - (drag.x - drag.x0), 0, Math.max(0, el.scrollWidth - el.clientWidth));
    this.scrollLaneTo(x, true);
    store.seek((x / store.pps.value) * 1000);
  }

  /** How far the finger has carried the drag along the timeline, output ms (auto-scroll included). */
  private dragDeltaMs(drag: DragBase, pps: number): number {
    return ((drag.x - drag.x0 + (this.scroller().scrollLeft - drag.scroll0)) / pps) * 1000;
  }

  /**
   * Trimming from a handle. The preview is kept on the edge being cut, and a left trim nudges the
   * segment (and those after it) right by exactly what it lost, so its right edge stays put and the
   * left edge stays under the finger; the ripple happens when the finger lifts.
   */
  private applyTrim(drag: TrimDrag): void {
    const store = this.ctx.store;
    const pps = store.pps.value;
    const deltaMs = this.dragDeltaMs(drag, pps);
    const centre = [this.centreMs(pps)];

    if (drag.edge === 'in') {
      const edge = this.snapEdge(drag, drag.slotStart + deltaMs, centre, pps);
      store.previewTrim(drag.id, drag.in0 + (edge - drag.slotStart) * drag.speed, drag.out0);
      const inMs = findClip(store.manifest.value, drag.id)?.inMs ?? drag.in0;
      const lost = (inMs - drag.in0) / drag.speed;
      if (drag.movesTrack) {
        // The layer starts where its first segment does, so the two move together and everything
        // after stays where it was on the video. There is no nudge to make: the row re-lays itself
        // around the new start on the same frame.
        store.setTrackStart(drag.trackId as string, drag.trackStart0 + lost, true);
      } else {
        const px = (lost / 1000) * pps;
        const shift = this.trimShift.value;
        if (!shift || shift.trackId !== drag.trackId || shift.index !== drag.index || Math.abs(shift.px - px) > 0.1) {
          this.trimShift.value = { trackId: drag.trackId, index: drag.index, px };
        }
      }
      if (inMs !== drag.lastValue) {
        drag.lastValue = inMs;
        store.seek(drag.movesTrack ? edge : drag.slotStart);
      }
      return;
    }

    const edge = this.snapEdge(drag, drag.slotStart + drag.dur0 + deltaMs, centre, pps);
    store.previewTrim(drag.id, drag.in0, drag.out0 + (edge - drag.slotStart - drag.dur0) * drag.speed);
    const clip = findClip(store.manifest.value, drag.id);
    const outMs = clip?.outMs ?? drag.out0;
    if (outMs !== drag.lastValue) {
      drag.lastValue = outMs;
      const duration = (outMs - (clip?.inMs ?? drag.in0)) / drag.speed;
      store.seek(drag.slotStart + Math.max(0, duration - EDGE_FRAME_MS));
    }
  }

  /**
   * One frame of a video layer being carried along the timeline. It keeps its length and whichever
   * of its two edges comes near something sticks to it.
   *
   * It can go no further than the end of the post. The base track is what fixes how long the post
   * runs and everything over it is cut to that, in the preview and in both native engines, so a
   * layer dragged past the end would be a layer that renders as nothing.
   */
  private applyTrack(drag: TrackDrag): void {
    const store = this.ctx.store;
    const pps = store.pps.value;
    const targets = [...drag.targets, this.centreMs(pps)];
    const hi = Math.max(0, store.totalMs.value - MIN_LAYER_MS);
    let start = clamp(drag.start0 + this.dragDeltaMs(drag, pps), 0, hi);
    const hit = nearestSnap([start, start + drag.lengthMs], targets, pps);
    if (hit) start = clamp(start + hit.shiftMs, 0, hi);
    this.noteSnap(drag, hit?.target ?? null);
    store.setTrackStart(drag.trackId, start, true);
  }

  /**
   * One frame of the end being dragged. It sticks to the same edges everything else on the timeline
   * does, the base track's own end among them, so letting the tail go is one gesture rather than a
   * hunt for the pixel where it disappears.
   */
  private applyEnd(drag: EndDrag): void {
    const store = this.ctx.store;
    const pps = store.pps.value;
    const targets = [...drag.targets, this.centreMs(pps)];
    const wanted = clamp(drag.duration0 + this.dragDeltaMs(drag, pps), drag.minMs, MAX_POST_MS);
    const end = clamp(this.snapEdge(drag, wanted, targets, pps), drag.minMs, MAX_POST_MS);
    /*
     * One call for both halves of the drag. `cutPostTo` hands anything at or past the content
     * straight to `setPostDuration`, so pulling OUT still only makes tail and touches no footage;
     * it is only inside the content that it starts cutting. Deciding here instead would mean this
     * file holding its own copy of where the content ends, and getting it a frame out of date.
     */
    store.cutPostTo(end, true);
  }

  private applyLayer(drag: LayerDrag): void {
    const store = this.ctx.store;
    const pps = store.pps.value;
    const total = store.totalMs.value;
    const deltaMs = this.dragDeltaMs(drag, pps);
    const targets = [...drag.targets, this.centreMs(pps)];

    if (drag.mode === 'start') {
      store.previewOverlayWindow(drag.id, this.snapEdge(drag, drag.start0 + deltaMs, targets, pps), drag.end0);
    } else if (drag.mode === 'end') {
      store.previewOverlayWindow(drag.id, drag.start0, this.snapEdge(drag, drag.end0 + deltaMs, targets, pps));
    } else {
      // The whole window moves, keeping its length; whichever edge comes near something sticks.
      const lo = -drag.start0;
      const hi = Math.max(lo, total - drag.end0);
      let shift = clamp(deltaMs, lo, hi);
      const hit = nearestSnap([drag.start0 + shift, drag.end0 + shift], targets, pps);
      if (hit) shift = clamp(shift + hit.shiftMs, lo, hi);
      this.noteSnap(drag, hit?.target ?? null);
      store.previewOverlayWindow(drag.id, drag.start0 + shift, drag.end0 + shift);
    }
  }

  private applyMusic(drag: MusicDrag): void {
    const store = this.ctx.store;
    const pps = store.pps.value;
    const total = store.totalMs.value;
    const deltaMs = this.dragDeltaMs(drag, pps);
    const targets = [...drag.targets, this.centreMs(pps)];
    const music0 = drag.music0;

    if (drag.mode === 'start') {
      store.previewMusic(musicStartTrim(music0, this.snapEdge(drag, music0.startMs + deltaMs, targets, pps), total));
    } else if (drag.mode === 'end') {
      store.previewMusic(musicEndTrim(music0, this.snapEdge(drag, drag.end0 + deltaMs, targets, pps), total));
    } else {
      const hi = Math.max(0, total - MIN_LAYER_MS);
      let start = clamp(music0.startMs + deltaMs, 0, hi);
      // A looping track always ends with the video, and so does one the bar had to cut off - one
      // whose length is unknown, or longer than what is left of the video. The bar's right edge is
      // then the video's end rather than the sound's, and snapping to it would hold the whole bar
      // against a line that is not the sound's at all. Only a section that is known, and really does
      // stop before the video, has an end edge worth offering.
      const section = musicSectionMs(music0);
      const hasEnd = !music0.loop && section > 0 && start + section < total;
      const hit = nearestSnap(hasEnd ? [start, start + section] : [start], targets, pps);
      if (hit) start = clamp(start + hit.shiftMs, 0, hi);
      this.noteSnap(drag, hit?.target ?? null);
      store.previewMusic({ startMs: start });
    }
  }

  private applyVoice(drag: VoiceDrag): void {
    const store = this.ctx.store;
    const pps = store.pps.value;
    const targets = [...drag.targets, this.centreMs(pps)];
    let start = drag.start0 + this.dragDeltaMs(drag, pps);
    const hit = nearestSnap([start, start + drag.duration], targets, pps);
    if (hit) start += hit.shiftMs;
    this.noteSnap(drag, hit?.target ?? null);
    // The op stops the take at its neighbours and the ends of the video.
    store.previewMoveVoice(drag.id, start);
  }

  private snapEdge(drag: DragBase, edgeMs: number, targets: readonly number[], pps: number): number {
    const hit = nearestSnap([edgeMs], targets, pps);
    this.noteSnap(drag, hit?.target ?? null);
    return hit ? hit.target : edgeMs;
  }

  /** One selection tick each time an edge sticks to something new. */
  private noteSnap(drag: DragBase, target: number | null): void {
    if (target !== null && (drag.snap === null || Math.abs(target - drag.snap) > 1)) {
      this.ctx.store.haptic('selection');
    }
    drag.snap = target;
  }

  /** Scrolls the timeline while a drag holds near either side. Returns whether it scrolled. */
  private edgeAutoScroll(drag: DragBase): boolean {
    const rel = drag.x - drag.viewLeft;
    let velocity = 0;
    if (rel < EDGE_ZONE_PX) {
      velocity = -EDGE_SPEED_PX * Math.min(1, (EDGE_ZONE_PX - rel) / EDGE_ZONE_PX);
    } else if (rel > drag.viewWidth - EDGE_ZONE_PX) {
      velocity = EDGE_SPEED_PX * Math.min(1, (rel - drag.viewWidth + EDGE_ZONE_PX) / EDGE_ZONE_PX);
    }
    if (Math.abs(velocity) < 0.5) return false;
    // Never against the finger. A handle pinned to the side of the viewport begins its drag already
    // inside the edge zone, and scrolling from the first frame would pull the timeline one way while
    // the finger pulls the other - the two cancel and the drag does nothing at all. Only a finger
    // that has actually travelled towards the edge is asking for more timeline that way.
    if (velocity > 0 ? drag.x <= drag.x0 : drag.x >= drag.x0) return false;
    const el = this.scroller();
    const next = clamp(el.scrollLeft + velocity, 0, el.scrollWidth - el.clientWidth);
    if (Math.abs(next - el.scrollLeft) < 0.5) return false;
    el.scrollLeft = next;
    return true;
  }

  /**
   * One frame of a lifted segment.
   *
   * Which of the two drags is live is decided from the finger's ROW and nothing else: back on the
   * row it came off, it is a reorder and the rail answers; on any other row, or in a gap between
   * two, it is a move to another video layer. Lifted clear above the whole stack it is neither, and
   * the segment goes back where it was - the one gesture that has always meant "changed my mind".
   */
  private applyClipReorder(drag: ClipReorderDrag, autoScroll: boolean): boolean {
    const store = this.ctx.store;
    const target = dropTargetAt(drag.y, drag.rows);
    if (!target) {
      this.endDrag(true);
      return false;
    }
    const ownRow = (target.kind === 'base' && drag.fromTrackId === null) || (target.kind === 'track' && target.trackId === drag.fromTrackId);
    const drop = ownRow ? null : target;

    const rel = drag.x - drag.viewLeft;
    let scrolling = false;
    if (autoScroll) {
      // Carrying the segment to another layer scrolls the TIMELINE, because where it lands there is
      // a time; reordering its own row slides the RAIL, because where it lands there is an index.
      if (drop) {
        scrolling = this.edgeAutoScroll(drag);
      } else {
        const railEnd = drag.originX + (drag.count - 1) * drag.pitch + drag.size;
        if (rel < EDGE_ZONE_PX && drag.originX < EDGE_ZONE_PX) {
          drag.originX = Math.min(EDGE_ZONE_PX, drag.originX + REORDER_RAIL_PX);
          scrolling = true;
        } else if (rel > drag.viewWidth - EDGE_ZONE_PX && railEnd > drag.viewWidth - EDGE_ZONE_PX) {
          drag.originX = Math.max(drag.viewWidth - EDGE_ZONE_PX - (drag.count - 1) * drag.pitch - drag.size, drag.originX - REORDER_RAIL_PX);
          scrolling = true;
        }
      }
    }

    const root = this.reorderEl;
    root?.style.setProperty('--ox', `${drag.originX}px`);
    root?.style.setProperty('--lx', `${rel - drag.size / 2}px`);
    root?.style.setProperty('--ly', `${drag.y - drag.tlTop - drag.size / 2}px`);

    if (drop) {
      // The sideways half of the drag is still worth something on another layer: it is where the
      // segment lands in TIME. It sticks to the same edges a layer or a sound sticks to.
      const pps = store.pps.value;
      const targets = [...drag.targets, this.centreMs(pps)];
      drag.atMs = Math.max(0, this.snapEdge(drag, drag.atMs0 + this.dragDeltaMs(drag, pps), targets, pps));
    } else {
      const to = clamp(Math.round((rel - drag.originX - drag.size / 2) / drag.pitch), 0, drag.count - 1);
      if (to !== drag.to) {
        drag.to = to;
        store.haptic('selection');
      }
    }

    if (!sameDrop(drag.drop, drop)) {
      drag.drop = drop;
      // A row lighting up is worth a tick of its own: it is a different landing place, not a
      // different place in the same row.
      store.haptic('selection');
    }
    const view = this.clipReorder.value;
    if (view && (view.to !== drag.to || !sameDrop(view.drop, drag.drop))) {
      this.clipReorder.value = { ...view, to: drag.to, drop: drag.drop };
    }
    return scrolling;
  }

  private applyLayerReorder(drag: LayerReorderDrag, autoScroll: boolean): boolean {
    let scrolling = false;
    if (autoScroll) {
      const rel = drag.y - drag.viewTop;
      const max = this.laneMaxY();
      if (rel < LANE_EDGE_PX && this.laneY > 0) {
        this.setLaneY(this.laneY - LANE_AUTO_PX, max);
        scrolling = true;
      } else if (rel > drag.viewHeight - LANE_EDGE_PX && this.laneY < max) {
        this.setLaneY(this.laneY + LANE_AUTO_PX, max);
        scrolling = true;
      }
    }
    const dy = drag.y - drag.y0 + (this.laneY - drag.laneY0);
    drag.row?.style.setProperty('--lift', `${dy}px`);
    const to = clamp(Math.round(drag.from + dy / LANE_PITCH), 0, drag.count - 1);
    if (to !== drag.to) {
      drag.to = to;
      this.ctx.store.haptic('selection');
      this.layerReorder.value = { id: drag.id, from: drag.from, to };
    }
    return scrolling;
  }

  private endDrag(cancelled: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    if (this.tickRaf) {
      cancelAnimationFrame(this.tickRaf);
      this.tickRaf = 0;
      // The finger's last position may not have been applied yet.
      if (
        !cancelled &&
        (drag.kind === 'trim' || drag.kind === 'track' || drag.kind === 'end' || drag.kind === 'layer' || drag.kind === 'music' || drag.kind === 'voice' || drag.kind === 'scrub')
      ) {
        this.applyDrag(drag, false);
      }
    }
    this.drag = null;
    this.dragCursor.value = null;
    this.blockTouchScroll = false;
    const el = this.scroller();
    // The element is taken out of the document before `disconnectedCallback` runs, so a teardown in
    // the middle of a drag arrives here with a scroller that is no longer in it. Such an element
    // reads `scrollLeft` 0, which would look like a scroll all the way back to the start of the
    // video.
    const live = el.isConnected;
    try {
      if (el.hasPointerCapture(drag.pointerId)) el.releasePointerCapture(drag.pointerId);
    } catch {
      // Nothing to release.
    }

    if (drag.kind === 'lanes') {
      const idle = performance.now() - drag.lastT;
      if (live) this.startLaneInertia(idle > 80 ? 0 : drag.velocity, drag.maxY);
      return;
    }

    const scrolled = live && Math.abs(el.scrollLeft - drag.scroll0) >= 1;
    const store = this.ctx.store;
    switch (drag.kind) {
      case 'trim':
        this.trimShift.value = null;
        this.holdWidth.value = 0;
        store.endGesture('Trim');
        break;
      case 'track':
        store.endGesture('Move video');
        break;
      case 'end':
        this.holdWidth.value = 0;
        store.endGesture('Length');
        break;
      case 'layer':
        store.endGesture(drag.mode === 'move' ? 'Move layer' : 'Timing');
        break;
      case 'music':
        store.endGesture('Sound');
        break;
      case 'voice':
        store.endGesture('Move voiceover');
        break;
      case 'clip-reorder':
        this.clipReorder.value = null;
        if (cancelled) break;
        // Another layer, or a layer of its own under the row it was dropped on; otherwise another
        // place in the row it never left.
        if (drag.drop) store.moveClipToTrack(drag.id, drag.drop, drag.atMs);
        else if (drag.to !== drag.from) store.moveClipTo(drag.id, drag.to);
        break;
      case 'layer-reorder': {
        drag.row?.style.removeProperty('--lift');
        this.layerReorder.value = null;
        // Lanes run front-most first; the manifest runs bottom to top.
        const toIndex = drag.count - 1 - drag.to;
        if (!cancelled && drag.to !== drag.from && store.commit('Layer order', m => moveLayerTo(m, drag.id, toIndex))) {
          store.haptic('light');
        }
        break;
      }
    }
    // A trim showed its edge in the preview, and an edge auto-scroll moved the centre line: either
    // way the playhead goes back under the line, which is where the customer is looking. There is no
    // line to go back to once the timeline is gone.
    if (live && ((drag.kind === 'trim' && drag.moved) || scrolled)) store.seek(this.centreMs());
  }

  /* ========================================================================================= */
  /* Lanes, vertically                                                                         */
  /* ========================================================================================= */

  /**
   * The lanes' vertical offset is ours, not the browser's, so it is clamped again whenever the
   * lanes change - and a lane selected from elsewhere (a new text, a sheet) is scrolled into view.
   *
   * Every signal this reads is one the render has just read, which is what makes it a render hook
   * rather than an effect. The dedupe on the key is what keeps it from scrolling the lanes back to
   * the selection on each of the sixty renders a drag elsewhere in the editor costs.
   */
  private clampLanes(): void {
    if (!this.showLanes.value) {
      this.laneY = 0;
      return;
    }
    this.setLaneY(this.laneY);
    const selection = this.ctx.store.selection.value;
    const row = this.selectionRow(selection);
    // The ROW a selection is on and not merely which selection it is. A layer sent to the back, a
    // segment carried onto another video layer, or an undo of either is the same selection on a new
    // row - and with more rows than fit on the screen, that row can be out of sight.
    const key = `${selectionKey(selection)}@${row?.offsetTop ?? -1}`;
    if (key === this.revealedKey) return;
    this.revealedKey = key;
    this.revealRow(row);
  }

  /** The row the selection is drawn on, or null when it has none among the lanes. */
  private selectionRow(selection: EditorSelection | null): HTMLElement | null {
    const lanes = this.lanesEl;
    if (!lanes || !selection) return null;
    switch (selection.kind) {
      case 'overlay':
        return lanes.querySelector<HTMLElement>(`[data-lane-id="${CSS.escape(selection.id)}"]`);
      case 'music':
        return lanes.querySelector<HTMLElement>('[data-row="music"]');
      case 'voice':
        return lanes.querySelector<HTMLElement>('[data-row="voice"]');
      case 'clip': {
        // A segment on the base track is on the fixed row above the lanes, which is always in view.
        const trackId = this.ctx.store.selectedClipTrackId.value;
        return trackId ? lanes.querySelector<HTMLElement>(`[data-vrow="${CSS.escape(trackId)}"]`) : null;
      }
    }
  }

  private laneMaxY(): number {
    const view = this.lanesViewEl;
    const lanes = this.lanesEl;
    return view && lanes ? Math.max(0, lanes.offsetHeight - view.clientHeight) : 0;
  }

  private setLaneY(y: number, max = this.laneMaxY()): void {
    const next = clamp(y, 0, max);
    this.laneY = next;
    const lanes = this.lanesEl;
    if (lanes) lanes.style.transform = next > 0 ? `translate3d(0, ${-next}px, 0)` : '';
  }

  private startLaneInertia(velocity: number, max: number): void {
    this.stopLaneInertia();
    if (Math.abs(velocity) < 0.05) return;
    let v = velocity;
    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(32, now - last);
      last = now;
      const before = this.laneY;
      this.setLaneY(before + v * dt, max);
      v *= Math.pow(0.95, dt / 16);
      if (Math.abs(v) < 0.02 || this.laneY === before) {
        this.inertiaRaf = 0;
        return;
      }
      this.inertiaRaf = requestAnimationFrame(step);
    };
    this.inertiaRaf = requestAnimationFrame(step);
  }

  private stopLaneInertia(): void {
    if (this.inertiaRaf) cancelAnimationFrame(this.inertiaRaf);
    this.inertiaRaf = 0;
  }

  /**
   * Scrolls a row into view, measured off the row itself rather than counted in pitches: the rows
   * are no longer all one height now that the video layers are among them, and a count would put a
   * selection under the fold as soon as one of them had been scrolled past.
   */
  private revealRow(row: HTMLElement | null): void {
    const view = this.lanesViewEl;
    if (!view || !row) return;
    const gap = this.compactSig.value ? 4 : 8;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const height = view.clientHeight;
    if (top < this.laneY) this.setLaneY(top);
    else if (bottom > this.laneY + height) this.setLaneY(bottom - height + gap);
  }

  /* ========================================================================================= */
  /* Render                                                                                    */
  /* ========================================================================================= */

  /**
   * Every conditional block here carries a key, so does every row of every list, and so does every
   * element this file holds on to by hand.
   *
   * The lanes, the two video rows and the four blocks inside the scroller are all `div`s, and
   * Stencil matches unkeyed siblings of the same tag BY POSITION: hiding the ruler in compact mode
   * would patch the ruler's element into the video track's place, taking the filmstrip's images
   * with it. The scroller, the content and the lanes are keyed for the other half of the same
   * reason: each is an element a listener, a measurement or an imperative style is bound to, and a
   * vdom that rebuilt one of them would leave this component driving a node that is no longer on
   * screen. Neither failure throws and both look right for one frame.
   */
  render() {
    return this.watcher.run(() => {
      const store = this.ctx.store;
      const compact = this.compactSig.value;
      const pad = this.pad.value;
      const cursor = this.dragCursor.value;
      const reorder = this.clipReorder.value;
      const trim = this.trimHandles.value;
      const rows = this.trackRows.value;
      const marks = dropMarks(reorder?.drop ?? null, rows);
      const tail = this.tail.value;

      return (
        <Host>
          <div
            class={{
              'tl': true,
              'tl--compact': compact,
              'tl--reordering': reorder !== null,
              'tl--dropping': reorder?.drop != null,
              'tl--drag-move': cursor === 'move',
              'tl--drag-resize': cursor === 'resize',
            }}
            key="tl"
            ref={this.keepTl}
          >
            {/* One native horizontal scroller for every row, so they can never drift apart. */}
            <div class="tl__scroller" key="scroller" ref={this.keepScroller}>
              <div class="tl__content" key="content" ref={this.keepContent} style={{ width: `${this.contentWidth.value}px` }}>
                {compact ? null : this.rulerRow(pad)}

                <div
                  class={{
                    'tl__track': true,
                    'tl__vrow': true,
                    'tl__vrow--source': reorder !== null && reorder.fromTrackId === null,
                    'tl__vrow--drop': marks.on === 0,
                    'tl__vrow--drop-under': marks.under === 0,
                  }}
                  key="track"
                  data-vrow="base"
                >
                  <button
                    type="button"
                    class="tl__mute"
                    data-hit="mute"
                    style={{ left: `${pad - 74}px` }}
                    aria-label={this.originalMuted.value ? 'Turn original sound on' : 'Turn original sound off'}
                  >
                    <ve-icon name={this.originalMuted.value ? 'volume-mute' : 'volume-high'}></ve-icon>
                  </button>

                  {this.segments.value.map(seg => (
                    <div
                      class={{ 'seg': true, 'seg--selected': seg.selected, 'seg--ghost': reorder?.drop != null && reorder.id === seg.id }}
                      key={seg.id}
                      data-hit="clip"
                      data-id={seg.id}
                      style={{ left: `${seg.x}px`, width: `${seg.w}px`, transform: seg.shift ? `translateX(${seg.shift}px)` : undefined }}
                    >
                      {this.segmentInner(seg)}
                    </div>
                  ))}

                  {/*
                    The stretch past the base track's last frame, where the picture is black. Drawn
                    so the room a customer has just made reads as room rather than as a timeline
                    that has run out of filmstrip.
                  */}
                  {tail ? <span class="tl__tail" key="tail" aria-hidden="true" style={{ left: `${tail.x}px`, width: `${tail.w}px` }}></span> : null}

                  {/* Outside the segments, so one set of arithmetic places every handle on the timeline. */}
                  {trim && trim.trackId === null
                    ? [
                        <span class="handle handle--in" key="trim-in" data-hit="clip-in" data-id={trim.id} style={{ left: `${trim.inX}px` }}></span>,
                        <span class="handle handle--out" key="trim-out" data-hit="clip-out" data-id={trim.id} style={{ left: `${trim.outX}px` }}></span>,
                      ]
                    : null}
                </div>

                {this.showLanes.value ? this.lanes(compact, pad, rows, marks, reorder) : null}
              </div>
            </div>

            {/* Fixed over everything, never part of the scrolling content. */}
            <div class="tl__playhead" key="playhead" aria-hidden="true"></div>

            {reorder ? this.reorderRail(reorder) : store.canAddClip.value ? this.addButton() : null}
          </div>
        </Host>
      );
    });
  }

  /**
   * The ruler, and on the end of it the grip that says how long the post runs.
   *
   * Not `aria-hidden` any more, because the grip is a control: it is the only way to make room past
   * the base track, and a row nobody can reach is a feature only a mouse and a finger have.
   */
  private rulerRow(pad: number) {
    const ruler = this.ruler.value;
    return (
      <div class="tl__ruler" key="ruler">
        <div class="tl__ruler-dots" aria-hidden="true" style={{ 'left': `${pad}px`, 'width': `${this.totalPx.value}px`, 'background-size': ruler.dotSize }}></div>
        {ruler.labels.map(label => (
          <span class="tl__ruler-label" aria-hidden="true" key={label.ms} style={{ left: `${label.x}px` }}>
            {label.text}
          </span>
        ))}
        <span
          class={{ 'tl__end': true, 'tl__end--min': this.atMinDuration.value }}
          key="end"
          data-hit="end"
          role="separator"
          aria-label="Video length"
          style={{ left: `${pad + this.totalPx.value}px` }}
        ></span>
      </div>
    );
  }

  /** The filmstrip of one segment, and the border and chip it wears while it is selected. */
  private segmentInner(seg: SegmentView | TrackSegmentView) {
    return [
      <div class="seg__frames" key="frames">
        {seg.tiles.map(tile =>
          tile.url ? (
            // The key is the tile's place on the SOURCE grid and both branches carry the same one:
            // keyed by position instead, every `src` would be repointed each time the render window
            // moved, which is a flash of grey across the whole strip on every chunk of scrolling.
            <img class="seg__tile" key={tile.key} src={tile.url} style={{ left: `${tile.x}px` }} decoding="async" draggable={false} alt="" />
          ) : (
            <span class="seg__tile seg__tile--empty" key={tile.key} style={{ left: `${tile.x}px` }}></span>
          ),
        )}
      </div>,
      seg.selected ? <span class="seg__border" key="border"></span> : null,
      /*
       * The one thing on a segment that is not decoration.
       *
       * Drawn INSTEAD of the duration chip, and whether or not the segment is selected, because a
       * clip whose file has gone is not a detail of the selection - it is the reason the stage is
       * black, and the customer has to see it without hunting for it. An empty filmstrip cannot
       * carry that news: grey tiles are also what a strip that has not finished cutting looks like.
       *
       * It is a button because there IS something to do about it. Replacing keeps the segment's
       * length and every edit made to it, so the post survives its missing clip being swapped for
       * the file the customer still has.
       */
      seg.missing ? (
        <button
          type="button"
          class="seg__missing"
          key="missing"
          aria-label="Replace missing video"
          onClick={event => this.onReplaceMissing(event, seg.id)}
        >
          Video missing
        </button>
      ) : seg.selected ? (
        <span class="seg__chip" key="chip">
          {seg.chip}
        </span>
      ) : null,
    ];
  }

  /**
   * Picks a new file for a clip whose own has gone.
   *
   * The tap is stopped here rather than allowed through, because the segment underneath treats a
   * tap as "select me" and the picker would then open behind a selection change. Selecting first is
   * still needed: replacing acts on the selected clip, and the badge can be tapped on a segment
   * that is not the selected one.
   */
  private onReplaceMissing(event: Event, id: string): void {
    event.stopPropagation();
    this.ctx.store.select({ kind: 'clip', id });
    void this.ctx.media.replaceSelectedClip();
  }

  /**
   * Everything under the base track, on one vertical scroller: the extra video layers first, then a
   * lane for each overlay, the sound and the voiceover.
   *
   * The video layers belong in here rather than in the fixed column above, because there is no cap
   * on how many of them a post may have - fifteen rows of 48 px is three times the whole timeline.
   * Only the ruler and the base track are fixed, which is right: the base track IS the post, and
   * everything else is something laid over it.
   */
  private lanes(compact: boolean, pad: number, rows: TrackRowView[], marks: { on: number; under: number }, reorder: ClipReorderView | null) {
    const layerHandles = this.layerHandles.value;
    const trim = this.trimHandles.value;
    return (
      <div class="tl__lanes-view" key="lanes-view" ref={this.keepLanesView}>
        <div class={{ 'tl__lanes': true, 'tl__lanes--reordering': this.layerReorder.value !== null }} key="lanes" ref={this.keepLanes}>
          {rows.map((row, i) => (
            <div
              class={{
                'tl__track2': true,
                'tl__vrow': true,
                'tl__vrow--source': reorder?.fromTrackId === row.id,
                'tl__vrow--drop': marks.on === i + 1,
                'tl__vrow--drop-under': marks.under === i + 1,
              }}
              key={row.id}
              data-vrow={row.id}
            >
              {row.segments.map(seg => (
                <div
                  class={{
                    'seg': true,
                    'seg--extra': true,
                    'seg--selected': seg.selected,
                    'seg--ghost': reorder?.drop != null && reorder.id === seg.id,
                  }}
                  key={seg.id}
                  data-hit="track-clip"
                  data-id={seg.id}
                  style={{ left: `${seg.x}px`, width: `${seg.w}px` }}
                >
                  {this.segmentInner(seg)}
                </div>
              ))}

              {/* Every layer is trimmed on its own, by the same two handles the base track has. */}
              {trim?.trackId === row.id
                ? [
                    <span class="handle handle--in" key="trim-in" data-hit="clip-in" data-id={trim.id} style={{ left: `${trim.inX}px` }}></span>,
                    <span class="handle handle--out" key="trim-out" data-hit="clip-out" data-id={trim.id} style={{ left: `${trim.outX}px` }}></span>,
                  ]
                : null}
            </div>
          ))}

          {compact
            ? null
            : this.layerLanes.value.map((lane, i) => {
                const shift = this.laneShift(i);
                return (
                  <div
                    class={{ 'lane': true, 'lane--lifted': this.layerReorder.value?.id === lane.id }}
                    key={lane.id}
                    data-lane-id={lane.id}
                    style={shift ? { transform: shift } : undefined}
                  >
                    <div
                      class={{ 'item': true, 'item--selected': lane.selected }}
                      data-hit="layer"
                      data-id={lane.id}
                      data-kind={lane.kind}
                      style={{ left: `${lane.x}px`, width: `${lane.w}px` }}
                    >
                      <span class="item__label">{this.laneLabel(lane)}</span>
                    </div>
                    {lane.selected && layerHandles
                      ? [
                          <span class="handle handle--in" key="layer-in" data-hit="layer-start" data-id={layerHandles.id} style={{ left: `${layerHandles.inX}px` }}></span>,
                          <span class="handle handle--out" key="layer-out" data-hit="layer-end" data-id={layerHandles.id} style={{ left: `${layerHandles.outX}px` }}></span>,
                        ]
                      : null}
                  </div>
                );
              })}

          {compact ? null : this.musicRow(pad)}
          {this.showVoiceLane.value ? this.voiceRow() : null}
        </div>
      </div>
    );
  }

  private laneLabel(lane: LayerLaneView) {
    switch (lane.kind) {
      case 'sticker':
        return [
          lane.emoji ? (
            <span class="item__emoji" key="emoji">
              {lane.emoji}
            </span>
          ) : lane.image ? (
            <img class="item__sticker" key="sticker" src={lane.image} alt="" draggable={false} />
          ) : null,
          <span class="item__text" key="text">
            {lane.label}
          </span>,
        ];
      case 'image':
        return [
          lane.image ? <img class="item__thumb" key="thumb" src={lane.image} alt="" draggable={false} decoding="async" /> : null,
          <span class="item__text" key="text">
            {lane.label}
          </span>,
        ];
      case 'effect':
        return [
          <ve-icon name="sparkles" key="icon"></ve-icon>,
          <span class="item__text" key="text">
            {lane.label}
          </span>,
        ];
      default:
        return (
          <span class="item__text" key="text">
            {lane.label}
          </span>
        );
    }
  }

  private musicRow(pad: number) {
    const music = this.musicLane.value;
    const handles = this.musicHandles.value;
    return (
      <div class="lane" key="music-lane" data-row="music">
        {music ? (
          [
            <div
              class={{ 'item': true, 'item--music': true, 'item--selected': music.selected }}
              key="music"
              data-hit="music"
              style={{ left: `${music.x}px`, width: `${music.w}px` }}
            >
              <span class="item__label">
                <ve-icon name="musical-note"></ve-icon>
                <span class="item__text">{music.label}</span>
              </span>
            </div>,
            handles ? <span class="handle handle--in" key="music-in" data-hit="music-start" style={{ left: `${handles.inX}px` }}></span> : null,
            handles?.canTrimEnd ? <span class="handle handle--out" key="music-out" data-hit="music-end" style={{ left: `${handles.outX}px` }}></span> : null,
          ]
        ) : (
          <button type="button" class="item item--add-sound" key="add-sound" data-hit="add-sound" style={{ left: `${pad}px`, width: `${this.addSoundWidth.value}px` }}>
            <span class="item__label">
              <ve-icon name="musical-note"></ve-icon>
              <span class="item__text">Add sound</span>
            </span>
          </button>
        )}
      </div>
    );
  }

  private voiceRow() {
    const recording = this.recording.value;
    return (
      <div class="lane" key="voice-lane" data-row="voice">
        {this.voiceLane.value.map(take => (
          <div
            class={{ 'item': true, 'item--voice': true, 'item--selected': take.selected }}
            key={take.id}
            data-hit="voice"
            data-id={take.id}
            style={{ left: `${take.x}px`, width: `${take.w}px` }}
            aria-label="Voiceover"
          >
            <span class="item__label">
              <ve-icon name="mic"></ve-icon>
            </span>
          </div>
        ))}
        {recording ? (
          <div class="item item--recording" key="recording" style={{ left: `${recording.x}px`, width: `${recording.w}px` }}>
            <span class="item__label">
              <ve-icon name="mic"></ve-icon>
            </span>
          </div>
        ) : null}
      </div>
    );
  }

  private reorderRail(reorder: ClipReorderView) {
    return (
      <div
        class="tl__reorder"
        key="reorder"
        ref={this.keepReorder}
        aria-hidden="true"
        style={{
          '--size': `${reorder.size}px`,
          '--rail-top': `${reorder.railTop}px`,
          '--ox': `${reorder.ox0}px`,
          '--lx': `${reorder.lx0}px`,
          '--ly': `${reorder.ly0}px`,
        }}
      >
        <div class="tl__reorder-rail" key="rail">
          {this.reorderSlots.value.map(thumb => (
            <div class="rtile" key={thumb.id} style={{ transform: `translateX(${thumb.x}px)` }}>
              {thumb.url ? <img src={thumb.url} alt="" draggable={false} decoding="async" /> : null}
            </div>
          ))}
        </div>
        <div class="rtile rtile--lifted" key="lifted">
          {reorder.liftedUrl ? <img src={reorder.liftedUrl} alt="" draggable={false} decoding="async" /> : null}
        </div>
      </div>
    );
  }

  private addButton() {
    return (
      <button type="button" class="tl__add" key="add" aria-label="Add clip" onClick={this.addClip}>
        <ve-icon name="add"></ve-icon>
      </button>
    );
  }
}

/**
 * Which cursor a drag takes, or null while none is running.
 *
 * An edge being pulled is the resize arrows; everything else - carrying a layer to another time,
 * lifting a segment, scrolling the lanes, pulling the whole timeline along - is the closed hand,
 * because all of them are the same act of having hold of something.
 */
type DragCursor = 'move' | 'resize' | null;

function dragCursor(drag: TimelineDrag): DragCursor {
  if (drag.kind === 'trim' || drag.kind === 'end') return 'resize';
  // A layer's and a sound's two edge modes trim; the third moves the whole window.
  if ((drag.kind === 'layer' || drag.kind === 'music') && drag.mode !== 'move') return 'resize';
  return 'move';
}

/**
 * Which video row a live drop is pointing at, both counted from the base track at 0: `on` is a row
 * the segment would land on, `under` a row a new layer would open beneath. -1 is neither.
 */
function dropMarks(drop: ClipDropTarget | null, rows: readonly TrackRowView[]): { on: number; under: number } {
  if (!drop) return { on: -1, under: -1 };
  if (drop.kind === 'new') return { on: -1, under: drop.index };
  if (drop.kind === 'base') return { on: 0, under: -1 };
  const i = rows.findIndex(row => row.id === drop.trackId);
  return { on: i < 0 ? -1 : i + 1, under: -1 };
}

/** Whether two drop targets name the same landing place, `null` (the segment's own row) included. */
function sameDrop(a: ClipDropTarget | null, b: ClipDropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'track' && b.kind === 'track') return a.trackId === b.trackId;
  if (a.kind === 'new' && b.kind === 'new') return a.index === b.index;
  return true;
}

/** Places the two edge handles of an item spanning `x` to `x + w` in content px. */
function edgeHandles(x: number, w: number): EdgeHandlesView {
  // The white bar stands 16 px into the start handle's 44 px box and 14 px into the end one's, so
  // these are the box positions that put each bar exactly against its edge of the item.
  return { inX: x - 30, outX: x + w - 14 };
}

function selectionKey(selection: EditorSelection | null): string {
  if (!selection) return '';
  return 'id' in selection ? `${selection.kind}:${selection.id}` : selection.kind;
}

/** Element-wise, for the comparisons the array computeds are built with. */
function sameList<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean {
  return a.length === b.length && a.every((item, i) => same(item, b[i]));
}

function sameTiles(a: readonly FilmTile[], b: readonly FilmTile[]): boolean {
  return sameList(a, b, (x, y) => x.key === y.key && x.x === y.x && x.url === y.url);
}
