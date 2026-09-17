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
}

function sameBox(a: BoxView, b: BoxView): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function sameView(a: VideoView, b: VideoView): boolean {
  return sameBox(a, b) && a.objectFit === b.objectFit && a.clipPath === b.clipPath && a.opacity === b.opacity;
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

/** The layer over it, or null when the second track has nothing on screen at this instant. */
function extraLayerOf(layers: readonly PreviewVideoLayer[]): PreviewVideoLayer | null {
  return layers.find((layer) => layer.trackId !== null) ?? null;
}

/**
 * The video at the top of the editor: the edit played back live, every layer drawn over it as the
 * bitmap the render will place, and the layers moved, scaled and turned by hand right on the frame.
 *
 * Nothing here is a rendering of its own. The video is the ORIGINAL clips on one `<video>` element
 * per video track with the filter as CSS, and each layer is the PNG `OverlayBitmaps` rasterised for
 * it - so where a layer sits here, at the size it shows, is where the finished video has it.
 *
 * Two elements at the most, and the second one is only written out while the post has a second
 * track: a phone decodes two video streams at once and the feed behind this editor may already hold
 * one, which is the whole reason [MAX_VIDEO_TRACKS] is two.
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
  private extraVideoEl: HTMLVideoElement | null = null;
  private extraHoldEl: HTMLCanvasElement | null = null;
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
  private readonly keepExtraVideo = (el?: HTMLElement) => {
    this.extraVideoEl = (el as HTMLVideoElement | undefined) ?? null;
  };
  private readonly keepExtraHold = (el?: HTMLElement) => {
    this.extraHoldEl = (el as HTMLCanvasElement | undefined) ?? null;
  };
  private readonly keepMusic = (el?: HTMLElement) => {
    this.musicEl = el as HTMLAudioElement | undefined;
  };
  private readonly keepVoice = (el?: HTMLElement) => {
    this.voiceEl = el as HTMLAudioElement | undefined;
  };

  /* -- gesture feedback, written by OverlayGestures ---------------------------------------- */

  /** True while the hold canvas covers the video, i.e. across a source change. One per element. */
  readonly holding = signal(false);
  readonly extraHolding = signal(false);
  readonly dragging = signal(false);
  readonly trashHot = signal(false);
  readonly guides = signal<SnapGuides>(NO_GUIDES);

  private player: PreviewPlayer | null = null;
  /** The second element the player was last given, so its listeners can be taken off again. */
  private extraEl: HTMLVideoElement | null = null;
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
      const box = layerBox(overlay, bitmap, store.outputWidth);
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
    if (store.textEdit.value || this.dragging.value) return null;
    const overlay = store.selectedOverlay.value;
    if (!overlay || overlay.kind === 'effect') return null;
    const bitmap = store.bitmaps.value.get(overlay.id);
    const box = bitmap ? layerBox(overlay, bitmap, store.outputWidth) : null;
    if (!bitmap || !box) return null;
    const stage = this.stageSize.value;
    const shift = (handle: SelectionHandle): string => {
      if (!stage) return 'translate(0, 0)';
      const spot = handleSpot(handle, overlay, box, stage.width, stage.height, stage.bounds);
      return `translate(${spot.shiftX.toFixed(1)}px, ${spot.shiftY.toFixed(1)}px)`;
    };
    return {
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
  private readonly extraAspect = signal(0);

  private readonly readBaseAspect = (): void => {
    const video = this.videoEl;
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      this.baseAspect.value = video.videoWidth / video.videoHeight;
    }
  };

  private readonly readExtraAspect = (): void => {
    const video = this.extraEl;
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      this.extraAspect.value = video.videoWidth / video.videoHeight;
    }
  };

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
  private readonly shownExtra = computedWith<PreviewVideoLayer | null>(
    () => extraLayerOf(this.ctx.store.previewLayers.value),
    sameFraming,
  );

  /**
   * Whether the second layer is on screen at this instant. Outside its track's window the element
   * stays in the DOM, paused and hidden: its source and its last decoded frame stay with it, so
   * coming back into the window costs a seek rather than another load and another black flash.
   */
  private readonly extraOnScreen = computed(() => this.shownExtra.value !== null);

  /**
   * Where each `<video>` element is put inside the frame; see [videoView]. One per layer, and the
   * base's is the same arithmetic on the same numbers it has always been given - a post with one
   * video draws exactly what it drew before there were two.
   */
  private readonly baseBox = computedWith<VideoView>(
    () => videoView(this.shownBase.value, this.baseAspect.value, this.postFit.value),
    sameView,
  );
  private readonly extraBox = computedWith<VideoView>(
    () => videoView(this.shownExtra.value, this.extraAspect.value, this.postFit.value),
    sameView,
  );

  /**
   * Where each layer's PICTURE sits inside the 9:16 frame, as percentages - the whole frame when it
   * fills it, the letterboxed rectangle when it does not, and the cropped picture inside the clip's
   * own rectangle once it has one. The tints are drawn over these rather than over the frame,
   * because the render colours a clip's frames before they are letterboxed.
   */
  private readonly basePicture = computedWith<BoxView>(
    () => pictureOf(this.shownBase.value, this.baseAspect.value, this.postFit.value),
    sameBox,
  );
  private readonly extraPicture = computedWith<BoxView>(
    () => pictureOf(this.shownExtra.value, this.extraAspect.value, this.postFit.value),
    sameBox,
  );

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
      if (this.shownExtra.value?.clipId === target.id) return this.extraPicture.value;
      return null;
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
   * comes and goes: a ref plus this call replace the effect Angular needed for it.
   */
  componentDidRender() {
    this.setUp();
    this.attachExtra();
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
    this.detachExtra();
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
      extraLayer: () => extraLayerOf(store.previewLayers.value),
    });
    store.attachPlayer(this);
    this.player.start();

    this.gestures = new OverlayGestures(store, stage, {
      dragging: this.dragging,
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
          const onExtra = !!target && this.shownExtra.value?.clipId === target.id;
          return onExtra ? this.extraAspect.value : this.baseAspect.value;
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
   * Hands the second layer's element to the player, or takes it back. Nothing is done when the
   * element has not actually changed, which is what makes this safe to call from every render: a
   * second pass would put a second pair of listeners on the same element.
   */
  private attachExtra(): void {
    const video = this.extraVideoEl;
    const hold = this.extraHoldEl;
    if (this.extraEl === video) return;
    if (this.extraEl) {
      this.extraEl.removeEventListener('loadedmetadata', this.readExtraAspect);
      this.extraEl.removeEventListener('resize', this.readExtraAspect);
    }
    this.extraEl = video;
    if (!video || !hold) {
      // The shape belonged to a file that has left the screen, and a stale one would place the next
      // layer's picture against the wrong source for as long as its metadata took to arrive.
      this.extraAspect.value = 0;
      this.player?.attachFollower(null);
      return;
    }
    video.addEventListener('loadedmetadata', this.readExtraAspect);
    video.addEventListener('resize', this.readExtraAspect);
    this.player?.attachFollower({
      video,
      hold,
      setHolding: (on) => {
        this.extraHolding.value = on;
      },
    });
  }

  /** The same, on the way out, where the element has already gone and only the listeners are left. */
  private detachExtra(): void {
    this.extraVideoEl = null;
    this.extraHoldEl = null;
    this.attachExtra();
  }

  private measureStage(stage: HTMLElement): void {
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return;
    this.stageSize.value = { width: rect.width, height: rect.height, bounds: chromeBounds(stage, rect) };
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
      const extra = this.extraBox.value;
      const extraOn = this.extraOnScreen.value;
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
                class="pv__video"
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
                class={{ pv__hold: true, 'pv__hold--on': this.holding.value }}
                aria-hidden="true"
                style={placement(base, css.filter)}
              ></canvas>

              {/*
                CSS has no filter function for a tint, so each is drawn the way the render applies
                it: on top, over the picture only - the render tints the frames before they are
                letterboxed.
              */}
              {css.tints.length > 0 && (
                <div key="base-tints" class="pv__tints" style={boxStyle(this.basePicture.value)}>
                  {css.tints.map((tint, index) => (
                    <div key={index} class="pv__tint" style={{ background: tint }}></div>
                  ))}
                </div>
              )}

              {/*
                The second video layer, drawn over the first one and its colour - which is the z
                order, the base track being z 0 and nothing sorting below it.

                It is written out only while the post HAS a second track: a hidden element still
                holds a hardware decoder, and two of those is the whole budget on a mid-range phone.
                Inside the gaps in that track's own window it stays put, paused and hidden, because
                tearing it down there would cost another load and another black flash every time the
                playhead crossed the track's start - and the decoder was already spent on the track
                existing at all.
              */}
              {!!store.videoTrack.value && [
                <video
                  key="extra-video"
                  ref={this.keepExtraVideo}
                  class={{ pv__video: true, 'pv__video--idle': !extraOn }}
                  playsinline
                  webkit-playsinline=""
                  preload="auto"
                  style={placement(extra, css.filter)}
                ></video>,

                /*
                  Its own held frame, for the reason the base element has one: this element loads
                  sources of its own, and a second layer flashing black is no better than the first
                  one doing it.
                */
                <canvas
                  key="extra-hold"
                  ref={this.keepExtraHold}
                  class={{ pv__hold: true, 'pv__hold--on': this.extraHolding.value && extraOn }}
                  aria-hidden="true"
                  style={placement(extra, css.filter)}
                ></canvas>,

                /*
                  Carries the LAYER's opacity, like the element it sits on. The render tints a
                  layer's picture and only then composites the layer at the track's opacity, so a
                  tint painted here at full strength over a half faded video would show a colour
                  neither renderer produces.
                */
                css.tints.length > 0 && extraOn && (
                  <div
                    key="extra-tints"
                    class="pv__tints"
                    style={{ ...boxStyle(this.extraPicture.value), opacity: String(extra.opacity) }}
                  >
                    {css.tints.map((tint, index) => (
                      <div key={index} class="pv__tint" style={{ background: tint }}></div>
                    ))}
                  </div>
                ),
              ]}

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
                  </button>,
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
                  </button>,
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
function videoView(layer: PreviewVideoLayer | null, sourceAspect: number, postFit: EditFit): VideoView {
  const fit = layer?.fit ?? postFit;
  const opacity = layer?.opacity ?? 1;
  const dest = orWhole(layer?.rect);
  if (!(sourceAspect > 0) || (!layer?.crop && !layer?.rect)) {
    return { ...percent(dest), objectFit: fit, clipPath: 'none', opacity };
  }
  const source = sourceFrameBox(pictureBox(sourceAspect, layer.crop, layer.rect, fit), layer.crop);
  // `fill` and not the layer's own fit: the box above IS the source's shape, to the pixel, so there
  // is nothing left for a fit to do and anything but `fill` would letterbox it twice.
  return { ...percent(source), objectFit: 'fill', clipPath: clipTo(source, layer.rect), opacity };
}

/** Where a layer's picture lands on the frame; see [VePreview.basePicture]. */
function pictureOf(layer: PreviewVideoLayer | null, sourceAspect: number, postFit: EditFit): BoxView {
  const box = pictureBox(sourceAspect, layer?.crop, layer?.rect, layer?.fit ?? postFit);
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
