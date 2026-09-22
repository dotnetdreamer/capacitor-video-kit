import { compileTransition, lookAt } from '../../editor';
import type { ColorMatrix } from '../../video-composer/web/color-matrix';
import { Painter, WHOLE_FRAME, type LayerDraw, type TransitionDraw } from '../../video-composer/web/painter';

/*
 * The transition sheet's thumbnails: the two clips either side of the cut, the outgoing one's last
 * frame and the incoming one's first, drawn through a transition at one moment of it.
 *
 * They are drawn by the RENDER'S OWN `Painter`, handed the very `TransitionDraw` that `web/render.ts`
 * hands it for the same moment - the compiled curves read through the same `lookAt`, each side the
 * plain layer its clip would be on its own. So a tile is not a picture of the transition, it IS the
 * transition, a tile across: the blur is the render's Gaussian, the colour split and the mosaic are
 * the render's shader, the mask is the render's mask, and where the browser has no WebGL2 the
 * painter's own fallback draws the tile as it would draw the export. There is no drawing code in
 * this file and there should never be again: the Canvas 2D reading of the contract that was here
 * agreed with the render by inspection, and a tile that shows the customer something other than
 * what they will get is worse than no tile.
 *
 * The thumbnail's frame is a SQUARE, and the square is the output frame as far as the transition is
 * concerned: each clip's picture is fitted `cover` into it exactly as the render fits a clip into
 * the post, a slide moves a whole square's width, a circle opens round, a blur's sigma is a fraction
 * of the square's side.
 */

/**
 * One side's picture as the tiles draw it: a filmstrip frame decoded ONCE and brought to the size the
 * tile samples it at - see [prepareFrame]. Null is a side with no picture, drawn as a stand-in.
 */
export type ThumbSource = HTMLCanvasElement;

/* -------------------------------------------------------------------------------------------- */
/* The two frames                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * The size a `sw` x `sh` frame is kept at for a `cell` px square tile.
 *
 * Its SHORTER side is the tile's, which is exactly the part `cover` shows, so the painter reads it
 * one texel to one pixel: the picture is resampled once, here, by the canvas's best filter, rather
 * than stretched by a bilinear read on every frame of the animated tile. The longer side is rounded
 * to the tile's parity, so the strip `cover` leaves out is the same whole number of pixels at either
 * end - a window that began half way between two pixels would put a bilinear blur over the whole
 * tile, and the aspect it costs is at most one pixel along the long side.
 */
export function frameSize(sourceWidth: number, sourceHeight: number, cell: number): { width: number; height: number } {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return { width: cell, height: cell };
  const long = (side: number) => cell + 2 * Math.max(0, Math.round((side - cell) / 2));
  return sourceWidth <= sourceHeight
    ? { width: cell, height: long((cell * sourceHeight) / sourceWidth) }
    : { width: long((cell * sourceWidth) / sourceHeight), height: cell };
}

/**
 * A decoded frame at [frameSize], as the canvas the painter takes it from. Null for a picture with
 * no size, which the tile then draws as its stand-in.
 *
 * The WHOLE frame, not the square the tile shows: which part of it a tile shows is `cover`'s to say,
 * in the painter, for the same reason it is in the render.
 */
export function prepareFrame(image: CanvasImageSource, sourceWidth: number, sourceHeight: number, cell: number): ThumbSource | null {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
  const size = frameSize(sourceWidth, sourceHeight, cell);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, 0, 0, size.width, size.height);
  return canvas;
}

/**
 * One side as the painter takes it: the plain layer the render would draw the clip as with no
 * transition, its picture fitted `cover` into the whole frame.
 */
export function thumbLayer(frame: ThumbSource): LayerDraw {
  return {
    source: frame,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    framing: { fit: 'cover' },
    dest: WHOLE_FRAME,
    opacity: 1,
  };
}

/**
 * What the painter is handed for `kind` at progress `p` (0..1 through the transition): the one
 * `TransitionDraw` in the base track's place, built as `web/render.ts` builds it. An unknown kind
 * is the outgoing side alone, which is what a render does with a cut it has no transition for.
 */
export function thumbDraws(from: LayerDraw | null, to: LayerDraw | null, kind: string, p: number): (LayerDraw | TransitionDraw)[] {
  const compiled = compileTransition(kind);
  if (!compiled) return from ? [from] : [];
  return [{ kind: 'transition', from, to, look: lookAt(compiled.curves, p), transition: compiled }];
}

/**
 * The picture a side is drawn with when there is none: a dark graphite square for the clip going
 * out and a pale one for the clip coming in, each with a soft light across it. Neutral so that it
 * says nothing about the video, and far apart in brightness so that a dissolve, a wipe or a slide
 * between them is as plain as it would be between two real frames. A picture and not a way of
 * drawing: the painter draws it through the transition like any frame.
 */
const standIns = new Map<string, HTMLCanvasElement>();

function standIn(which: 'from' | 'to', cell: number): HTMLCanvasElement {
  const key = `${which}|${cell}`;
  const known = standIns.get(key);
  if (known) return known;
  const canvas = document.createElement('canvas');
  canvas.width = cell;
  canvas.height = cell;
  const g = canvas.getContext('2d');
  if (g) {
    const dark = which === 'from';
    const base = dark ? g.createLinearGradient(0, 0, cell, cell) : g.createLinearGradient(cell, 0, 0, cell);
    base.addColorStop(0, dark ? '#50535c' : '#e4e6eb');
    base.addColorStop(1, dark ? '#17181b' : '#8e939e');
    g.fillStyle = base;
    g.fillRect(0, 0, cell, cell);
    const cx = dark ? cell * 0.3 : cell * 0.7;
    const cy = dark ? cell * 0.28 : cell * 0.72;
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, cell * 0.6);
    glow.addColorStop(0, dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.4)');
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, cell, cell);
  }
  standIns.set(key, canvas);
  return canvas;
}

/* -------------------------------------------------------------------------------------------- */
/* The painter                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/** The post's colour work, in the two forms `Painter.setColour` takes it. */
export interface ThumbColour {
  matrix: ColorMatrix | null;
  css: { filter: string; tints: string[] };
}

const NO_COLOUR: ThumbColour = { matrix: null, css: { filter: 'none', tints: [] } };

/**
 * One sheet's thumbnails: ONE offscreen `Painter` the size of a tile, drawing each tile in turn and
 * copied onto that tile's canvas.
 *
 * One painter and not one per tile, because every painter is a WebGL context and a browser keeps
 * only a handful of those per page, dropping the oldest - which would be the preview's. It is built
 * the first time a tile is drawn, so a sheet that is opened and shut before its first frame costs
 * no context at all, and [dispose] hands the context back the moment the sheet leaves the document.
 *
 * The painter only ever sees the same two canvases, one per side, with each new pair of frames
 * copied into them. It keeps a texture per source object for as long as it lives, and a sheet left
 * open while the customer taps from cut to cut would otherwise leave a texture behind for every
 * frame it had ever shown.
 */
export class ThumbPainter {
  private painter: Painter | null = null;
  private readonly slots: Record<'from' | 'to', { canvas: HTMLCanvasElement; shows: HTMLCanvasElement | null }>;
  private colour: ThumbColour = NO_COLOUR;

  constructor(private readonly cell: number) {
    this.slots = { from: { canvas: document.createElement('canvas'), shows: null }, to: { canvas: document.createElement('canvas'), shows: null } };
  }

  /** Whether the tiles come from the painter's GPU path, which is the one the native engines agree with. */
  get usesGpu(): boolean {
    return this.painter?.usesGpu ?? false;
  }

  /** The post's own colour, which the render lays over both sides of every transition. */
  setColour(colour: ThumbColour | null): void {
    this.colour = colour ?? NO_COLOUR;
  }

  /**
   * Draws `kind` at progress `p` into `canvas`, filling it.
   *
   * A missing frame - a filmstrip still being cut, a file that could not be read - is drawn as a
   * neutral stand-in, dark for the outgoing side and light for the incoming one, so the tile still
   * shows what the transition DOES even with no picture to do it to.
   */
  drawThumb(canvas: HTMLCanvasElement, from: ThumbSource | null, to: ThumbSource | null, kind: string, p: number): void {
    const w = canvas.width;
    const h = canvas.height;
    const g = canvas.getContext('2d');
    if (!g || w <= 0 || h <= 0) return;
    const painter = this.painter ?? (this.painter = new Painter({ width: this.cell, height: this.cell }));
    painter.setColour(this.colour.matrix, this.colour.css);
    painter.paintLayers(thumbDraws(thumbLayer(this.slot('from', from)), thumbLayer(this.slot('to', to)), kind, p));
    // A copy of a finished opaque frame, so nothing about the canvas's own state can colour it.
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'copy';
    g.imageSmoothingEnabled = true;
    g.drawImage(painter.frame, 0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
  }

  /** Gives the GL context back - the painter loses it on purpose - and lets go of both frames. */
  dispose(): void {
    this.painter?.dispose();
    this.painter = null;
    for (const slot of Object.values(this.slots)) {
      // A canvas sized to nothing gives its backing store back at once.
      slot.canvas.width = 0;
      slot.canvas.height = 0;
      slot.shows = null;
    }
  }

  /** The side's canvas, holding `frame` - or the stand-in for none - and copied again only when that changes. */
  private slot(which: 'from' | 'to', frame: ThumbSource | null): HTMLCanvasElement {
    const slot = this.slots[which];
    const picture = frame && frame.width > 0 && frame.height > 0 ? frame : standIn(which, this.cell);
    if (slot.shows === picture) return slot.canvas;
    const canvas = slot.canvas;
    // Written even when unchanged: either write clears the canvas, which the copy below then fills.
    canvas.width = picture.width;
    canvas.height = picture.height;
    canvas.getContext('2d')?.drawImage(picture, 0, 0);
    slot.shows = picture;
    return canvas;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* The animated tile                                                                              */
/* -------------------------------------------------------------------------------------------- */

/** The chosen tile plays its transition, rests on the last frame, rests on the first, and again. */
export const LOOP_RUN_MS = 1200;
export const LOOP_HOLD_START_MS = 280;
export const LOOP_HOLD_END_MS = 520;
const LOOP_MS = LOOP_HOLD_START_MS + LOOP_RUN_MS + LOOP_HOLD_END_MS;

/**
 * Progress through the chosen tile's loop, `elapsed` ms after it started.
 *
 * Straight through the run, with no easing of its own: the easing is in the transition's curves,
 * and a second one here would show the customer a transition that is not the one they will get.
 */
export function loopProgress(elapsedMs: number): number {
  const t = ((elapsedMs % LOOP_MS) + LOOP_MS) % LOOP_MS;
  if (t < LOOP_HOLD_START_MS) return 0;
  if (t < LOOP_HOLD_START_MS + LOOP_RUN_MS) return (t - LOOP_HOLD_START_MS) / LOOP_RUN_MS;
  return 1;
}
