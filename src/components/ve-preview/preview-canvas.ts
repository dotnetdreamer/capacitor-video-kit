import { cameraAt, type CameraView } from '../../editor/camera';
import type { ComposeCamera } from '../../video-composer/definitions';
import { compileTransition, lookAt, transitionPreset, type CompiledTransition } from '../../editor/transitions';
import { DEFAULT_FRAME_ASPECT, cropStageBox, orWhole } from '../../state/clip-framing';
import { fold, isIdentity, type ColorMatrix } from '../../video-composer/web/color-matrix';
import { pictureDest } from '../../video-composer/web/geometry';
import { Painter, WHOLE_FRAME, type LayerDraw, type LayerSource, type TransitionDraw } from '../../video-composer/web/painter';
import type { PreviewVideoLayer } from '../../state/editor-store';
import type { EditorStore } from '../../state/editor-store';
import { ClipMedia } from './clip-media';

/**
 * The preview's picture: every video layer composited into ONE canvas by the browser renderer's own
 * `Painter`.
 *
 * The preview used to be a stack of positioned `<video>` elements with CSS doing the placement, the
 * rotation, the colour and the opacity. That could never blend - a blend mode, a transition between
 * two layers, a per-layer effect are all impossible while the compositor is the browser's - and,
 * worse, it was a SECOND implementation of the render contract that agreed with the first only by
 * inspection. This one is not an implementation of anything: it hands the same layers to the same
 * compositor the export uses, so the two cannot drift, and what the customer looks at is literally
 * what `web/render.ts` will draw for the same manifest.
 *
 * The `<video>` elements stay exactly where they were, one per extra video track and two for the
 * base track, still seeked by `PreviewPlayer` and `FollowerVideo`. They are simply invisible now -
 * sources rather than picture. The base track is read from the player as one [BaseShot] a frame,
 * and inside a transition it is painted as the two clips it is, mixed by the painter's own
 * transition drawing, which is the export's.
 * They are NOT `display: none`: some WebViews stop decoding a video that is not laid out, and a
 * source that has stopped decoding is a black layer.
 *
 * Everything that is not picture stays in the DOM above this canvas: the selection box and its
 * handles, the snap guides, the bin, the crop window, the text placeholder, the REC pill, and the
 * layer bitmaps themselves. They need hit testing, or they are chrome, or both.
 */

/** The most device pixels a preview is worth. A 4K post composited at 4K for a 400px box is waste. */
const MAX_PIXEL_RATIO = 2;

/**
 * How long the OTHER layers are held back for one that is between sources, before the frame is
 * drawn without it.
 *
 * Only ever reached when some layers are ready and one is not: a frame with nothing in it is never
 * painted over a post that should be showing something, however long the wait has run. That is the
 * rule in [PreviewCanvas.draw], and this is only the bound on how long a clip change may hold its
 * neighbours still so the frame does not tear in half.
 */
const WAIT_FOR_LAYER_MS = 2000;

/**
 * How long a transition's OUTGOING side is waited for, when the incoming side has a frame and it has
 * not, before the frame is painted without it.
 *
 * Paused or scrubbed into a transition, both base elements are seeked at once and land within a
 * seek of each other. Painting the first to land on its own would flash the incoming clip over black
 * on the way to the blended frame, so the frame is held for about one seek. Past that the incoming
 * side is painted alone - the outgoing clip may be a file that will never load - and a transition is
 * never frozen for the two seconds [WAIT_FOR_LAYER_MS] allows a layer.
 */
const TAIL_WAIT_MS = 600;

/**
 * How long after Play the compositor may still spend a frame warming a transition up; see
 * [PreviewCanvas.warmUp]. The elements' own clocks stand still for about this long after a start,
 * so a frame spent here is a frame nobody sees go by.
 */
const WARM_AFTER_PLAY_MS = 250;
/** The most transitions warmed in one frame, so a post dressed with a dozen kinds does not stall one frame by all of them. */
const WARM_PER_FRAME = 3;

/**
 * What a layer is drawn from: the slot a track plays on (see [ClipMedia]), which is its `<video>`
 * element or a picture. A bare element is taken too, which is what the unit tests hand over.
 */
export type PreviewSource = ClipMedia | HTMLVideoElement;

/** What one video track contributes: the element the compositor draws it from. */
interface Source {
  video: PreviewSource;
}

/**
 * The base track at one instant, as ONE reading: the clip under the playhead and the element
 * showing it, and inside a transition the outgoing clip, its element, and how far through the
 * transition the clock is. See [PreviewPlayer.baseShot], which is where it is read.
 *
 * One reading rather than three questions, because the player swaps its two base elements' roles at
 * every cut and every transition, in an animation-frame callback of its own that runs before or
 * after this one in no fixed order. Asked separately, a swap landing between two of the answers
 * would pair one clip's framing with the other clip's picture for a frame - a flash exactly at the
 * cut the two elements exist to make seamless.
 */
export interface BaseShot {
  /**
   * The output instant the shot was read at: the clock's, not the playhead's. The zoom camera is
   * read at this same instant, so the picture and the camera over it come from ONE reading and a
   * zoom cannot run a tick ahead of, or behind, the frame it magnifies. Absent in a hand-built shot,
   * which is what the unit tests make; the canvas then falls back to the attached clock.
   */
  atMs?: number;
  /** The base clip under the playhead - inside a transition, the INCOMING one - as a layer. */
  layer: PreviewVideoLayer;
  /** The element showing it, or null while that element has no frame to give. */
  video: PreviewSource | null;
  /** Its element could not load the clip, so there is nothing worth waiting for. */
  lost: boolean;
  transition: BaseTransitionShot | null;
}

/** The outgoing side of a transition in a [BaseShot]. */
export interface BaseTransitionShot {
  /** The outgoing clip's tail, framed exactly as a base layer is: its own fit, crop, rectangle and angle. */
  layer: PreviewVideoLayer;
  /** The element playing the tail, or null while it has no frame to give. */
  video: PreviewSource | null;
  /** Its element could not load the clip, so there is nothing worth waiting for. */
  lost: boolean;
  /** 0..1 through the transition, read off the clock element at this instant. */
  progress: number;
  compiled: CompiledTransition;
}

/** `readyState >= HAVE_CURRENT_DATA`: the element has a frame that `drawImage` can take. */
const HAVE_CURRENT_DATA = 2;

/** The element events that can change what an element shows; see [PreviewCanvas.listenTo]. */
const FRAME_EVENTS = ['loadeddata', 'canplay', 'seeked', 'playing', 'resize', 'timeupdate'] as const;

export class PreviewCanvas {
  private painter: Painter | null = null;
  /** The size the painter was built at, so a resize that changes nothing rebuilds nothing. */
  private width = 0;
  private height = 0;

  /**
   * One entry per EXTRA video track, keyed the way [PreviewVideoLayer.trackId] is. The base track is
   * the [baseFeed]'s once one is attached; a null key here is only ever the base of a canvas that
   * was handed a single element instead, which is what the unit tests build.
   */
  private readonly sources = new Map<string | null, Source>();
  private readonly listeners = new Map<PreviewSource, () => void>();
  /**
   * Where the base track is read from: the player's [BaseShot], a whole reading at a time. Its two
   * elements are listened to like any other source, because a seek landing on either one is a frame
   * that has changed with nothing in the store moving.
   */
  private baseFeed: (() => BaseShot | null) | null = null;
  private baseElements: PreviewSource[] = [];
  /**
   * The output instant for a frame with no base shot to read it off - the tail past the base track,
   * a post with no clips - so the camera keeps running off the player's clock there too. See
   * [PreviewPlayer.instantMs]. Null only on a canvas built without a player, and then the playhead.
   */
  private clock: (() => number) | null = null;

  private rafId = 0;
  private pending = false;
  private playing = false;
  private destroyed = false;
  /** When the current wait for a layer started, or 0 when nothing is being waited for. */
  private waitingSince = 0;
  /** When the current wait for a transition's outgoing side started; see [TAIL_WAIT_MS]. */
  private tailSince = 0;
  /** The redraw that ends a wait nothing else will end: a paused canvas only draws when told to. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The transitions this painter has drawn at least once; see [warmUp]. A new or resized painter starts cold. */
  private warmed = new Set<string>();
  private playingSince = 0;
  /** The last op list folded into a matrix, and what it folded to. A fold a frame is a fold wasted:
      the list comes off a computed, so an unchanged filter is the very same array. */
  private folded: { ops: unknown; matrix: ColorMatrix | null } | null = null;

  constructor(
    private readonly store: EditorStore,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  /**
   * Hands over one track's element, or takes it back with null.
   *
   * Called from the render, as the elements come and go, exactly as the player's own followers are
   * attached. Nothing happens for an element that is already the one attached, which is what makes
   * it safe to call from every render.
   */
  attach(trackId: string | null, video: PreviewSource | null): void {
    const current = this.sources.get(trackId);
    if (current?.video === video) return;
    if (current) this.release(current.video);
    if (!video) {
      this.sources.delete(trackId);
      this.request();
      return;
    }
    this.sources.set(trackId, { video });
    this.listenTo(video);
    this.request();
  }

  /**
   * Hands over the base track: the reading it is drawn from, and the two elements that reading can
   * name, which are listened to exactly as a track's element is. Once, from the component's set-up;
   * the elements live as long as the component does.
   */
  attachBase(feed: () => BaseShot | null, elements: readonly PreviewSource[], clock?: () => number): void {
    for (const video of this.baseElements) this.release(video);
    this.baseFeed = feed;
    this.clock = clock ?? null;
    this.baseElements = [...elements];
    for (const video of this.baseElements) this.listenTo(video);
    this.request();
  }

  /**
   * Every one of these is a moment an element's picture has changed with nothing in the store
   * moving: a source landing, a seek settling, a decoder waking up. While playing the frame loop is
   * already drawing, and a redraw asked for twice in a frame only happens once.
   */
  private listenTo(video: PreviewSource): void {
    const onFrame = () => this.request();
    for (const type of FRAME_EVENTS) video.addEventListener(type, onFrame);
    this.listeners.set(video, () => {
      for (const type of FRAME_EVENTS) video.removeEventListener(type, onFrame);
    });
  }

  /**
   * The canvas's size on screen, in CSS pixels, which is the only thing the painter is sized from.
   *
   * Everything a layer carries is a FRACTION, so the compositing resolution is free to be the
   * screen's rather than the post's: a 4K post drawn into a 400px box is composited at 400px times
   * the device's pixel ratio, capped, and looks identical.
   */
  resize(cssWidth: number, cssHeight: number): void {
    if (this.destroyed || !(cssWidth > 0) || !(cssHeight > 0)) return;
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const width = Math.max(2, Math.round(cssWidth * ratio));
    const height = Math.max(2, Math.round(cssHeight * ratio));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    // The same painter at the new size where it can be: its context, its programs and its textures
    // outlive a size, and a new painter on every sheet opening and closing was a new context and a
    // shader compile on the paused frame the customer was looking at - see [Painter.resize]. One
    // with no live GPU context to keep is built again, which is what brings a lost GPU back, and the
    // old one gives its GL context back first rather than wait to be collected, or a few sheet
    // openings use up every context the page is allowed.
    if (!this.painter?.resize({ width, height })) {
      this.painter?.dispose();
      this.painter = new Painter({ width, height }, this.canvas);
    }
    // Cold again either way. The programs survive a resize but the transitions' frame targets do
    // not, and warming is what makes them at the new size on a paused frame rather than on the first
    // frame of a transition the customer is watching.
    this.warmed = new Set();
    this.request();
  }

  /** While playing, a frame per animation frame; stopped, only when something says it has moved. */
  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (playing) this.playingSince = performance.now();
    if (playing) this.startLoop();
    else this.stopLoop();
    this.request();
  }

  /** Draws on the next animation frame. Asking twice before it runs still draws once. */
  request(): void {
    if (this.destroyed || this.pending || this.playing) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.stopLoop();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const source of this.sources.values()) this.release(source.video);
    this.sources.clear();
    for (const video of this.baseElements) this.release(video);
    this.baseElements = [];
    this.baseFeed = null;
    this.painter?.dispose();
    this.painter = null;
  }

  /* ========================================================================================= */

  /**
   * One composited frame: the colour work, then every layer bottom to top.
   *
   * A layer whose element has no frame to give is the whole reason this can decline to paint at
   * all, and the rule it follows is one line long: NEVER clear the canvas because a layer is
   * missing. Only a post with genuinely nothing on screen is painted black.
   *
   * That is what the per-element hold canvases used to buy with a bitmap copy per clip change, and
   * it is free here - a canvas keeps whatever was last drawn into it. Getting it wrong is not
   * subtle: a `<video>` pointed at a new file has no frame for as long as the load takes, so every
   * source change and every first play would flash black exactly where the holds used to hold.
   *
   * The base track is read from the player as one [BaseShot] - which clip, which element, and inside
   * a transition which other clip and how far through - and painted as a [TransitionDraw] in the
   * base track's place whenever the shot has a transition in it. Every other layer is drawn over it
   * exactly as it is over any frame.
   */
  private draw(): void {
    if (this.destroyed) return;
    const painter = this.painter;
    if (!painter) return;

    // The crop sheet draws its segment as a TOOL rather than as the post - see [layerDraw] - and
    // with no transition either: the tool is about one clip's own picture, and the window drawn over
    // it would be a lie about a frame that was half somebody else's.
    const cropOpen = this.store.panel.value === 'crop';
    // The segment the crop sheet is open on. Null whenever that sheet is shut, which is almost always.
    const cropping = cropOpen ? (this.store.cropClip.value?.id ?? null) : null;
    const frameAspect = this.store.frameAspect.value;

    const draws: (LayerDraw | TransitionDraw)[] = [];
    // How many layers the POST says are on screen, whether or not their elements can supply one.
    let onScreen = 0;
    let missing = false;

    // ONE reading of the base track per frame; see [BaseShot].
    const feed = this.baseFeed;
    const shot = feed ? feed() : null;
    if (shot) {
      onScreen += 1;
      const base = baseDraw(shot, frameAspect, cropOpen, cropping);
      if (base.tailComing) {
        // Hold the frame - bounded - rather than flash the incoming side over black on its way to
        // the blended frame; see [TAIL_WAIT_MS].
        const now = performance.now();
        if (this.tailSince === 0) this.tailSince = now;
        const left = TAIL_WAIT_MS - (now - this.tailSince);
        if (left > 0) {
          this.retryIn(left);
          return;
        }
      } else {
        this.tailSince = 0;
      }
      if (base.draw) draws.push(base.draw);
      else missing = true;
    } else {
      this.tailSince = 0;
    }

    for (const layer of orderedLayers(this.store.previewLayers.value)) {
      // The base is the shot's whenever there is a feed, and never also the store's: the store's is
      // the playhead's, which is written a tick behind the clock the shot is read off.
      if (feed && layer.trackId === null) continue;
      const source = this.sources.get(layer.trackId);
      if (!source) continue;
      onScreen += 1;
      const video = source.video;
      if (video.readyState < HAVE_CURRENT_DATA || !(video.videoWidth > 0) || !(video.videoHeight > 0)) {
        missing = true;
        continue;
      }
      draws.push(layerDraw(layer, video, frameAspect, cropping === layer.clipId));
    }

    // Nothing to draw, over a post that should be showing something: KEEP what is on the canvas.
    // Whatever was last composited is a far better picture of the post than black, and black is
    // precisely what this replaced the hold canvases to avoid. It is checked before the wait below
    // and without a bound on purpose - there is no length of wait after which a black frame is the
    // better answer, and the post having nothing on screen at all is the case just past this.
    if (draws.length === 0 && onScreen > 0) return;

    if (missing) {
      const now = performance.now();
      if (this.waitingSince === 0) this.waitingSince = now;
      // SOME of the layers are ready and one is not. Its neighbours are held with it for as long as
      // a load and a seek could honestly take, so a clip change does not tear the frame in half;
      // past that the rest of the post is drawn without it rather than freezing over a layer that
      // may never come.
      if (now - this.waitingSince < WAIT_FOR_LAYER_MS) return;
    } else {
      this.waitingSince = 0;
    }

    // The zoom camera, read at the SAME instant the base picture was: the shot's own reading, or the
    // player's clock where there is no shot. Off - the whole frame - whenever the store says the
    // camera is not live: the crop sheet's tool view, and a zoom's area being drawn in its sheet, whose
    // box is drawn over the unzoomed frame it is chosen from. A scrub in that sheet turns it back on
    // (see [EditorStore.zoomView]). See [cameraDraws].
    const camera = previewCamera(this.store.cameraLive.value, this.store.camera.value, shot?.atMs ?? this.clock?.() ?? this.store.playheadMs.value);

    painter.setColour(this.colour(), this.store.previewCss.value);
    // Warmed with the picture unzoomed: a warm-up frame is thrown away, and it only has to build the
    // transition's programs and targets, which a camera does not change.
    const side = draws[0] ? warmSide(draws[0]) : null;
    if (side) this.warmUp(painter, side);
    painter.paintLayers(cameraDraws(draws, camera));
  }

  /**
   * Draws every transition on the post once, where nobody can see it, before it is ever drawn where
   * somebody can.
   *
   * The painter builds a transition's programs and frame targets the first time a frame has that
   * transition in it, which is the first frame of its window - and compiling shaders and allocating
   * frame-sized textures is a frame's work, dropped at exactly the moment the customer is watching the
   * join they chose. Measured in a headless browser it was a 76 ms frame on a first pass through a
   * dissolve and 43 ms on the second; a phone's GPU compiles faster and still misses a frame.
   *
   * So it is paid where it is free: on a paused frame, or in the first moments of a play, which the
   * elements' own start stall already stands still through. The frame drawn is thrown away - the
   * real one is painted over it in the same task, so the browser never shows it - and each kind is
   * drawn with the current picture on both sides at its poster moment, where every channel it has is
   * moving and so every program it will need is built.
   */
  private warmUp(painter: Painter, side: LayerDraw): void {
    if (this.playing && performance.now() - this.playingSince > WARM_AFTER_PLAY_MS) return;
    let budget = WARM_PER_FRAME;
    for (const slot of this.store.slots.value) {
      const kind = slot.transitionInMs > 0 ? slot.clip.transitionIn?.kind : undefined;
      if (!kind || this.warmed.has(kind)) continue;
      const compiled = compileTransition(kind);
      if (!compiled) continue;
      this.warmed.add(kind);
      const look = lookAt(compiled.curves, transitionPreset(kind)?.posterAt ?? 0.5);
      painter.paintLayers([{ kind: 'transition', from: side, to: side, look, transition: compiled }]);
      if (--budget === 0) return;
    }
  }

  /** One redraw, `ms` from now, for a wait that no element event may come to end. */
  private retryIn(ms: number): void {
    if (this.retryTimer || this.playing) return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.request();
      },
      Math.ceil(ms) + 5,
    );
  }

  /** The post's colour as the shader wants it, folded once per filter rather than once per frame. */
  private colour(): ColorMatrix | null {
    const ops = this.store.filterOps.value;
    if (this.folded?.ops === ops) return this.folded.matrix;
    const folded = ops.length === 0 ? null : fold(ops);
    const matrix = folded && !isIdentity(folded) ? folded : null;
    this.folded = { ops, matrix };
    return matrix;
  }

  private startLoop(): void {
    if (this.rafId) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.draw();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private release(video: PreviewSource): void {
    this.listeners.get(video)?.();
    this.listeners.delete(video);
  }
}

/* -------------------------------------------------------------------------------------------- */

/**
 * The layers in DRAWING order: the base track first, then every other layer bottom to top.
 *
 * The base first whatever its `z`, which is what `render.ts` does - it draws the base track and
 * then the planned tracks - and what the native engines do. `previewLayers` is already sorted by
 * `z`, so the extras come out in their own order with nothing more to do.
 */
export function orderedLayers(layers: readonly PreviewVideoLayer[]): PreviewVideoLayer[] {
  const base = layers.filter(layer => layer.trackId === null);
  return [...base, ...layers.filter(layer => layer.trackId !== null)];
}

/**
 * One layer as the painter takes it, built the way `render.ts` builds the same layer.
 *
 * The two kinds of layer are shaped differently on purpose, because that is how the RENDER shapes
 * them and the whole point of this file is to hand the compositor what the render would:
 *
 *  - the base track's picture is placed by its `rect` INSIDE a destination that is the whole frame,
 *    so the rectangle stays in the framing and `sourceWindow` folds it in with the crop and the fit;
 *  - an extra layer's rectangle IS its destination - the plan turns it into one and takes it off
 *    the clip - so the framing carries only the crop and the fit. It matters: the painter blacks a
 *    layer's own frame before drawing it, and a layer given the whole frame as its destination
 *    would black the whole frame at the layer's opacity and wipe out everything under it.
 *
 * The angle comes off the rectangle either way and the painter turns the layer about that
 * rectangle's centre, so the two agree there as well.
 *
 * An extra layer's destination is its rectangle NARROWED to the shape its picture actually comes
 * out at - see [pictureDest]. The painter blacks a layer's own frame before drawing into it, which
 * is right for the base track, whose bars are the post's own background with nothing underneath
 * them, and wrong for every layer above it, where the same bars are opaque black over somebody
 * else's video. A destination that is already the picture's shape has no bars in it to be the wrong
 * colour, and the picture lands in exactly the same place either way, because `contain` centres it
 * in the rectangle. A `cover` layer keeps its rectangle whole: it fills it by definition.
 *
 * `cropping` is set for the ONE segment the crop sheet is open on, and it is the exception to
 * everything above: that segment is drawn as the crop TOOL needs it rather than as the post will
 * have it - all of the source, no crop applied, on a stage that does not move while the crop
 * changes. See [cropStageBox]. Without it the tool shows the finished picture, which re-fits itself
 * on every frame of an edge drag, so the edge slides out from under the finger and the window
 * appears to do something else entirely. It is false for every other layer and whenever the sheet
 * is shut, and then the preview is exactly what the render draws.
 */
export function layerDraw(layer: PreviewVideoLayer, video: PreviewSource, frameAspect: number = DEFAULT_FRAME_ASPECT, cropping = false): LayerDraw {
  const rotationDeg = layer.rect?.rotationDeg ?? 0;
  const common = {
    source: drawableOf(video),
    sourceWidth: video.videoWidth,
    sourceHeight: video.videoHeight,
    opacity: layer.opacity,
    rotationDeg,
  };
  if (cropping && video.videoWidth > 0 && video.videoHeight > 0) {
    const stage = cropStageBox(video.videoWidth / video.videoHeight, orWhole(layer.rect), frameAspect);
    // `contain` into a box that already IS the source's shape draws all of it, exactly, with no
    // bars - so the window the sheet draws over this is a plain sub-rectangle of it.
    return { ...common, framing: { fit: 'contain' }, dest: stage };
  }
  if (layer.trackId === null) {
    return {
      ...common,
      framing: { fit: layer.fit, crop: layer.crop ?? undefined, rect: layer.rect ?? undefined },
      dest: WHOLE_FRAME,
    };
  }
  const framing = { fit: layer.fit, crop: layer.crop ?? undefined };
  return {
    ...common,
    framing,
    dest: pictureDest(layer.rect ?? WHOLE_FRAME, framing, frameAspect, video.videoWidth, video.videoHeight),
  };
}

/**
 * What the painter draws for a source: the slot's live picture - its `<video>`, or the decoded still -
 * or the element itself for a bare one. A still asked before it has decoded answers with its element,
 * which the caller has already refused for having no frame, so it is never actually drawn.
 */
function drawableOf(video: PreviewSource): LayerSource {
  return video instanceof ClipMedia ? (video.drawable ?? video.element) : video;
}

/**
 * The camera the preview draws a frame through: the compiled track read at `atMs`, or null - the
 * whole frame, the old path - whenever the store says the camera is not `live`. It is not live while
 * the crop sheet is open, whose stage and window are worked out on the unzoomed frame, nor while a
 * zoom is being edited paused, whose area box is drawn over the unzoomed frame it is chosen from.
 * Everywhere else - playing, scrubbing, paused with nothing zoom-related open - it is, so what the
 * customer sees is what the export will draw.
 */
export function previewCamera(live: boolean, camera: ComposeCamera | null | undefined, atMs: number): CameraView | null {
  return live ? cameraAt(camera, atMs) : null;
}

/**
 * Every VIDEO layer of a frame seen through the zoom camera: the base, each extra track, and both
 * sides of a transition, each side's whole frame through the camera before the transition's look
 * acts on it in output pixels - the order [ComposeCamera] fixes for every engine.
 *
 * The camera rides on each draw as the painter's own `camera` field rather than being folded into
 * `dest` here, so the painter samples the SOURCE through it and a 3x zoom is drawn from the source's
 * pixels, not from an upscaled frame. Overlays never pass through here: in the preview they are DOM
 * over the canvas and stay put by construction, which is the contract's "overlays are not moved".
 *
 * A null camera hands back the very same array, so a post with no zooms - and every moment between
 * zooms - takes the old path exactly, allocation and all.
 */
export function cameraDraws(draws: (LayerDraw | TransitionDraw)[], camera: CameraView | null): (LayerDraw | TransitionDraw)[] {
  if (!camera) return draws;
  return draws.map(draw => {
    if ('kind' in draw && draw.kind === 'transition') {
      return { ...draw, from: draw.from && { ...draw.from, camera }, to: draw.to && { ...draw.to, camera } };
    }
    return { ...(draw as LayerDraw), camera };
  });
}

/** A real picture to warm a transition up with: the base layer, or either side of a transition. */
function warmSide(draw: LayerDraw | TransitionDraw): LayerDraw | null {
  const layer = 'kind' in draw && draw.kind === 'transition' ? (draw.to ?? draw.from) : (draw as LayerDraw);
  return layer && layer.sourceWidth > 0 && layer.sourceHeight > 0 ? layer : null;
}

/**
 * The base track's draw for one [BaseShot], built the way `render.ts` builds the same frame: a plain
 * layer, or - inside a transition - a [TransitionDraw] in the base track's place, each side the
 * very layer [layerDraw] makes of its clip on its own, and the look read off the compiled curves at
 * the shot's progress.
 *
 * A side with no frame to give is handed over as null, which the painter draws as ABSENT: an
 * outgoing side that is still seeking leaves the incoming one over black, and an incoming side
 * leaves the outgoing one as it was - at its FULL level, the picture jumping back to the clip the
 * transition is leaving.
 *
 * So an incoming side that is on its way is not drawn around at all: the base is simply not ready,
 * exactly as it is outside a transition, and the caller keeps the frame it has. It is the element
 * the clock is, and every seek of it - each step of a scrub through the window, the seek a paused
 * playhead lands with - takes it to HAVE_METADATA until the seek is done: 100 to 450 ms on a phone,
 * and the outgoing side's own seek, which is not waited on, is usually done first. Painted anyway,
 * a scrub through a dissolve flickered back to the outgoing clip at every step. Only an incoming
 * clip that could not be loaded is drawn around, because nothing is coming.
 *
 * `tailComing` says the incoming side is ready and the outgoing one is on its way, which is a frame
 * the caller holds for a moment rather than paints; see [TAIL_WAIT_MS]. `cropOpen` draws the base
 * alone whatever the shot says, as the crop tool needs it.
 */
export function baseDraw(shot: BaseShot, frameAspect: number, cropOpen: boolean, cropping: string | null): { draw: LayerDraw | TransitionDraw | null; tailComing: boolean } {
  const to = shot.video ? layerDraw(shot.layer, shot.video, frameAspect, cropping === shot.layer.clipId) : null;
  const transition = cropOpen ? null : shot.transition;
  if (!transition) return { draw: to, tailComing: false };
  if (!to && !shot.lost) return { draw: null, tailComing: false };
  const from = transition.video ? layerDraw(transition.layer, transition.video, frameAspect) : null;
  if (!to && !from) return { draw: null, tailComing: false };
  return {
    draw: {
      kind: 'transition',
      from,
      to,
      look: lookAt(transition.compiled.curves, transition.progress),
      transition: transition.compiled,
    },
    tailComing: !!to && !from && !transition.lost,
  };
}
