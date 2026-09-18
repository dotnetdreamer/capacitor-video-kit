import { fold, isIdentity, type ColorMatrix } from '../../video-composer/web/color-matrix';
import { Painter, WHOLE_FRAME, type LayerDraw } from '../../video-composer/web/painter';
import type { PreviewVideoLayer } from '../../state/editor-store';
import type { EditorStore } from '../../state/editor-store';

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
 * The `<video>` elements stay exactly where they were, one per video track, still seeked by
 * `PreviewPlayer` and `FollowerVideo`. They are simply invisible now - sources rather than picture.
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
 * How long the canvas will hold its last complete frame while a layer that HAD a picture is between
 * sources, before it gives up and draws the post without it.
 *
 * This is what replaced the hold canvases. A `<video>` pointed at a new file paints black through
 * the whole load-seek chain, which is why every element used to carry a `<canvas>` with the outgoing
 * frame copied onto it and a signal to raise and lower it. A composited canvas keeps whatever was
 * last drawn into it for nothing, so the hold is now simply a repaint that does not happen - and
 * the only thing that needs a number is how long "not yet" may last before a layer that is never
 * coming back freezes the whole preview.
 */
const WAIT_FOR_LAYER_MS = 2000;

/** What one video track contributes: its element, and whether it has ever had a frame in it. */
interface Source {
  video: HTMLVideoElement;
  /**
   * Whether this element has ever been drawable. It is the difference between a layer that is
   * BETWEEN sources - worth waiting a moment for, because it had a picture and will have one again -
   * and a layer that has never had one, which is a file that will not open and must not stop the
   * rest of the post being drawn.
   */
  hadFrame: boolean;
}

/** `readyState >= HAVE_CURRENT_DATA`: the element has a frame that `drawImage` can take. */
const HAVE_CURRENT_DATA = 2;

export class PreviewCanvas {
  private painter: Painter | null = null;
  /** The size the painter was built at, so a resize that changes nothing rebuilds nothing. */
  private width = 0;
  private height = 0;

  /** One entry per video track, keyed the way [PreviewVideoLayer.trackId] is - null is the base. */
  private readonly sources = new Map<string | null, Source>();
  private readonly listeners = new Map<HTMLVideoElement, () => void>();

  private rafId = 0;
  private pending = false;
  private playing = false;
  private destroyed = false;
  /** When the current wait for a layer started, or 0 when nothing is being waited for. */
  private waitingSince = 0;
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
  attach(trackId: string | null, video: HTMLVideoElement | null): void {
    const current = this.sources.get(trackId);
    if (current?.video === video) return;
    if (current) this.release(current.video);
    if (!video) {
      this.sources.delete(trackId);
      this.request();
      return;
    }
    this.sources.set(trackId, { video, hadFrame: false });
    // Every one of these is a moment this element's picture has changed with nothing in the store
    // moving: a source landing, a seek settling, a decoder waking up. While playing the frame loop
    // is already drawing, and a redraw asked for twice in a frame only happens once.
    const onFrame = () => this.request();
    for (const type of ['loadeddata', 'canplay', 'seeked', 'playing', 'resize', 'timeupdate']) {
      video.addEventListener(type, onFrame);
    }
    this.listeners.set(video, () => {
      for (const type of ['loadeddata', 'canplay', 'seeked', 'playing', 'resize', 'timeupdate']) {
        video.removeEventListener(type, onFrame);
      }
    });
    this.request();
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
    // A painter's frame size is fixed when it is built, so a resize is a new one - and the old one
    // has to give its GL context back rather than wait to be collected, or a few sheet openings use
    // up every context the page is allowed.
    this.painter?.dispose();
    this.painter = new Painter({ width, height }, this.canvas);
    this.request();
  }

  /** While playing, a frame per animation frame; stopped, only when something says it has moved. */
  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
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
    for (const source of this.sources.values()) this.release(source.video);
    this.sources.clear();
    this.painter?.dispose();
    this.painter = null;
  }

  /* ========================================================================================= */

  /**
   * One composited frame: the colour work, then every layer bottom to top.
   *
   * A layer whose element is not drawable is the whole reason this can decline to paint at all. An
   * element that HAS had a frame and does not now is between sources, and the last complete frame
   * on the canvas is a far better picture of the post than the same frame with a hole in it - which
   * is precisely what the hold canvases used to buy with a bitmap copy per clip change. An element
   * that has never had one is a file that would not open, and waiting for it forever would freeze
   * the preview over a layer that is never coming, so it is simply left out.
   */
  private draw(): void {
    if (this.destroyed) return;
    const painter = this.painter;
    if (!painter) return;

    const draws: LayerDraw[] = [];
    let waiting = false;
    for (const layer of orderedLayers(this.store.previewLayers.value)) {
      const source = this.sources.get(layer.trackId);
      if (!source) continue;
      const video = source.video;
      if (video.readyState < HAVE_CURRENT_DATA || !(video.videoWidth > 0) || !(video.videoHeight > 0)) {
        if (source.hadFrame) waiting = true;
        continue;
      }
      source.hadFrame = true;
      draws.push(layerDraw(layer, video));
    }

    if (waiting) {
      const now = performance.now();
      if (this.waitingSince === 0) this.waitingSince = now;
      // Held only as long as a load and a seek could honestly take. Past that the layer is not
      // coming back, and a frozen preview is worse than the picture without it.
      if (now - this.waitingSince < WAIT_FOR_LAYER_MS) return;
    } else {
      this.waitingSince = 0;
    }

    painter.setColour(this.colour(), this.store.previewCss.value);
    painter.paintLayers(draws);
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

  private release(video: HTMLVideoElement): void {
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
  const base = layers.filter((layer) => layer.trackId === null);
  return [...base, ...layers.filter((layer) => layer.trackId !== null)];
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
 */
export function layerDraw(layer: PreviewVideoLayer, video: HTMLVideoElement): LayerDraw {
  const rotationDeg = layer.rect?.rotationDeg ?? 0;
  const common = {
    source: video,
    sourceWidth: video.videoWidth,
    sourceHeight: video.videoHeight,
    opacity: layer.opacity,
    rotationDeg,
  };
  if (layer.trackId === null) {
    return {
      ...common,
      framing: { fit: layer.fit, crop: layer.crop ?? undefined, rect: layer.rect ?? undefined },
      dest: WHOLE_FRAME,
    };
  }
  return {
    ...common,
    framing: { fit: layer.fit, crop: layer.crop ?? undefined },
    dest: layer.rect ?? WHOLE_FRAME,
  };
}
