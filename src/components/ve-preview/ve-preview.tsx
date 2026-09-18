import { Component, Element, Host, Prop } from '@stencil/core';
import { computed, signal } from '@preact/signals-core';

import { deferredEffect } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { OVERLAY_BASE, isOverlayVisibleAt, type EditFit } from '../../editor';
import { orWhole, pictureBox, sourceFrameBox, type FrameBox } from '../../state/clip-framing';
import { computedWith } from '../../state/computed-with';
import type { PreviewVideoLayer } from '../../state/editor-store';
import type { EditorPlayer } from '../../state/editor.types';
import {
  NO_GUIDES,
  OverlayGestures,
  chromeBounds,
  handleSpot,
  layerBox,
  layerTransform,
  type ChromeBounds,
  type SelectionHandle,
  type SnapGuides,
} from './overlay-gestures';
import { PreviewPlayer } from './preview-player';

/** One layer as the render places it. Positions and sizes are percentages of the frame. */
interface LayerView {
  id: string;
  effect: boolean;
  png: string;
  left: number;
  top: number;
  width: number;
  /** CSS `aspect-ratio`. */
  aspect: string;
  transform: string;
  opacity: number;
}

interface SelectionView {
  /**
   * What the box is around. A LAYER gets all three handles; a CLIP gets the corner that resizes and
   * turns it, and a top-left corner that puts it back over the whole frame instead of deleting it -
   * a segment is deleted from the timeline, never by a gesture whose whole point was to move it.
   */
  kind: 'overlay' | 'clip';
  isText: boolean;
  /** The layer is selected but its time window has left the playhead, so it is not on screen. */
  ghost: boolean;
  left: number;
  top: number;
  width: number;
  aspect: string;
  transform: string;
  /** Keeps the handle icons upright on a turned layer. */
  iconTransform: string;
  /** Per handle, the CSS translation that holds it on the preview; see [handleSpot]. */
  shiftDelete: string;
  shiftEdit: string;
  shiftTransform: string;
}

interface PlaceholderView {
  left: number;
  top: number;
  fontSize: string;
  transform: string;
}

/** A box on the frame as the render writes it: percentages, because the frame's size is the CSS's business. */
interface BoxView {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a layer's `<video>` element is put, how it fills the box it is given, and what cuts it off. */
interface VideoView extends BoxView {
  objectFit: 'contain' | 'cover' | 'fill';
  /** `none` when the frame's own `overflow: hidden` is the only edge there is; see [videoView]. */
  clipPath: string;
  /** The layer's own, over the whole of it. The base track's is always 1. */
  opacity: number;
  /** `none` for an upright layer, so nothing is composited that does not have to be. */
  transform: string;
  /** What the transform turns ABOUT, in the element's own box; see [videoView]. */
  transformOrigin: string;
}

function sameBox(a: BoxView, b: BoxView): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function sameView(a: VideoView, b: VideoView): boolean {
  return (
    sameBox(a, b) &&
    a.objectFit === b.objectFit &&
    a.clipPath === b.clipPath &&
    a.opacity === b.opacity &&
    a.transform === b.transform &&
    a.transformOrigin === b.transformOrigin
  );
}

/**
 * One extra video TRACK as the template draws it: which element, where it goes, what is in it.
 *
 * Per track and not per layer under the playhead, which is the difference between an element that
 * lives as long as the track does and one that is created and destroyed every time the playhead
 * crosses a gap in it. `layer` is null in those gaps: the element stays in the DOM, paused and
 * hidden, keeping its source and its last decoded frame, so coming back costs a seek rather than
 * another load and another black flash.
 */
interface ExtraLayerView {
  trackId: string;
  layer: PreviewVideoLayer | null;
  box: VideoView;
  picture: BoxView;
}

/**
 * Whether two lists of layers would be DRAWN the same, entry for entry.
 *
 * The playhead writes thirty times a second and almost none of those writes move anything: without
 * this every one of them would rebuild every layer's box and hand the vdom a new style object per
 * element per frame.
 */
function sameLayerViews(a: readonly ExtraLayerView[], b: readonly ExtraLayerView[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((one, i) => {
    const other = b[i];
    return (
      one.trackId === other.trackId &&
      one.layer?.clipId === other.layer?.clipId &&
      sameView(one.box, other.box) &&
      sameBox(one.picture, other.picture)
    );
  });
}

/** Whether two layers would be DRAWN the same. `sourceMs` is left out on purpose: it moves with the
    playhead 30 times a second, and only the elements playing the layers care where it has got to. */
function sameFraming(a: PreviewVideoLayer | null, b: PreviewVideoLayer | null): boolean {
  return (
    a?.clipId === b?.clipId &&
    a?.crop === b?.crop &&
    a?.rect === b?.rect &&
    a?.fit === b?.fit &&
    a?.opacity === b?.opacity
  );
}

/** The base track's layer: the one the preview has drawn all along. */
function baseLayerOf(layers: readonly PreviewVideoLayer[]): PreviewVideoLayer | null {
  return layers.find((layer) => layer.trackId === null) ?? null;
}

/**
 * The video layer over the base one, or null when no layer has anything on screen at this instant.
 *
 * The FRONT-MOST of them, which with one layer is the only one and with several is the one whose
 * picture is really on top. This element is the preview's second and last decoder (see the note on
 * the class), so with three videos on the frame it can show two of them, and the two it shows are
 * the base and whatever is drawn over everything else. The render draws them all.
 */
function extraLayerOf(layers: readonly PreviewVideoLayer[]): PreviewVideoLayer | null {
  // `previewLayers` is sorted bottom to top, so the last one that is not the base is the front one.
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].trackId !== null) return layers[i];
  }
  return null;
}

/**
 * The video at the top of the editor: the edit played back live, every layer drawn over it as the
 * bitmap the render will place, and the layers moved, scaled and turned by hand right on the frame.
 *
 * Nothing here is a rendering of its own. The video is the ORIGINAL clips on one `<video>` element
 * per video track with the filter as CSS, and each layer is the PNG `OverlayBitmaps` rasterised for
 * it - so where a layer sits here, at the size it shows, is where the finished video has it.
 *
 * ONE ELEMENT PER LAYER, with no cap on how many. It was two - the base and the front-most layer -
 * because a phone decodes two video streams comfortably and the feed behind this editor may already
 * hold one. What that cost was worse than the decoders it saved: a post with three layers showed
 * the first and the third, and somebody who split a clip and pushed half of it onto a layer of its
 * own watched it vanish from the preview while the timeline went on showing it and the export went
 * on including it. An editor that draws most of the post is not a preview of anything.
 *
 * So every layer is drawn, and the cost is a hardware decoder each. A customer who stacks more of
 * them than their phone can decode will see that happen; that is a post they built, and the honest
 * thing is to show it to them rather than to leave one out and say nothing.
 *
 * It is also the editor's player: the store forwards every play, pause and seek here. `seek`, `play`
 * and `pause` are therefore plain methods and not `@Method()`s, because a `@Method()` has to return
 * a promise and the store's [EditorPlayer] is synchronous - the store is this component's public
 * API, and the element carries nothing but `ctx`.
 *
 * Scoped rather than shadow, which is the one exception in the package. `chromeBounds` measures the
 * host's own box through `stage.parentElement` to work out how far into the letterbox band a
 * selection handle may hang, and inside a shadow root that parent is null: the fallback clamps every
 * handle to the frame, with no error and nothing failing, and the two regressions `HANDLE_EDGE_PX`
 * exists to prevent are back. Scoped also keeps both `<video>` elements in the light DOM, which is
 * where WKWebView composites them today.
 */
@Component({
  tag: 've-preview',
  styleUrl: 've-preview.css',
  shadow: false,
  scoped: true,
})
export class VePreview implements EditorPlayer {
  @Element() el!: HTMLElement;

  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  /* -- the elements ------------------------------------------------------------------------ */

  /*
   * Ref callbacks rather than queries, and one stable arrow each: a new function is a changed value
   * to the vdom, which would take the ref off and put it back on every repaint. Stencil calls a ref
   * with the element when it is created and with null when it is removed, so the two optional ones
   * say for themselves whether the second track is on screen.
   */
  private stageEl?: HTMLDivElement;
  private videoEl?: HTMLVideoElement;
  private holdEl?: HTMLCanvasElement;
  /** One `<video>`/`<canvas>` pair per extra video layer, by track id. */
  private readonly extraEls = new Map<string, { video: HTMLVideoElement | null; hold: HTMLCanvasElement | null }>();
  /** What each track's element was last attached to the player as, so a repaint does not re-attach. */
  private readonly attachedExtras = new Map<string, HTMLVideoElement>();
  private readonly extraRefs = new Map<string, { video: (el?: HTMLElement) => void; hold: (el?: HTMLElement) => void }>();
  private musicEl?: HTMLAudioElement;
  private voiceEl?: HTMLAudioElement;

  private readonly keepStage = (el?: HTMLElement) => {
    this.stageEl = el as HTMLDivElement | undefined;
  };
  private readonly keepVideo = (el?: HTMLElement) => {
    this.videoEl = el as HTMLVideoElement | undefined;
  };
  private readonly keepHold = (el?: HTMLElement) => {
    this.holdEl = el as HTMLCanvasElement | undefined;
  };
  /**
   * The ref pair for one layer, made once per track id and never again.
   *
   * Cached because a fresh arrow every render is a CHANGED ref to the vdom, which tears the old one
   * down and puts the new one up on every repaint - and every one of those teardowns would take the
   * layer's element away from the player and hand it back, which is a load and a black flash per
   * frame of playback.
   */
  private refsFor(trackId: string): { video: (el?: HTMLElement) => void; hold: (el?: HTMLElement) => void } {
    const known = this.extraRefs.get(trackId);
    if (known) return known;
    const made = {
      video: (el?: HTMLElement) => this.keepExtra(trackId, 'video', el),
      hold: (el?: HTMLElement) => this.keepExtra(trackId, 'hold', el),
    };
    this.extraRefs.set(trackId, made);
    return made;
  }

  private keepExtra(trackId: string, which: 'video' | 'hold', el?: HTMLElement): void {
    const pair = this.extraEls.get(trackId) ?? { video: null, hold: null };
    if (which === 'video') pair.video = (el as HTMLVideoElement | undefined) ?? null;
    else pair.hold = (el as HTMLCanvasElement | undefined) ?? null;
    if (pair.video || pair.hold) this.extraEls.set(trackId, pair);
    else this.extraEls.delete(trackId);
  }
  private readonly keepMusic = (el?: HTMLElement) => {
    this.musicEl = el as HTMLAudioElement | undefined;
  };
  private readonly keepVoice = (el?: HTMLElement) => {
    this.voiceEl = el as HTMLAudioElement | undefined;
  };

  /* -- gesture feedback, written by OverlayGestures ---------------------------------------- */

  /** True while the hold canvas covers the video, i.e. across a source change. One per element. */
  readonly holding = signal(false);
  /** The same for every extra layer, by track id: a set holds only the ones that are holding. */
  readonly extraHolding = signal<ReadonlySet<string>>(new Set());
  /** A LAYER is being dragged: the bin is on screen and the layer may be dropped into it. */
  readonly dragging = signal(false);
  /**
   * ANYTHING is being dragged, a clip included. Only the selection chrome reads this: a box and
   * three handles riding along under the finger are in the way of the thing being moved, whether
   * that thing is a sticker or the video itself. It is a second signal and not [dragging] because
   * a clip must not put the bin on screen - there is nothing to drop a segment into.
   */
  readonly moving = signal(false);
  readonly trashHot = signal(false);
  readonly guides = signal<SnapGuides>(NO_GUIDES);

  private player: PreviewPlayer | null = null;
  /** The second element the player was last given, so its listeners can be taken off again. */
  /** The placement each element was last RENDERED with, which is how a box that moved is noticed;
      see [repaintMoved]. Null until the render that first places them. */
  private placedBase: VideoView | null = null;
  private placedExtras = new Map<string, VideoView>();
  private gestures: OverlayGestures | null = null;
  private stageResize: ResizeObserver | null = null;
  private readonly disposers: Array<() => void> = [];

  /* -- derived ----------------------------------------------------------------------------- */

  /**
   * By reference. Every edit replaces the manifest, but a layer drag keeps `clips` and a trim keeps
   * `overlays` - so the player does not re-seek on every frame of a drag, nor the layers rebuild on
   * every frame of a trim.
   */
  private readonly overlays = computed(() => this.ctx.store.manifest.value.overlays);
  private readonly segments = computed(() => this.ctx.store.manifest.value.clips);
  /** The same, for the extra video layer: its clips are edited by the same tools as the base's. */
  private readonly videoTracks = computed(() => this.ctx.store.manifest.value.videoTracks);

  /**
   * The ids of the layers on screen, as one string. The playhead moves 30 times a second while
   * playing; a string that comes out the same compares equal, so the layers below are only rebuilt
   * when a layer actually appears or disappears.
   */
  private readonly visibleKey = computed(() => {
    const at = this.ctx.store.playheadMs.value;
    const total = this.ctx.store.totalMs.value;
    let key = '';
    for (const overlay of this.overlays.value) {
      if (isOverlayVisibleAt(overlay, at, total)) key += `${overlay.id}\n`;
    }
    return key;
  });
  private readonly visibleIds = computed(() => new Set(this.visibleKey.value.split('\n')));

  /** The sound the player has to follow, compared piece by piece so a layer drag does not count. */
  private readonly soundInputs = computedWith(
    () => {
      const m = this.ctx.store.manifest.value;
      return {
        originalMuted: m.originalMuted,
        music: m.music,
        voiceovers: m.voiceovers,
        recording: this.ctx.store.recordingFromMs.value !== null,
      };
    },
    (a, b) =>
      a.originalMuted === b.originalMuted &&
      a.music === b.music &&
      a.voiceovers === b.voiceovers &&
      a.recording === b.recording,
  );

  /**
   * Every layer to draw, bottom to top. A layer whose bitmap has not been drawn yet is left out
   * rather than shown as an empty box. The text being typed stays on screen even outside its time
   * window, so the customer can see what they type; while it is still empty the placeholder stands in.
   */
  private readonly layers = computed<LayerView[]>(() => {
    const store = this.ctx.store;
    const visible = this.visibleIds.value;
    const bitmaps = store.bitmaps.value;
    const editingId = store.textEdit.value?.id ?? null;
    const views: LayerView[] = [];
    for (const overlay of this.overlays.value) {
      const editing = overlay.id === editingId;
      if (!visible.has(overlay.id) && !editing) continue;
      if (editing && overlay.kind === 'text' && !overlay.text.trim()) continue;
      const bitmap = bitmaps.get(overlay.id);
      if (!bitmap) continue;

      if (overlay.kind === 'effect') {
        views.push({
          id: overlay.id,
          effect: true,
          png: bitmap.png,
          left: 0,
          top: 0,
          width: 100,
          aspect: 'auto',
          transform: 'none',
          opacity: overlay.opacity,
        });
        continue;
      }
      const box = layerBox(overlay, bitmap, store.outputWidth.value);
      if (!box) continue;
      views.push({
        id: overlay.id,
        effect: false,
        png: bitmap.png,
        left: overlay.cx * 100,
        top: overlay.cy * 100,
        width: box.widthFrac * 100,
        aspect: `${bitmap.wPx} / ${bitmap.hPx}`,
        transform: layerTransform(overlay.rotationDeg),
        opacity: overlay.opacity,
      });
    }
    return views;
  });

  /** TikTok's "Enter text" box, while a new (or emptied) text is being typed. */
  private readonly placeholder = computed<PlaceholderView | null>(() => {
    const edit = this.ctx.store.textEdit.value;
    if (!edit) return null;
    const overlay = this.overlays.value.find((o) => o.id === edit.id);
    if (overlay?.kind !== 'text' || overlay.text.trim()) return null;
    return {
      left: overlay.cx * 100,
      top: overlay.cy * 100,
      // The frame is an inline-size container, so this is the font size the rasteriser will use.
      fontSize: `calc(${OVERLAY_BASE.textFont * overlay.scale} * 100cqw)`,
      transform: layerTransform(overlay.rotationDeg),
    };
  });

  /**
   * The white box and handles around the selected layer, when it is not being typed. It goes while
   * the layer is dragged, as TikTok's does: the handles would ride along over the bin the customer
   * is aiming for, and none of them can be used mid-drag anyway.
   *
   * A layer whose time window no longer contains the playhead is not drawn at all, and without the
   * box only the timeline would show it is selected. So the box stays, ghosted and without handles:
   * it says where the layer is while the customer trims its window, and the missing handles say the
   * layer is not there to act on.
   */
  private readonly selectionBox = computed<SelectionView | null>(() => {
    const store = this.ctx.store;
    if (store.textEdit.value || this.moving.value) return null;
    const overlay = store.selectedOverlay.value;
    if (!overlay) return this.clipSelection();
    if (overlay.kind === 'effect') return null;
    const bitmap = store.bitmaps.value.get(overlay.id);
    const box = bitmap ? layerBox(overlay, bitmap, store.outputWidth.value) : null;
    if (!bitmap || !box) return null;
    const stage = this.stageSize.value;
    const shift = (handle: SelectionHandle): string => {
      if (!stage) return 'translate(0, 0)';
      const spot = handleSpot(handle, overlay, box, stage.width, stage.height, stage.bounds);
      return `translate(${spot.shiftX.toFixed(1)}px, ${spot.shiftY.toFixed(1)}px)`;
    };
    return {
      kind: 'overlay',
      isText: overlay.kind === 'text',
      ghost: !this.visibleIds.value.has(overlay.id),
      left: overlay.cx * 100,
      top: overlay.cy * 100,
      width: box.widthFrac * 100,
      aspect: `${bitmap.wPx} / ${bitmap.hPx}`,
      transform: layerTransform(overlay.rotationDeg),
      iconTransform: `rotate(${-overlay.rotationDeg}deg)`,
      shiftDelete: shift('delete'),
      shiftEdit: shift('edit'),
      shiftTransform: shift('transform'),
    };
  });

  /**
   * The same box and handles around the SELECTED CLIP's rectangle, so a video is managed on the
   * frame the way a sticker is: a border that says where it is and what it is standing at, a corner
   * to resize and turn it by, and a corner to put it back.
   *
   * The rectangle rather than the picture inside it. A clip drawn `contain` shows black down its
   * sides, and a box drawn around the PICTURE would move as the customer changed the fit while the
   * thing their fingers are actually moving stayed where it was. It is also the box the gestures
   * hit test against, which is what makes a handle land where the video can be taken hold of.
   *
   * Ghosted when the selected clip is not the one under the playhead, exactly as a layer outside its
   * own time window is: the box says which video is selected and the missing handles say it is not
   * there to act on, rather than offering a corner that would resize a video nobody can see.
   */
  private clipSelection(): SelectionView | null {
    const store = this.ctx.store;
    const clip = store.selectedClip.value;
    if (!clip) return null;
    const rect = orWhole(clip.rect);
    const turn = rect.rotationDeg ?? 0;
    const onScreen = this.shownBase.value?.clipId === clip.id || this.shownExtra.value?.clipId === clip.id;
    const stage = this.stageSize.value;
    // The box in the frame's own pixels, which is what a handle's offset is measured in.
    const box = { widthFrac: rect.w, aspect: (rect.w / rect.h) * store.frameAspect.value };
    const centre = { cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, rotationDeg: turn };
    const shift = (handle: SelectionHandle): string => {
      if (!stage) return 'translate(0, 0)';
      const spot = handleSpot(handle, centre, box, stage.width, stage.height, stage.bounds);
      return `translate(${spot.shiftX.toFixed(1)}px, ${spot.shiftY.toFixed(1)}px)`;
    };
    return {
      kind: 'clip',
      isText: false,
      ghost: !onScreen,
      left: centre.cx * 100,
      top: centre.cy * 100,
      width: rect.w * 100,
      // A ratio of two numbers rather than a pair of pixel sizes: the frame is not square, so a
      // rectangle that is half the frame wide and half of it tall is not a square on screen.
      aspect: `${rect.w * store.frameAspect.value} / ${rect.h}`,
      transform: layerTransform(turn),
      iconTransform: `rotate(${-turn}deg)`,
      shiftDelete: shift('delete'),
      shiftEdit: shift('edit'),
      shiftTransform: shift('transform'),
    };
  }

  /**
   * The stage's size in CSS pixels, which is the frame's, and the area its selection chrome may use.
   * Only the handles need them - they are held inside that area - and they change rarely (a sheet
   * opening, the fullscreen toggle, the keyboard), so a ResizeObserver is cheaper than measuring on
   * every redraw. Null until the first measurement, when the handles simply sit where the stylesheet
   * puts them.
   */
  private readonly stageSize = signal<{ width: number; height: number; bounds: ChromeBounds } | null>(null);

  private readonly recording = computed(() => this.ctx.store.recordingFromMs.value !== null);

  /**
   * Each element's source width / height, once its metadata is in. Two of them, because the two
   * layers are two different files and each one's picture is placed against the shape of its own.
   * Zero until the first clip on that element has any, which every reader below treats as "not known
   * yet" and draws exactly as it drew before crops existed.
   */
  private readonly baseAspect = signal(0);
  /** Each extra layer's source shape, by track id. Absent is "its metadata has not landed yet". */
  private readonly extraAspects = signal<ReadonlyMap<string, number>>(new Map());

  private readonly readBaseAspect = (): void => {
    const video = this.videoEl;
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      this.baseAspect.value = video.videoWidth / video.videoHeight;
    }
  };

  /**
   * One listener for every layer's element, rather than one bound per track.
   *
   * The element that fired is looked up in the map instead of being closed over, which is what
   * keeps the listener a single stable function: one that was made per track would have to be
   * remembered per track as well, purely to be taken off again.
   */
  private readonly readExtraAspect = (event: Event): void => {
    const video = event.target as HTMLVideoElement;
    if (!(video.videoWidth > 0) || !(video.videoHeight > 0)) return;
    for (const [trackId, pair] of this.extraEls) {
      if (pair.video === video) {
        this.setExtraAspect(trackId, video.videoWidth / video.videoHeight);
        return;
      }
    }
  };

  private setExtraAspect(trackId: string, aspect: number): void {
    if (this.extraAspects.value.get(trackId) === aspect) return;
    const next = new Map(this.extraAspects.value);
    if (aspect > 0) next.set(trackId, aspect);
    else next.delete(trackId);
    this.extraAspects.value = next;
  }

  /** The shape of one layer's source, or 0 while its metadata is still on its way. */
  private extraAspectOf(trackId: string | null): number {
    return (trackId && this.extraAspects.value.get(trackId)) || 0;
  }

  /**
   * What each `<video>` element is showing: the base track's layer under the playhead, and the one
   * over it when the second track has anything there. Compared on the things the picture's geometry
   * depends on, so the playhead moving 30 times a second does not rebuild a box that has not changed
   * - and a crop gesture, which changes one of them on every frame, does.
   */
  private readonly shownBase = computedWith<PreviewVideoLayer | null>(
    () => baseLayerOf(this.ctx.store.previewLayers.value),
    sameFraming,
  );
  /**
   * Every layer above the base one under the playhead, bottom to top - and there is no cap on how
   * many that is. Each gets an element of its own, which costs a decoder each; a post that stacks
   * more layers than the device can decode is a post the customer built, and showing them all of it
   * is the only honest thing to do with it.
   */
  private readonly shownExtras = computed<readonly PreviewVideoLayer[]>(() =>
    this.ctx.store.previewLayers.value.filter((layer) => layer.trackId !== null),
  );

  /** The front-most of them, which is what the selection chrome and the crop window follow. */
  private readonly shownExtra = computedWith<PreviewVideoLayer | null>(
    () => extraLayerOf(this.ctx.store.previewLayers.value),
    sameFraming,
  );

  /**
   * Whether the BASE track has a picture at this instant. False only in the tail a customer has
   * pulled past the base track's last frame, where the post is black and whatever layer is over it
   * is drawn on black.
   *
   * The element stays in the DOM and keeps its decoder, as the extra one does out of its own window:
   * the playhead crosses this line in both directions while an edit is being made, and a teardown
   * each way is a load and a black flash each way.
   */
  private readonly baseOnScreen = computed(() => this.shownBase.value !== null);

  /**
   * Where each `<video>` element is put inside the frame; see [videoView]. One per layer, and the
   * base's is the same arithmetic on the same numbers it has always been given - a post with one
   * video draws exactly what it drew before there were two.
   */
  private readonly baseBox = computedWith<VideoView>(
    () => videoView(this.shownBase.value, this.baseAspect.value, this.postFit.value, this.ctx.store.frameAspect.value),
    sameView,
  );


  /**
   * Where each layer's PICTURE sits inside the 9:16 frame, as percentages - the whole frame when it
   * fills it, the letterboxed rectangle when it does not, and the cropped picture inside the clip's
   * own rectangle once it has one. The tints are drawn over these rather than over the frame,
   * because the render colours a clip's frames before they are letterboxed.
   */
  private readonly basePicture = computedWith<BoxView>(
    () => pictureOf(this.shownBase.value, this.baseAspect.value, this.postFit.value, this.ctx.store.frameAspect.value),
    sameBox,
  );
  /**
   * Every extra layer as the template draws it, bottom to top: the element's box, the picture inside
   * it, and the layer itself.
   *
   * One computed over the whole list rather than a pair per track, because the list is what changes:
   * a layer added or removed changes its length, and a playhead crossing a clip boundary changes one
   * entry. [sameLayerViews] is what keeps the playhead's thirty writes a second from rebuilding
   * boxes that have not moved.
   */
  private readonly extraViews = computedWith<readonly ExtraLayerView[]>(() => {
    const fit = this.postFit.value;
    const frame = this.ctx.store.frameAspect.value;
    const shown = new Map(this.shownExtras.value.map((layer) => [layer.trackId as string, layer] as const));
    return this.ctx.store.videoTrackRows.value.map((track) => {
      const layer = shown.get(track.id) ?? null;
      const aspect = this.extraAspectOf(track.id);
      return {
        trackId: track.id,
        layer,
        box: videoView(layer, aspect, fit, frame),
        picture: pictureOf(layer, aspect, fit, frame),
      };
    });
  }, sameLayerViews);

  /** The post's own fit, which is what a layer with no clip under the playhead is drawn with. */
  private readonly postFit = computed<EditFit>(() => this.ctx.store.clipFit(null));

  /**
   * The crop window drawn over the picture while the crop sheet is open: the rectangle the kept part
   * of the source lands in. Null when the sheet is shut, and null while the playhead is over some
   * OTHER segment than the one being cropped - a window drawn over a clip it does not belong to
   * would be a lie about what is being changed.
   */
  private readonly cropWindow = computedWith<BoxView | null>(
    () => {
      const store = this.ctx.store;
      if (store.panel.value !== 'crop') return null;
      const target = store.cropClip.value;
      if (!target) return null;
      // Either layer can be the one being cropped, and the window belongs to whichever element is
      // actually showing that segment.
      if (this.shownBase.value?.clipId === target.id) return this.basePicture.value;
      return this.extraViews.value.find((view) => view.layer?.clipId === target.id)?.picture ?? null;
    },
    (a, b) => (a === null || b === null ? a === b : sameBox(a, b)),
  );

  /* ========================================================================================= */
  /* Lifecycle                                                                                 */
  /* ========================================================================================= */

  /**
   * Everything is wired from here rather than from `componentDidLoad`, because what it waits for is
   * the five elements the player needs and a ref callback that never fires says nothing at all - it
   * simply leaves the field undefined. Running on every render and returning early once the player
   * exists is what that costs, and it is also what hands the second track's element over as it
   * comes and goes: a ref plus this call replace the effect Angular needed for it. It is the moment
   * an element's new box is on it as well, which is the one thing a paused one has to be told about;
   * see [repaintMoved].
   */
  componentDidRender() {
    this.setUp();
    this.attachExtras();
    this.repaintMoved();
  }

  /**
   * Asks an element whose box has just moved to paint its frame into it, which a paused one does
   * not do by itself; [repaintPaused] is where that is explained and where the seek happens.
   *
   * Here rather than in one of the effects on the edit, because this is the first moment the new box
   * is actually on the element: a frame presented before it would land in the old one. The two views
   * are compared by reference, which `computedWith` makes exact - it hands back the very object it
   * returned last for as long as the placement means the same thing - so this costs a comparison per
   * render and fires only when something really moved.
   *
   * The render that PLACES the elements moves nothing: the player seeks each of them itself as it
   * takes them over.
   */
  private repaintMoved(): void {
    const base = this.baseBox.value;
    const movedBase = this.placedBase !== null && this.placedBase !== base;
    this.placedBase = base;

    /*
     * Per track, and only for a track that was already there.
     *
     * A track APPEARING is not a box that moved: its element is loading its first source and that
     * load ends in a seek of its own, so a repaint here would nudge it a millisecond off the
     * position it is about to be put on - and the nudge, arriving first, is what the element would
     * present. Compared by value rather than by identity because the list is rebuilt whenever any
     * entry in it changes, and one layer moving must not repaint the others.
     */
    let movedExtra = false;
    const placed = new Map<string, VideoView>();
    for (const view of this.extraViews.value) {
      const was = this.placedExtras.get(view.trackId);
      if (was && !sameView(was, view.box)) movedExtra = true;
      placed.set(view.trackId, view.box);
    }
    this.placedExtras = placed;

    if (movedBase) this.player?.repaintBase();
    if (movedExtra) this.player?.repaintExtra();
  }

  disconnectedCallback() {
    this.watcher.stop();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    const video = this.videoEl;
    if (video) {
      video.removeEventListener('loadedmetadata', this.readBaseAspect);
      video.removeEventListener('resize', this.readBaseAspect);
    }
    this.detachExtras();
    this.gestures?.destroy();
    this.gestures = null;
    this.stageResize?.disconnect();
    this.stageResize = null;
    this.ctx.store.attachPlayer(null);
    // Pauses, and strips and reloads every media element, so the decoder is handed back at once
    // rather than whenever the element is collected.
    this.player?.destroy();
    this.player = null;
  }

  /** The player, the gestures, the stage measurement and the four effects, once. */
  private setUp(): void {
    if (this.player) return;
    const stage = this.stageEl;
    const video = this.videoEl;
    const hold = this.holdEl;
    const music = this.musicEl;
    const voice = this.voiceEl;
    if (!stage || !video || !hold || !music || !voice) return;

    // `resize` covers the next clip being a different shape; both fire once per load, not per frame.
    video.addEventListener('loadedmetadata', this.readBaseAspect);
    video.addEventListener('resize', this.readBaseAspect);

    const store = this.ctx.store;
    this.player = new PreviewPlayer(store, {
      video,
      hold,
      setHolding: (on) => {
        this.holding.value = on;
      },
      music,
      voice,
      // The store's list and not [shownExtra], which holds its value while only `sourceMs` has
      // moved: where the layer has got to in its file is the one thing the element needs.
      extraLayers: () => store.previewLayers.value.filter((layer) => layer.trackId !== null),
    });
    store.attachPlayer(this);
    this.player.start();

    this.gestures = new OverlayGestures(store, stage, {
      dragging: this.dragging,
      moving: this.moving,
      trashHot: this.trashHot,
      guides: this.guides,
    });

    // Both boxes, because either can change without the other: a sheet opening resizes the stage,
    // and the keyboard resizes the preview around a stage the aspect ratio keeps the same.
    this.stageResize = new ResizeObserver(() => this.measureStage(stage));
    this.stageResize.observe(stage);
    this.stageResize.observe(this.el);
    this.measureStage(stage);

    this.watchTheEdit();
  }

  /**
   * The four things outside the render that have to follow the edit. Every one of them is deferred:
   * three call into the player, and `resync` seeks, which writes the playhead - run where a preact
   * effect runs them, that write would land in the middle of `commit()`, before the history entry
   * the customer is going to undo has been pushed. The fourth writes the store outright.
   */
  private watchTheEdit(): void {
    const store = this.ctx.store;

    // A trim, split, speed, reorder, delete or undo: show the right frame again (or keep playing
    // with the new speed). `store.clips` too, because a replaced source keeps its segment id, and
    // the extra track because the same edits are made to the clips on it.
    this.disposers.push(
      deferredEffect(
        () => [this.segments.value, this.videoTracks.value, store.clips.value],
        () => this.player?.resync(),
      ),
    );

    // The store keeps ONE source shape because one tool needs one: the crop sheet turns "1:1" into a
    // fraction of THIS source and the gestures measure a pan against it, both of them for the
    // segment the crop tool is on. So it is given that segment's own element's shape - which, for a
    // post with one video layer, is the base element and exactly what it was given before.
    this.disposers.push(
      deferredEffect(
        () => {
          const target = store.cropClip.value;
          const onExtra = target
            ? this.shownExtras.value.find((layer) => layer.clipId === target.id)?.trackId ?? null
            : null;
          return onExtra ? this.extraAspectOf(onExtra) : this.baseAspect.value;
        },
        (aspect) => {
          store.sourceAspect.value = aspect;
        },
      ),
    );

    this.disposers.push(
      deferredEffect(
        () => this.soundInputs.value,
        () => this.player?.refreshAudio(),
      ),
    );

    this.disposers.push(
      deferredEffect(
        () => store.filmstrips.value,
        () => this.player?.refreshPoster(),
      ),
    );
  }

  /**
   * Hands every layer's element to the player, and takes back the ones whose layer has gone.
   *
   * Nothing is done for an element that has not actually changed, which is what makes this safe to
   * call from every render: a second pass would put a second pair of listeners on the same element
   * and a second follower on the same track.
   */
  private attachExtras(): void {
    for (const [trackId, pair] of this.extraEls) {
      const video = pair.video;
      if (!video || !pair.hold || this.attachedExtras.get(trackId) === video) continue;
      this.releaseExtra(trackId);
      this.attachedExtras.set(trackId, video);
      video.addEventListener('loadedmetadata', this.readExtraAspect);
      video.addEventListener('resize', this.readExtraAspect);
      this.player?.attachFollower(trackId, {
        video,
        hold: pair.hold,
        setHolding: (on) => this.setExtraHolding(trackId, on),
      });
    }

    // And the other way: a track the render no longer writes an element for, whose follower is now
    // driving an element that has left the document.
    for (const trackId of [...this.attachedExtras.keys()]) {
      if (!this.extraEls.get(trackId)?.video) this.releaseExtra(trackId);
    }
  }

  /** One track's element given back: listeners off, follower destroyed, stale shape forgotten. */
  private releaseExtra(trackId: string): void {
    const attached = this.attachedExtras.get(trackId);
    if (!attached) return;
    attached.removeEventListener('loadedmetadata', this.readExtraAspect);
    attached.removeEventListener('resize', this.readExtraAspect);
    this.attachedExtras.delete(trackId);
    // The shape belonged to a file that has left the screen, and a stale one would place the next
    // layer's picture against the wrong source for as long as its metadata took to arrive.
    this.setExtraAspect(trackId, 0);
    this.setExtraHolding(trackId, false);
    this.player?.attachFollower(trackId, null);
  }

  /** The same, on the way out, where the elements have gone and only the listeners are left. */
  private detachExtras(): void {
    this.extraEls.clear();
    this.attachExtras();
  }

  private setExtraHolding(trackId: string, on: boolean): void {
    const has = this.extraHolding.value.has(trackId);
    if (has === on) return;
    const next = new Set(this.extraHolding.value);
    if (on) next.add(trackId);
    else next.delete(trackId);
    this.extraHolding.value = next;
  }

  private measureStage(stage: HTMLElement): void {
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return;
    const was = this.stageSize.value;
    this.stageSize.value = { width: rect.width, height: rect.height, bounds: chromeBounds(stage, rect) };
    // A stage that changes size moves both pictures without changing one number [repaintMoved]
    // compares: every box in the frame is a PERCENTAGE of this rectangle, so opening a sheet - which
    // is what shrinks the stage - leaves the views identical and the elements somewhere else on
    // screen. A paused element does nothing about that by itself; see [repaintPaused].
    if (was && (was.width !== rect.width || was.height !== rect.height)) {
      this.player?.repaintBase();
      this.player?.repaintExtra();
    }
  }

  /* ========================================================================================= */
  /* EditorPlayer                                                                              */
  /* ========================================================================================= */

  seek(outputMs: number): void {
    this.player?.seek(outputMs);
  }

  play(): void {
    this.player?.play();
  }

  pause(): void {
    this.player?.pause();
  }

  /* ========================================================================================= */
  /* Selection handles                                                                         */
  /* ========================================================================================= */

  /*
   * One stable function each rather than a fresh arrow per render, because a new value is a changed
   * value to the vdom and the listener would be taken off and put back on every repaint. Each reads
   * the selection at the moment of the tap, which is the layer the box is drawn around: the box only
   * exists while there is one.
   */
  private readonly deleteLayer = () => {
    const overlay = this.ctx.store.selectedOverlay.value;
    if (overlay) this.ctx.store.deleteOverlay(overlay.id);
  };

  /**
   * A clip's top-left handle: the framing goes and the video is back over the whole frame.
   *
   * `resetClipFraming` and not a rectangle written by hand, because it clears the crop and the fit
   * with the rectangle - one undo step, and the clip comes out of it with no framing fields at all,
   * which is what puts it back on every engine's fast path and lets it post without a re-encode.
   */
  private readonly resetClip = () => {
    const clip = this.ctx.store.selectedClip.value;
    if (clip) this.ctx.store.resetClipFraming(clip.id);
  };

  /** The top-right handle: a text opens for typing; anything else is duplicated. */
  private readonly editLayer = () => {
    const store = this.ctx.store;
    const overlay = store.selectedOverlay.value;
    if (!overlay) return;
    if (overlay.kind === 'text') store.startEditText(overlay.id);
    else store.duplicateSelectedOverlay();
  };

  /* ========================================================================================= */
  /* Render                                                                                    */
  /* ========================================================================================= */

  render() {
    return this.watcher.run(() => {
      const store = this.ctx.store;
      const css = store.previewCss.value;
      const base = this.baseBox.value;
      const extras = this.extraViews.value;
      const holding = this.extraHolding.value;
      const baseOn = this.baseOnScreen.value;
      const guides = this.guides.value;
      const selection = this.selectionBox.value;
      const ph = this.placeholder.value;
      const crop = this.cropWindow.value;

      return (
        <Host>
          {/*
            The stage is exactly the frame's box, twice over: the frame itself, which CLIPS what it
            shows, and the selection chrome above it, which must not be clipped - the handles of a
            layer scaled past the frame's edge sit outside it, and delete, duplicate and
            corner-resize could not be reached otherwise. Both fill the stage, so a percentage means
            the same in either. Every touch is handled here rather than on the frame, because the
            handles are the stage's children now.
          */}
          <div
            key="stage"
            class={{ pv__stage: true, 'pv__stage--full': store.fullscreen.value }}
            /*
              The frame's shape, as the two numbers its own rules are written in. A custom property
              rather than an `aspect-ratio` set from here, because the stage's WIDTH is derived from
              it as well - it may be no wider than the height allows - and a stylesheet that was
              handed only the finished ratio could not work the other one out.
            */
            style={{ '--pv-frame-w': String(store.output.value.width), '--pv-frame-h': String(store.output.value.height) }}
            ref={this.keepStage}
          >
            {/*
              Every child of the frame carries a key. Stencil matches unkeyed siblings of the same
              tag BY POSITION, and there are two `<video>` and two `<canvas>` among ten conditional
              blocks here: a base element the vdom re-used for the extra track's one would leave
              `PreviewPlayer`, which read `media.video` once, driving an element that is no longer in
              the document. The preview freezes on its last painted frame, the transport still says
              it is playing, and nothing throws.
            */}
            <div key="frame" class="pv__frame">
              {/*
                Its box is the whole SOURCE frame at the crop's scale, not the frame: what the crop
                threw away hangs outside this element's parent and the parent clips it. With no crop
                and no rectangle the box is the frame itself and the fit is the clip's own, which is
                the element this preview has always drawn. See `videoView`.
              */}
              <video
                key="base-video"
                ref={this.keepVideo}
                class={{ pv__video: true, 'pv__video--idle': !baseOn }}
                playsinline
                webkit-playsinline=""
                preload="auto"
                style={placement(base, css.filter)}
              ></video>

              {/*
                The outgoing clip's last frame, held over the video while the element is pointed at
                the next source. Pointing a <video> at a new file tears its decode pipeline down, and
                WKWebView paints black through the whole load-seek chain - the `poster` attribute
                does not reliably cover it and is blank anyway for a clip whose filmstrip has not
                been cut yet. A bitmap cannot go black, costs no decoder, and holds the real frame at
                full resolution.
                It carries the SAME filter and fit as the video because drawImage captures the raw
                frame: without them the colour and the letterboxing would pop for the length of the
                hold.
              */}
              <canvas
                key="base-hold"
                ref={this.keepHold}
                class={{ pv__hold: true, 'pv__hold--on': this.holding.value && baseOn }}
                aria-hidden="true"
                style={placement(base, css.filter)}
              ></canvas>

              {/*
                CSS has no filter function for a tint, so each is drawn the way the render applies
                it: on top, over the picture only - the render tints the frames before they are
                letterboxed.
              */}
              {css.tints.length > 0 && (
                <div key="base-tints" class="pv__tints" style={boxStyle(this.basePicture.value)} hidden={!baseOn}>
                  {css.tints.map((tint, index) => (
                    <div key={index} class="pv__tint" style={{ background: tint }}></div>
                  ))}
                </div>
              )}

              {/*
                Every video layer above the first, each drawn over the one below it and its colour -
                which is the z order, the base track being z 0 and nothing sorting below it.

                ONE ELEMENT PER LAYER, with no cap. It costs a hardware decoder each, which is the
                real budget on a mid-range phone; the answer to that is for a customer not to stack
                eight videos at once, not for the editor to draw seven of their eight and say
                nothing about the one it left out. Inside the gaps in a track's own window its
                element stays put, paused and hidden, because tearing it down would cost another
                load and another black flash every time the playhead crossed the track's start.
              */}
              {extras.map((view) => [
                <video
                  key={`extra-video-${view.trackId}`}
                  ref={this.refsFor(view.trackId).video}
                  class={{ pv__video: true, 'pv__video--idle': !view.layer }}
                  playsinline
                  webkit-playsinline=""
                  preload="auto"
                  style={placement(view.box, css.filter)}
                ></video>,

                /*
                  Its own held frame, for the reason the base element has one: this element loads
                  sources of its own, and a second layer flashing black is no better than the first
                  one doing it.
                */
                <canvas
                  key={`extra-hold-${view.trackId}`}
                  ref={this.refsFor(view.trackId).hold}
                  class={{ pv__hold: true, 'pv__hold--on': holding.has(view.trackId) && !!view.layer }}
                  aria-hidden="true"
                  style={placement(view.box, css.filter)}
                ></canvas>,

                /*
                  Carries the LAYER's opacity, like the element it sits on. The render tints a
                  layer's picture and only then composites the layer at the track's opacity, so a
                  tint painted here at full strength over a half faded video would show a colour
                  neither renderer produces.
                */
                css.tints.length > 0 && view.layer && (
                  <div
                    key={`extra-tints-${view.trackId}`}
                    class="pv__tints"
                    style={{ ...boxStyle(view.picture), opacity: String(view.box.opacity) }}
                  >
                    {css.tints.map((tint, index) => (
                      <div key={index} class="pv__tint" style={{ background: tint }}></div>
                    ))}
                  </div>
                ),
              ])}

              {this.layers.value.map((layer) =>
                layer.effect ? (
                  <img
                    key={layer.id}
                    class="pv__effect"
                    alt=""
                    draggable={false}
                    src={layer.png}
                    style={{ opacity: String(layer.opacity) }}
                  />
                ) : (
                  <img
                    key={layer.id}
                    class="pv__layer"
                    alt=""
                    draggable={false}
                    src={layer.png}
                    style={{
                      left: `${layer.left}%`,
                      top: `${layer.top}%`,
                      width: `${layer.width}%`,
                      'aspect-ratio': layer.aspect,
                      transform: layer.transform,
                      opacity: String(layer.opacity),
                    }}
                  />
                ),
              )}

              {ph && (
                <div
                  key="placeholder"
                  class="pv__placeholder"
                  style={{
                    left: `${ph.left}%`,
                    top: `${ph.top}%`,
                    'font-size': ph.fontSize,
                    transform: ph.transform,
                  }}
                >
                  Enter text
                </div>
              )}

              {/*
                The crop tool's window: where the part of the source that is kept lands on the frame.
                The dimming is the box's own shadow rather than four more elements, so it can never
                drift out of step with it, and the frame clips it to size.
              */}
              {crop && (
                <div key="crop" class="pv__crop" aria-hidden="true" style={boxStyle(crop)}>
                  <span class="pv__crop-corner pv__crop-corner--tl"></span>
                  <span class="pv__crop-corner pv__crop-corner--tr"></span>
                  <span class="pv__crop-corner pv__crop-corner--bl"></span>
                  <span class="pv__crop-corner pv__crop-corner--br"></span>
                </div>
              )}

              {guides.x && <div key="guide-x" class="pv__guide pv__guide--x"></div>}
              {guides.y && <div key="guide-y" class="pv__guide pv__guide--y"></div>}
              {guides.rotation && (
                <div
                  key="guide-turn"
                  class="pv__guide pv__guide--turn"
                  style={{
                    left: `${guides.rotation.cx * 100}%`,
                    top: `${guides.rotation.cy * 100}%`,
                    transform: `translate(-50%, -50%) rotate(${guides.rotation.deg}deg)`,
                  }}
                ></div>
              )}

              {this.dragging.value && (
                <div
                  key="trash"
                  class={{ pv__trash: true, 'pv__trash--hot': this.trashHot.value }}
                  aria-hidden="true"
                >
                  <ve-icon name="trash-outline"></ve-icon>
                </div>
              )}

              {this.recording.value && (
                <div key="rec" class="pv__rec" role="status">
                  ● REC
                </div>
              )}
            </div>

            {selection && (
              <div
                key="select"
                class={{ pv__select: true, 'pv__select--ghost': selection.ghost }}
                style={{
                  left: `${selection.left}%`,
                  top: `${selection.top}%`,
                  width: `${selection.width}%`,
                  'aspect-ratio': selection.aspect,
                  transform: selection.transform,
                }}
              >
                {/*
                  A layer whose time window has moved off the playhead is not on screen: the box says
                  where it is, dimmed and dashed, but there is nothing to delete a copy of or resize
                  by hand.
                */}
                {!selection.ghost && [
                  /*
                    Top left. A layer's is Delete; a clip's puts the video back over the whole frame,
                    because a segment is deleted from the timeline and a corner that threw one away
                    from here would be the same button meaning two different things.
                  */
                  selection.kind === 'clip' ? (
                    <button
                      key="handle-delete"
                      type="button"
                      class="pv__handle pv__handle--tl"
                      data-handle="delete"
                      aria-label="Fit the video to the frame"
                      style={{ '--pv-shift': selection.shiftDelete }}
                      onClick={this.resetClip}
                    >
                      <ve-icon name="scan-outline" style={{ transform: selection.iconTransform }}></ve-icon>
                    </button>
                  ) : (
                    <button
                      key="handle-delete"
                      type="button"
                      class="pv__handle pv__handle--tl"
                      data-handle="delete"
                      aria-label="Delete layer"
                      style={{ '--pv-shift': selection.shiftDelete }}
                      onClick={this.deleteLayer}
                    >
                      <ve-icon name="close" style={{ transform: selection.iconTransform }}></ve-icon>
                    </button>
                  ),
                  /*
                    Top right is a layer's alone: a clip has no second copy to make here (duplicate
                    is a timeline operation on a segment, not on a picture) and nothing to type into.
                  */
                  selection.kind === 'overlay' ? (
                    <button
                      key="handle-edit"
                      type="button"
                      class="pv__handle pv__handle--tr"
                      data-handle="edit"
                      aria-label={selection.isText ? 'Edit text' : 'Duplicate layer'}
                      style={{ '--pv-shift': selection.shiftEdit }}
                      onClick={this.editLayer}
                    >
                      <ve-icon
                        name={selection.isText ? 'pencil' : 'copy-outline'}
                        style={{ transform: selection.iconTransform }}
                      ></ve-icon>
                    </button>
                  ) : null,
                  <div
                    key="handle-transform"
                    class="pv__handle pv__handle--br"
                    data-handle="transform"
                    aria-hidden="true"
                    style={{ '--pv-shift': selection.shiftTransform }}
                  >
                    <ve-icon name="resize-outline" style={{ transform: selection.iconTransform }}></ve-icon>
                  </div>,
                ]}
              </div>
            )}
          </div>

          <audio key="music" ref={this.keepMusic} preload="auto"></audio>
          <audio key="voice" ref={this.keepVoice} preload="auto"></audio>
        </Host>
      );
    });
  }
}

/** A box on the frame as percentages of it, which is the only unit the render writes. */
function percent(box: FrameBox): BoxView {
  return { left: box.x * 100, top: box.y * 100, width: box.w * 100, height: box.h * 100 };
}

/** The four numbers as CSS, because JSX writes no units of its own. */
function boxStyle(box: BoxView): { [key: string]: string } {
  return {
    left: `${box.left}%`,
    top: `${box.top}%`,
    width: `${box.width}%`,
    height: `${box.height}%`,
  };
}

/** Where a `<video>` element and the canvas over it are placed, and what the filter does to both. */
function placement(view: VideoView, filter: string): { [key: string]: string } {
  return {
    ...boxStyle(view),
    filter,
    'object-fit': view.objectFit,
    'clip-path': view.clipPath,
    opacity: String(view.opacity),
    // After the clip, which is what the render does: the picture is cut to its rectangle and the
    // result is turned as one piece. A transform applies to the already clipped element, so the
    // two agree without either having to know about the other.
    transform: view.transform,
    'transform-origin': view.transformOrigin,
  };
}

/**
 * Where a layer's `<video>` element is put inside the frame, which is the preview's whole answer to
 * crop and reframe: the element is given the box the WHOLE source frame would occupy at the crop's
 * scale, and the frame's `overflow: hidden` cuts off everything the crop threw away. What is left on
 * screen is then exactly what `Placement.place` and Media3's `Crop` will compute.
 *
 * A clip with no crop and no rectangle takes the path this preview has always taken - the element
 * filling the frame with its own `object-fit` - and so does one whose metadata has not arrived yet,
 * because the arithmetic below needs the source's shape and there is nothing to be gained from
 * guessing it for the two frames before it lands. A null layer takes it too: for the second element
 * that is a gap in its own track, where it is hidden anyway, and for the base it is a post with no
 * clips left on it at all.
 *
 * It takes a LAYER rather than a clip because the second video track is nothing more than another
 * one of these: the rectangle, the crop and the fit are the same fields, read from the same
 * manifest, and a second copy of this arithmetic is a second place for the two to disagree.
 */
function videoView(layer: PreviewVideoLayer | null, sourceAspect: number, postFit: EditFit, frameAspect: number): VideoView {
  const fit = layer?.fit ?? postFit;
  const opacity = layer?.opacity ?? 1;
  const dest = orWhole(layer?.rect);
  const turn = dest.rotationDeg ?? 0;
  const transform = turn ? `rotate(${turn}deg)` : 'none';
  if (!(sourceAspect > 0) || (!layer?.crop && !layer?.rect)) {
    // The element IS the rectangle here, so its own centre is the rectangle's centre.
    return { ...percent(dest), objectFit: fit, clipPath: 'none', opacity, transform, transformOrigin: '50% 50%' };
  }
  const source = sourceFrameBox(pictureBox(sourceAspect, layer.crop, layer.rect, fit, frameAspect), layer.crop);
  // `fill` and not the layer's own fit: the box above IS the source's shape, to the pixel, so there
  // is nothing left for a fit to do and anything but `fill` would letterbox it twice.
  return {
    ...percent(source),
    objectFit: 'fill',
    clipPath: clipTo(source, layer.rect),
    opacity,
    transform,
    // The RECTANGLE's centre, not the element's, and that distinction is the whole of this. A
    // cropped or filled clip is given an element BIGGER than the rectangle it is drawn in, with
    // the overhang cut off by `clipPath`, so turning about the element's own middle would swing
    // the picture around a point that is not where the render turns it. The contract is explicit:
    // the fit is measured in the upright rectangle and the fitted result is turned about THAT
    // rectangle's centre. Expressed here as a fraction of the element, because that is the box
    // `transform-origin` measures against.
    transformOrigin: originIn(source, layer.rect),
  };
}

/** Where a rectangle's centre falls inside an element's box, as the percentages CSS wants. */
function originIn(element: FrameBox, rect: FrameBox | null | undefined): string {
  if (!rect) return '50% 50%';
  const x = (rect.x + rect.w / 2 - element.x) / element.w;
  const y = (rect.y + rect.h / 2 - element.y) / element.h;
  return `${pct(x)}% ${pct(y)}%`;
}

/** Where a layer's picture lands on the frame; see [VePreview.basePicture]. */
function pictureOf(layer: PreviewVideoLayer | null, sourceAspect: number, postFit: EditFit, frameAspect: number): BoxView {
  const box = pictureBox(sourceAspect, layer?.crop, layer?.rect, layer?.fit ?? postFit, frameAspect);
  // What is ON SCREEN, so `cover` inside a rectangle stops at the rectangle's edge rather than
  // running on across the frame - the render clips it there and the tints have to agree.
  return percent(layer?.rect ? intersect(box, layer.rect) : box);
}

/**
 * What cuts the `<video>` element down to the rectangle its clip is drawn in.
 *
 * A clip that fills its rectangle, or one that is cropped, is given an element BIGGER than that
 * rectangle - the whole source frame at the crop's scale - and the part that hangs over has to go.
 * The frame's `overflow: hidden` only cuts it off at the frame's own edges, which is the right
 * answer for a clip drawn over the whole frame and the wrong one for a clip drawn over half of it:
 * the render clips at the rectangle, and this preview has to show the same picture.
 *
 * The insets are fractions of the ELEMENT, because that is the box `clip-path` measures against,
 * and none of them is ever negative - a rectangle the element already sits inside asks for no
 * clipping at all rather than for a region larger than the element, which is not a thing every
 * WebView agrees on.
 */
function clipTo(element: FrameBox, rect: FrameBox | null | undefined): string {
  if (!rect) return 'none';
  const top = Math.max(0, (rect.y - element.y) / element.h);
  const right = Math.max(0, (element.x + element.w - (rect.x + rect.w)) / element.w);
  const bottom = Math.max(0, (element.y + element.h - (rect.y + rect.h)) / element.h);
  const left = Math.max(0, (rect.x - element.x) / element.w);
  if (!top && !right && !bottom && !left) return 'none';
  return `inset(${pct(top)}% ${pct(right)}% ${pct(bottom)}% ${pct(left)}%)`;
}

/** The part of a box that is inside another one. Empty when they do not meet, which cannot happen. */
function intersect(box: FrameBox, rect: FrameBox): FrameBox {
  const x = Math.max(box.x, rect.x);
  const y = Math.max(box.y, rect.y);
  return {
    x,
    y,
    w: Math.max(0, Math.min(box.x + box.w, rect.x + rect.w) - x),
    h: Math.max(0, Math.min(box.y + box.h, rect.y + rect.h) - y),
  };
}

function pct(value: number): number {
  return Math.round(value * 10_000) / 100;
}
