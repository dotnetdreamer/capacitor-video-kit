import { Component, Element, Host, Method, Prop } from '@stencil/core';
import { computed, signal } from '@preact/signals-core';

import { deferredEffect } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { OVERLAY_BASE, isOverlayVisibleAt } from '../../editor';
import { cropStageBox, cropWindowBox, orWhole, type FrameBox } from '../../state/clip-framing';
import { computedWith } from '../../state/computed-with';
import type { PreviewVideoLayer } from '../../state/editor-store';
import type { EditorPlayer } from '../../state/editor.types';
import { NO_GUIDES, OverlayGestures, chromeBounds, handleSpot, layerBox, layerTransform, type ChromeBounds, type SelectionHandle, type SnapGuides } from './overlay-gestures';
import { PreviewCanvas } from './preview-canvas';
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

function sameBox(a: BoxView, b: BoxView): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/**
 * One extra video TRACK: which layer of it is under the playhead, and where that layer's picture
 * lands on the frame.
 *
 * Per track and not per layer under the playhead, which is the difference between an element that
 * lives as long as the track does and one that is created and destroyed every time the playhead
 * crosses a gap in it. `layer` is null in those gaps: the element stays in the DOM, paused, keeping
 * its source and its last decoded frame, so coming back costs a seek rather than another load.
 *
 * No box any more. Where a layer is DRAWN is the canvas's business now and is worked out from the
 * same numbers the render uses; what is left here is the picture rectangle, which is chrome - the
 * crop window is drawn over it.
 */
interface ExtraLayerView {
  trackId: string;
  layer: PreviewVideoLayer | null;
}

/**
 * Whether two lists of layers would be DRAWN the same, entry for entry.
 *
 * The playhead writes thirty times a second and almost none of those writes move anything: without
 * this every one of them would rebuild every entry and hand the vdom a new style object per frame.
 */
function sameLayerViews(a: readonly ExtraLayerView[], b: readonly ExtraLayerView[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((one, i) => {
    const other = b[i];
    return one.trackId === other.trackId && one.layer?.clipId === other.layer?.clipId;
  });
}

/** Whether two layers would be DRAWN the same. `sourceMs` is left out on purpose: it moves with the
    playhead 30 times a second, and only the elements playing the layers care where it has got to. */
function sameFraming(a: PreviewVideoLayer | null, b: PreviewVideoLayer | null): boolean {
  return a?.clipId === b?.clipId && a?.crop === b?.crop && a?.rect === b?.rect && a?.fit === b?.fit && a?.opacity === b?.opacity;
}

/** The base track's layer: the one the preview has drawn all along. */
function baseLayerOf(layers: readonly PreviewVideoLayer[]): PreviewVideoLayer | null {
  return layers.find(layer => layer.trackId === null) ?? null;
}

/**
 * The video at the top of the editor: the edit played back live, every layer drawn over it as the
 * bitmap the render will place, and the layers moved, scaled and turned by hand right on the frame.
 *
 * The picture is ONE CANVAS, composited by `Painter` - the browser renderer's own compositor - from
 * one hidden `<video>` element per video track, and two for the base track, which take turns so
 * that a cut is never a load and a transition has both of its clips. It is not a second
 * implementation of the render contract that agrees with the first by inspection: it is the first,
 * handed the same layers, so where a clip sits here, at the size, angle and colour it shows, is
 * where the finished video has it. See [PreviewCanvas]. Each overlay layer is still the PNG
 * `OverlayBitmaps` rasterised for it, drawn over the canvas as an `<img>`, because that is what the
 * render places too.
 *
 * ONE ELEMENT PER TRACK, with no cap on how many. It was two - the base and the front-most layer -
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
 * exists to prevent are back. Scoped also keeps every `<video>` element in the light DOM, which is
 * where WKWebView decodes them today.
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
  private canvasEl?: HTMLCanvasElement;
  private videoEl?: HTMLVideoElement;
  /** The base track's second element; see [PreviewPlayer] for why the base plays on two. */
  private partnerEl?: HTMLVideoElement;
  /** One `<video>` per extra video track, by track id. */
  private readonly extraEls = new Map<string, HTMLVideoElement>();
  /** What each track's element was last attached to the player as, so a repaint does not re-attach. */
  private readonly attachedExtras = new Map<string, HTMLVideoElement>();
  private readonly extraRefs = new Map<string, (el?: HTMLElement) => void>();
  private musicEl?: HTMLAudioElement;
  private voiceEl?: HTMLAudioElement;

  private readonly keepStage = (el?: HTMLElement) => {
    this.stageEl = el as HTMLDivElement | undefined;
  };
  private readonly keepCanvas = (el?: HTMLElement) => {
    this.canvasEl = el as HTMLCanvasElement | undefined;
  };
  private readonly keepVideo = (el?: HTMLElement) => {
    this.videoEl = el as HTMLVideoElement | undefined;
  };
  private readonly keepPartner = (el?: HTMLElement) => {
    this.partnerEl = el as HTMLVideoElement | undefined;
  };
  /**
   * The ref for one track's element, made once per track id and never again.
   *
   * Cached because a fresh arrow every render is a CHANGED ref to the vdom, which tears the old one
   * down and puts the new one up on every repaint - and every one of those teardowns would take the
   * track's element away from the player and hand it back, which is a load and a black flash per
   * frame of playback.
   */
  private refsFor(trackId: string): (el?: HTMLElement) => void {
    const known = this.extraRefs.get(trackId);
    if (known) return known;
    const made = (el?: HTMLElement) => this.keepExtra(trackId, el);
    this.extraRefs.set(trackId, made);
    return made;
  }

  private keepExtra(trackId: string, el?: HTMLElement): void {
    const video = el as HTMLVideoElement | undefined;
    if (video) this.extraEls.set(trackId, video);
    else this.extraEls.delete(trackId);
  }
  private readonly keepMusic = (el?: HTMLElement) => {
    this.musicEl = el as HTMLAudioElement | undefined;
  };
  private readonly keepVoice = (el?: HTMLElement) => {
    this.voiceEl = el as HTMLAudioElement | undefined;
  };

  /* -- gesture feedback, written by OverlayGestures ---------------------------------------- */

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
  /** The compositor: everything the customer sees of their own footage; see [PreviewCanvas]. */
  private canvas: PreviewCanvas | null = null;
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
    (a, b) => a.originalMuted === b.originalMuted && a.music === b.music && a.voiceovers === b.voiceovers && a.recording === b.recording,
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
    const overlay = this.overlays.value.find(o => o.id === edit.id);
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
    // ANY layer under the playhead, not the base and the front-most one. Every layer is composited,
    // so a segment on a middle track is on screen; asking only the front one would ghost the box
    // around a video the customer can plainly see, and take its handles away with it.
    const onScreen = this.shownBase.value?.clipId === clip.id || this.shownExtras.value.some(layer => layer.clipId === clip.id);
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

  /**
   * Read off whichever base element is showing the clip under the playhead, which is the player's to
   * say: the two trade places at every cut, and the one listened to may be the spare loading the
   * next clip, whose shape is not the one on screen yet. The player calls this at every swap too.
   */
  private readonly readBaseAspect = (): void => {
    const video = this.player?.baseVideo ?? this.videoEl;
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
    for (const [trackId, element] of this.extraEls) {
      if (element === video) {
        this.readAspectOf(trackId, video);
        return;
      }
    }
  };

  /**
   * One layer's shape taken off its element NOW, rather than waiting to be told.
   *
   * `loadedmetadata` fires once per load and never again for anybody who arrives late, and an extra
   * layer's element is written by a RENDER - so by the time `attachExtras` runs in
   * `componentDidRender` and puts the listener on, the element it is listening to has usually
   * loaded already and had its one event. Nothing fires after that, the track never gets an entry
   * in [extraAspects], and `extraAspectOf` goes on answering 0 for the life of the layer.
   *
   * Zero is not a harmless "not yet" - it is what the crop tool is gated on. [cropWindow] returns
   * null for it, so no window is drawn over the picture; the crop sheet's `ready` is false, so
   * every ratio chip is disabled; and `presetFor` answers null. The tool opens on a layer and does
   * nothing whatsoever, which is exactly what it did.
   *
   * Harmless while the metadata genuinely has not landed: an element with no picture yet reports 0
   * and is left to the event.
   */
  private readAspectOf(trackId: string, video: HTMLVideoElement): void {
    if (!(video.videoWidth > 0) || !(video.videoHeight > 0)) return;
    this.setExtraAspect(trackId, video.videoWidth / video.videoHeight);
  }

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
  private readonly shownBase = computedWith<PreviewVideoLayer | null>(() => baseLayerOf(this.ctx.store.previewLayers.value), sameFraming);
  /**
   * Every layer above the base one under the playhead, bottom to top - and there is no cap on how
   * many that is. Each gets an element of its own, which costs a decoder each; a post that stacks
   * more layers than the device can decode is a post the customer built, and showing them all of it
   * is the only honest thing to do with it.
   */
  private readonly shownExtras = computed<readonly PreviewVideoLayer[]>(() => this.ctx.store.previewLayers.value.filter(layer => layer.trackId !== null));

  /**
   * Every extra track, bottom to top: which of its layers is under the playhead and where that
   * layer's picture lands - which is what the crop window is drawn over.
   *
   * One computed over the whole list rather than a pair per track, because the list is what changes:
   * a layer added or removed changes its length, and a playhead crossing a clip boundary changes one
   * entry. [sameLayerViews] is what keeps the playhead's thirty writes a second from rebuilding
   * boxes that have not moved.
   */
  private readonly extraViews = computedWith<readonly ExtraLayerView[]>(() => {
    const shown = new Map(this.shownExtras.value.map(layer => [layer.trackId as string, layer] as const));
    return this.ctx.store.videoTrackRows.value.map(track => {
      const layer = shown.get(track.id) ?? null;
      return { trackId: track.id, layer };
    });
  }, sameLayerViews);

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
      // The shape of the source being cropped, from whichever element is showing that segment.
      const onExtra = this.shownExtras.value.find(layer => layer.clipId === target.id)?.trackId ?? null;
      const aspect = onExtra ? this.extraAspectOf(onExtra) : this.baseAspect.value;
      if (!(aspect > 0)) return null;
      // Over the STAGE, which is where the whole source is drawn while the sheet is open, and not
      // over the finished picture: the window has to sit still under a finger that is dragging its
      // edge, and the finished picture re-fits itself every time the crop's shape changes.
      const stage = cropStageBox(aspect, orWhole(target.rect), store.frameAspect.value);
      return percent(cropWindowBox(stage, target.crop));
    },
    (a, b) => (a === null || b === null ? a === b : sameBox(a, b)),
  );

  /* ========================================================================================= */
  /* Lifecycle                                                                                 */
  /* ========================================================================================= */

  /**
   * Everything is wired from here rather than from `componentDidLoad`, because what it waits for is
   * the six elements the player needs and a ref callback that never fires says nothing at all - it
   * simply leaves the field undefined. Running on every render and returning early once the player
   * exists is what that costs, and it is also what hands the second track's element over as it
   * comes and goes: a ref plus this call replace the effect Angular needed for it. It is the moment
   * an element's new box is on it as well, which is the one thing a paused one has to be told about;
   * see [repaintMoved].
   */
  componentDidRender() {
    this.setUp();
    this.attachExtras();
    // The canvas is composited from the store and not from the DOM, so a render cannot move a
    // picture without something in the store having moved it - but a render is also the first
    // moment a newly written element exists, and the cheapest place to ask for the frame that puts
    // it on screen. Asking twice before an animation frame still draws once.
    this.canvas?.request();
  }

  disconnectedCallback() {
    this.watcher.stop();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    for (const video of [this.videoEl, this.partnerEl]) {
      video?.removeEventListener('loadedmetadata', this.readBaseAspect);
      video?.removeEventListener('resize', this.readBaseAspect);
    }
    this.detachExtras();
    this.canvas?.destroy();
    this.canvas = null;
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
    const canvas = this.canvasEl;
    const video = this.videoEl;
    const partner = this.partnerEl;
    const music = this.musicEl;
    const voice = this.voiceEl;
    if (!stage || !canvas || !video || !partner || !music || !voice) return;

    // `resize` covers the next clip being a different shape; both fire once per load, not per frame.
    for (const base of [video, partner]) {
      base.addEventListener('loadedmetadata', this.readBaseAspect);
      base.addEventListener('resize', this.readBaseAspect);
    }
    // The base element is written before it has a source, so its event is still to come - but this
    // costs a comparison and closes the same hole `attachExtras` had, for a remount onto an element
    // that is already loaded.
    this.readBaseAspect();

    const store = this.ctx.store;
    this.canvas = new PreviewCanvas(store, canvas);
    this.player = new PreviewPlayer(store, {
      video,
      partner,
      music,
      voice,
      // The store's list and not [shownExtras], which holds its value while only `sourceMs` has
      // moved: where the layer has got to in its file is the one thing the element needs.
      extraLayers: () => store.previewLayers.value.filter(layer => layer.trackId !== null),
      onSwap: this.readBaseAspect,
    });
    // The base track is drawn from the player's own reading of its two elements, one reading a
    // frame, so a swap between them can never pair one clip's framing with the other's picture.
    this.canvas.attachBase(() => this.player?.baseShot() ?? null, [video, partner]);
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

    /*
     * Everything the PICTURE is made of, in one effect: which layers are on screen and where each
     * one's clip is in its own file, and the colour the post is graded with. A redraw is asked for,
     * not performed - several of these land in the same tick during an edit, and the canvas draws
     * once on the next animation frame.
     *
     * Deferred like the rest for the same reason: `previewLayers` is read here, and a redraw that
     * ran inside `commit()` would be reading the manifest halfway through being replaced.
     */
    this.disposers.push(
      deferredEffect(
        () => [store.previewLayers.value, store.filterOps.value, store.frameAspect.value] as const,
        () => this.canvas?.request(),
      ),
    );

    // Playing is a frame per animation frame; stopped is on demand. Nothing is drawn on a timer.
    this.disposers.push(
      deferredEffect(
        () => store.playing.value,
        playing => this.canvas?.setPlaying(playing),
      ),
    );

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
          const onExtra = target ? (this.shownExtras.value.find(layer => layer.clipId === target.id)?.trackId ?? null) : null;
          return onExtra ? this.extraAspectOf(onExtra) : this.baseAspect.value;
        },
        aspect => {
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
    for (const [trackId, video] of this.extraEls) {
      if (this.attachedExtras.get(trackId) === video) continue;
      this.releaseExtra(trackId);
      this.attachedExtras.set(trackId, video);
      video.addEventListener('loadedmetadata', this.readExtraAspect);
      video.addEventListener('resize', this.readExtraAspect);
      // And read it straight away, because the event this just subscribed to has very likely
      // already been and gone: see [readAspectOf].
      this.readAspectOf(trackId, video);
      this.player?.attachFollower(trackId, { video });
      this.canvas?.attach(trackId, video);
    }

    // And the other way: a track the render no longer writes an element for, whose follower is now
    // driving an element that has left the document.
    for (const trackId of [...this.attachedExtras.keys()]) {
      if (!this.extraEls.get(trackId)) this.releaseExtra(trackId);
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
    this.player?.attachFollower(trackId, null);
    this.canvas?.attach(trackId, null);
  }

  /** The same, on the way out, where the elements have gone and only the listeners are left. */
  private detachExtras(): void {
    this.extraEls.clear();
    this.attachExtras();
  }

  private measureStage(stage: HTMLElement): void {
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return;
    this.stageSize.value = { width: rect.width, height: rect.height, bounds: chromeBounds(stage, rect) };
    // The compositor is sized to the SCREEN and not to the post, so this is also the one thing that
    // changes how many pixels it draws. Compositing a 4K post at 4K for a 400px preview is waste,
    // and everything a layer carries is a fraction, so the picture is the same either way.
    this.canvas?.resize(rect.width, rect.height);
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

  /**
   * The picture on screen at this moment, for whoever wants a still of the post: the editor's
   * export screen shows one while the file is built.
   *
   * The canvas itself, not a copy and not a data URL. A copy is the caller's to make at whatever
   * size it wants, and `toDataURL` throws on a canvas drawn from a clip on another origin - which
   * the example pages' clips are - while `drawImage` of the same canvas works everywhere. It is the
   * video layers, colour and framing included, and none of the text or stickers, which are drawn
   * over it in the DOM.
   *
   * Null until the compositor exists, because before that the element is an empty rectangle.
   */
  @Method()
  async picture(): Promise<HTMLCanvasElement | null> {
    return this.canvas && this.canvasEl ? this.canvasEl : null;
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
      const extras = this.extraViews.value;
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
            class={{ 'pv__stage': true, 'pv__stage--full': store.fullscreen.value }}
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
              tag BY POSITION, and there is one `<video>` per video track among a dozen conditional
              blocks here: a base element the vdom re-used for a track's one would leave
              `PreviewPlayer`, which read `media.video` once, driving an element that is no longer in
              the document. The preview freezes on its last composited frame, the transport still
              says it is playing, and nothing throws.
            */}
            <div key="frame" class="pv__frame">
              {/*
                The picture. Every video layer, composited by the browser renderer's own `Painter`
                from the hidden elements below - so the preview and the export are one piece of
                code and cannot drift. Its size on screen is the frame's; how many device pixels it
                is drawn at is [measureStage]'s answer, not the post's.
              */}
              <canvas key="composite" class="pv__canvas" aria-hidden="true" ref={this.keepCanvas}></canvas>

              {/*
                The sources. One `<video>` per extra video track and two for the base, seeked by
                `PreviewPlayer` and its followers and drawn from by the canvas above.

                Invisible, and deliberately NOT `display: none`: some WebViews stop decoding a
                video that is not laid out, and an element that has stopped decoding is a black
                layer. They keep a real box at the corner of the frame, at zero opacity and taking
                no touch, which is enough for every platform to go on presenting frames into them.
              */}
              <video key="base-video" ref={this.keepVideo} class="pv__source" data-deck="a" playsinline webkit-playsinline="" preload="auto" aria-hidden="true"></video>
              {/*
                The base track's second element, always there. The two take turns being the clock:
                the one that is not is parked on the next clip before every cut and plays the
                outgoing clip's tail under every transition - see [PreviewPlayer]. Keyed like the
                first and never conditional, because the player holds both for its whole life.
              */}
              <video key="base-video-2" ref={this.keepPartner} class="pv__source" data-deck="b" playsinline webkit-playsinline="" preload="auto" aria-hidden="true"></video>

              {extras.map(view => (
                <video
                  key={`extra-video-${view.trackId}`}
                  ref={this.refsFor(view.trackId)}
                  class="pv__source"
                  playsinline
                  webkit-playsinline=""
                  preload="auto"
                  aria-hidden="true"
                ></video>
              ))}

              {this.layers.value.map(layer =>
                layer.effect ? (
                  <img key={layer.id} class="pv__effect" alt="" draggable={false} src={layer.png} style={{ opacity: String(layer.opacity) }} />
                ) : (
                  <img
                    key={layer.id}
                    class="pv__layer"
                    alt=""
                    draggable={false}
                    src={layer.png}
                    style={{
                      'left': `${layer.left}%`,
                      'top': `${layer.top}%`,
                      'width': `${layer.width}%`,
                      'aspect-ratio': layer.aspect,
                      'transform': layer.transform,
                      'opacity': String(layer.opacity),
                    }}
                  />
                ),
              )}

              {ph && (
                <div
                  key="placeholder"
                  class="pv__placeholder"
                  style={{
                    'left': `${ph.left}%`,
                    'top': `${ph.top}%`,
                    'font-size': ph.fontSize,
                    'transform': ph.transform,
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
                  {/*
                    The four sides, each of which crops that side alone. They are drawn and not
                    touched: every pointer on the frame is `OverlayGestures`'s, which works out
                    which edge a finger landed on from the crop itself - see [cropSideAt] - so a
                    handle with a hit box of its own would be a second answer to the same question
                    and the two would drift. What these are for is SAYING the edges can be dragged.
                  */}
                  <span class="pv__crop-edge pv__crop-edge--t"></span>
                  <span class="pv__crop-edge pv__crop-edge--r"></span>
                  <span class="pv__crop-edge pv__crop-edge--b"></span>
                  <span class="pv__crop-edge pv__crop-edge--l"></span>
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
                <div key="trash" class={{ 'pv__trash': true, 'pv__trash--hot': this.trashHot.value }} aria-hidden="true">
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
                class={{ 'pv__select': true, 'pv__select--ghost': selection.ghost }}
                style={{
                  'left': `${selection.left}%`,
                  'top': `${selection.top}%`,
                  'width': `${selection.width}%`,
                  'aspect-ratio': selection.aspect,
                  'transform': selection.transform,
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
                      <ve-icon name={selection.isText ? 'pencil' : 'copy-outline'} style={{ transform: selection.iconTransform }}></ve-icon>
                    </button>
                  ) : null,
                  <div key="handle-transform" class="pv__handle pv__handle--br" data-handle="transform" aria-hidden="true" style={{ '--pv-shift': selection.shiftTransform }}>
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
