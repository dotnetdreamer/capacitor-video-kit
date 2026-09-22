import { NEUTRAL_SIDE, compileTransition, lookAt, maskMeasure, smoothstep, type RGB, type TransitionSide } from '../../editor';
import type { ComposeTransitionMask } from '../../video-composer/definitions';

/*
 * The transition sheet's thumbnails: the two clips either side of the cut, the outgoing one's last
 * frame and the incoming one's first, drawn through a transition at one moment of it.
 *
 * Everything that draws one is in this file and reached through [drawThumb] alone, so that the day
 * the preview's own painter draws transitions this is the one place that changes: the tiles will
 * then be drawn by exactly the code that draws the preview and the web render, and cannot drift
 * from them at all. Until then this is a faithful Canvas 2D reading of the same contract
 * (`ComposeTransition` in `video-composer/definitions.ts`), from the same sampled curves through
 * the same `lookAt`, with the same mask measure - what differs is only which pixels are sampled,
 * which at 64 px across is not a difference an eye can find.
 *
 * The thumbnail's frame is a SQUARE, each clip's picture cover-cropped into it, and the square is
 * the output frame as far as the transition is concerned: a slide moves a whole square's width, a
 * circle opens round, a blur's sigma is a fraction of the square's side.
 */

export type ThumbSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

const BLACK: RGB = [0, 0, 0];

/** Below this a blur is invisible at thumbnail size and costs a whole pass for nothing. */
const MIN_SIGMA_PX = 0.3;

/**
 * Whether this canvas can blur. `filter` on a 2D context is new in Safari (18), and an old WebView
 * that lacks it takes an assignment silently as an expando, so the prototype is what is asked.
 */
const CAN_FILTER = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;

/**
 * Draws `kind` at progress `p` (0..1 through the transition) into `canvas`, filling it.
 *
 * A missing frame - a filmstrip still being cut, a file that could not be read - is drawn as a
 * neutral stand-in, dark for the outgoing side and light for the incoming one, so the tile still
 * shows what the transition DOES even with no picture to do it to. An unknown kind draws the
 * outgoing side alone.
 */
export function drawThumb(canvas: HTMLCanvasElement, from: ThumbSource | null, to: ThumbSource | null, kind: string, p: number): void {
  const g = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  if (!g || w <= 0 || h <= 0) return;
  reset(g);
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);

  const compiled = compileTransition(kind);
  const fromFrame = squareFrame(from, w, h, 'from');
  if (!compiled) {
    g.drawImage(fromFrame, 0, 0);
    return;
  }
  const look = lookAt(compiled.curves, p);

  // 5. The outgoing side over black...
  placeSide(g, sideImage(fromFrame, look.from, compiled.fromTint ?? BLACK, 'from'), look.from, w, h);

  // ...and the incoming side over it, at alpha times the mask.
  if (look.alpha <= 0) return;
  const toImage = sideImage(squareFrame(to, w, h, 'to'), look.to, compiled.toTint ?? BLACK, 'to');
  if (!compiled.mask) {
    g.globalAlpha = look.alpha;
    placeSide(g, toImage, look.to, w, h);
    g.globalAlpha = 1;
    return;
  }
  const layer = scratch('layer', w, h);
  const lg = context(layer);
  reset(lg);
  lg.clearRect(0, 0, w, h);
  placeSide(lg, toImage, look.to, w, h);
  lg.globalCompositeOperation = 'destination-in';
  lg.drawImage(maskImage(compiled.mask, look.reveal, look.alpha, w, h), 0, 0);
  lg.globalCompositeOperation = 'source-over';
  g.drawImage(layer, 0, 0);
}

/* -------------------------------------------------------------------------------------------- */
/* One side                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * 1. Where the side's whole frame goes: offset, turned clockwise about the centre, scaled about it.
 * The forward form of the contract's `s = C + R(-rotation) * (q - C - offset) / scale`, which is
 * what a canvas transform is; outside the moved frame nothing is drawn, which is the transparency
 * the contract asks for.
 */
function placeSide(g: CanvasRenderingContext2D, image: CanvasImageSource, side: TransitionSide, w: number, h: number): void {
  g.save();
  g.translate(w / 2 + side.x * w, h / 2 + side.y * h);
  if (side.rotation) g.rotate((side.rotation * Math.PI) / 180);
  const scale = side.scale > 1e-6 ? side.scale : 1e-6;
  if (scale !== 1) g.scale(scale, scale);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, -w / 2, -h / 2, w, h);
  g.restore();
}

/**
 * 2 to 4. The side's frame with everything done to its colour: blurred with the edges clamped, red
 * and blue pulled apart, snapped to its mosaic cells, lit and tinted - all of it in the frame's own
 * coordinates, before [placeSide] moves it. A side the transition leaves alone is handed back as the
 * frame it was given, which is most sides of most transitions.
 */
function sideImage(frame: HTMLCanvasElement, side: TransitionSide, tint: RGB, which: 'from' | 'to'): HTMLCanvasElement {
  const w = frame.width;
  const h = frame.height;
  const short = Math.min(w, h);
  const sigma = side.blur * short;
  const shift = side.split * w;
  const cell = side.pixelate * short;
  const recolour = side.gain !== NEUTRAL_SIDE.gain || side.tint > 0;
  const blurs = sigma >= MIN_SIGMA_PX;
  const repixels = shift !== 0 || recolour || cell > 1;
  if (!blurs && !repixels) return frame;

  const out = scratch(`side-${which}`, w, h);
  const og = context(out);
  reset(og);
  og.clearRect(0, 0, w, h);
  if (blurs) blurInto(og, frame, sigma);
  else og.drawImage(frame, 0, 0);
  if (repixels) repixel(og, w, h, side, tint, shift, cell);
  return out;
}

/**
 * A Gaussian of `sigma` px with the frame's edges CLAMPED, which is what the contract asks for and
 * what a canvas filter does not do: left to itself it blurs the frame into the transparent nothing
 * around it, and a whip's blur would darken every edge of the picture.
 *
 * So the frame is first stood in a border of its own edge pixels three sigmas deep, blurred there,
 * and cut back out. A canvas with no filter at all gets the nearest thing it can do on its own -
 * shrunk until one pixel covers about a blur's width, and smoothed back up - which is softer in
 * shape than a Gaussian but the same size of blur, and only ever seen on an old WebView.
 */
function blurInto(og: CanvasRenderingContext2D, frame: HTMLCanvasElement, sigma: number): void {
  const w = frame.width;
  const h = frame.height;
  const pad = Math.ceil(sigma * 3) + 1;
  const pw = w + 2 * pad;
  const ph = h + 2 * pad;
  const padded = scratch('pad', pw, ph);
  const pg = context(padded);
  reset(pg);
  pg.clearRect(0, 0, pw, ph);
  // Nearest neighbour, so a one pixel strip stretched into the border stays that pixel's colour.
  pg.imageSmoothingEnabled = false;
  pg.drawImage(frame, pad, pad);
  pg.drawImage(frame, 0, 0, w, 1, pad, 0, w, pad);
  pg.drawImage(frame, 0, h - 1, w, 1, pad, pad + h, w, pad);
  pg.drawImage(frame, 0, 0, 1, h, 0, pad, pad, h);
  pg.drawImage(frame, w - 1, 0, 1, h, pad + w, pad, pad, h);
  pg.drawImage(frame, 0, 0, 1, 1, 0, 0, pad, pad);
  pg.drawImage(frame, w - 1, 0, 1, 1, pad + w, 0, pad, pad);
  pg.drawImage(frame, 0, h - 1, 1, 1, 0, pad + h, pad, pad);
  pg.drawImage(frame, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad);
  pg.imageSmoothingEnabled = true;

  if (CAN_FILTER) {
    // Blurred into a canvas as big as the padded one, so nothing the blur reaches for is off it.
    const blurred = scratch('blurred', pw, ph);
    const bg = context(blurred);
    reset(bg);
    bg.clearRect(0, 0, pw, ph);
    bg.filter = `blur(${sigma}px)`;
    bg.drawImage(padded, 0, 0);
    bg.filter = 'none';
    og.drawImage(blurred, pad, pad, w, h, 0, 0, w, h);
    return;
  }

  const k = Math.max(1, sigma * 1.5);
  const sw = Math.max(1, Math.round(pw / k));
  const sh = Math.max(1, Math.round(ph / k));
  const small = scratch('small', sw, sh);
  const sg = context(small);
  reset(sg);
  sg.imageSmoothingQuality = 'high';
  sg.clearRect(0, 0, sw, sh);
  sg.drawImage(padded, 0, 0, sw, sh);
  og.imageSmoothingEnabled = true;
  og.imageSmoothingQuality = 'high';
  og.drawImage(small, (pad * sw) / pw, (pad * sh) / ph, (w * sw) / pw, (h * sh) / ph, 0, 0, w, h);
}

/**
 * The per-pixel steps, in the contract's order, over the frame's own pixels: the sample point
 * snapped to the centre of its mosaic cell (cells laid out from the centre), the colour read there
 * with red and blue pulled apart (edges clamped), then `min(rgb * gain, 1)` and the tint.
 *
 * Done in script rather than with composite modes because the thumbnail is small - 128 px square at
 * most - and this way each step is the contract's own sentence rather than an approximation of it.
 */
function repixel(og: CanvasRenderingContext2D, w: number, h: number, side: TransitionSide, tint: RGB, shift: number, cell: number): void {
  const image = og.getImageData(0, 0, w, h);
  const out = image.data;
  const src = new Uint8ClampedArray(out);
  const cx = w / 2;
  const cy = h / 2;
  const snaps = cell > 1;
  const gain = side.gain;
  const amount = side.tint;
  const tr = tint[0] * 255;
  const tg = tint[1] * 255;
  const tb = tint[2] * 255;

  for (let y = 0; y < h; y++) {
    const sy = snaps ? cy + (Math.floor((y + 0.5 - cy) / cell) + 0.5) * cell : y + 0.5;
    const row = clampInt(Math.floor(sy), h - 1) * w;
    for (let x = 0; x < w; x++) {
      const sx = snaps ? cx + (Math.floor((x + 0.5 - cx) / cell) + 0.5) * cell : x + 0.5;
      let r: number;
      let gr: number;
      let b: number;
      let a: number;
      if (shift !== 0) {
        r = channelAt(src, row, w, sx + shift, 0);
        gr = channelAt(src, row, w, sx, 1);
        b = channelAt(src, row, w, sx - shift, 2);
        a = src[(row + clampInt(Math.floor(sx), w - 1)) * 4 + 3];
      } else {
        const i = (row + clampInt(Math.floor(sx), w - 1)) * 4;
        r = src[i];
        gr = src[i + 1];
        b = src[i + 2];
        a = src[i + 3];
      }
      r = Math.min(r * gain, 255);
      gr = Math.min(gr * gain, 255);
      b = Math.min(b * gain, 255);
      const o = (y * w + x) * 4;
      out[o] = r + (tr - r) * amount;
      out[o + 1] = gr + (tg - gr) * amount;
      out[o + 2] = b + (tb - b) * amount;
      out[o + 3] = a;
    }
  }
  og.putImageData(image, 0, 0);
}

/** One channel of a row at a fractional x, read between the two pixels either side, edges clamped. */
function channelAt(src: Uint8ClampedArray, row: number, w: number, x: number, channel: number): number {
  const at = x - 0.5;
  const i0 = Math.floor(at);
  const f = at - i0;
  const a = src[(row + clampInt(i0, w - 1)) * 4 + channel];
  const b = src[(row + clampInt(i0 + 1, w - 1)) * 4 + channel];
  return a + (b - a) * f;
}

function clampInt(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

/* -------------------------------------------------------------------------------------------- */
/* The mask                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * How much a mask lets through at a pixel whose measure is `u`, at `reveal`: the second half of
 * `maskAlpha` in `editor/transitions.ts`, over a measure already worked out. The measure depends on
 * nothing but the shape and the pixel, so the sheet's animated tile works it out once per shape
 * rather than sixty times a second - and a unit test holds this to `maskAlpha` itself.
 */
export function maskCoverage(mask: ComposeTransitionMask, reveal: number, u: number): number {
  const fw = Math.min(0.5, Math.max(0.0005, mask.feather ?? 0.01));
  const r = Math.min(1, Math.max(0, reveal)) * (1 + 2 * fw) - fw;
  const inside = 1 - smoothstep(r - fw, r + fw, u);
  return mask.invert ? 1 - inside : inside;
}

/** Every pixel's measure for one shape at one size, by the shape object itself (they are frozen and cached). */
const measures = new WeakMap<ComposeTransitionMask, { w: number; h: number; u: Float32Array }>();

function measureOf(mask: ComposeTransitionMask, w: number, h: number): Float32Array {
  const known = measures.get(mask);
  if (known && known.w === w && known.h === h) return known.u;
  const u = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) u[y * w + x] = maskMeasure(mask, x + 0.5, y + 0.5, w, h);
  }
  measures.set(mask, { w, h, u });
  return u;
}

/** The mask as a white picture whose alpha is `alpha` times the coverage, for `destination-in`. */
function maskImage(mask: ComposeTransitionMask, reveal: number, alpha: number, w: number, h: number): HTMLCanvasElement {
  const canvas = scratch('mask', w, h);
  const mg = context(canvas);
  const u = measureOf(mask, w, h);
  const image = mg.createImageData(w, h);
  const data = image.data;
  for (let i = 0; i < u.length; i++) {
    const o = i * 4;
    data[o] = 255;
    data[o + 1] = 255;
    data[o + 2] = 255;
    data[o + 3] = Math.round(255 * alpha * maskCoverage(mask, reveal, u[i]));
  }
  mg.putImageData(image, 0, 0);
  return canvas;
}

/* -------------------------------------------------------------------------------------------- */
/* The two frames                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/** Each source's square, kept while it is the same picture at the same size. */
const squares = new WeakMap<object, HTMLCanvasElement>();
const standIns = new Map<string, HTMLCanvasElement>();

/**
 * Where a `w` x `h` cell takes its picture from in a source of `sw` x `sh`: the middle of it, as
 * large as fits with the cell's shape, which is what `object-fit: cover` does to a thumbnail.
 */
export function coverRect(sw: number, sh: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.max(w / sw, h / sh);
  const cw = w / scale;
  const ch = h / scale;
  return { x: (sw - cw) / 2, y: (sh - ch) / 2, w: cw, h: ch };
}

function squareFrame(source: ThumbSource | null, w: number, h: number, which: 'from' | 'to'): HTMLCanvasElement {
  const sw = source ? (source instanceof HTMLImageElement ? source.naturalWidth : source.width) : 0;
  const sh = source ? (source instanceof HTMLImageElement ? source.naturalHeight : source.height) : 0;
  if (!source || sw <= 0 || sh <= 0) return standIn(which, w, h);
  const known = squares.get(source);
  if (known && known.width === w && known.height === h) return known;
  const canvas = known ?? document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = context(canvas);
  reset(g);
  g.imageSmoothingQuality = 'high';
  const crop = coverRect(sw, sh, w, h);
  g.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
  squares.set(source, canvas);
  return canvas;
}

/**
 * The picture a side is drawn with when there is none: a dark graphite square for the clip going
 * out and a pale one for the clip coming in, each with a soft light across it. Neutral so that it
 * says nothing about the video, and far apart in brightness so that a dissolve, a wipe or a slide
 * between them is as plain as it would be between two real frames.
 */
function standIn(which: 'from' | 'to', w: number, h: number): HTMLCanvasElement {
  const key = `${which}|${w}x${h}`;
  const known = standIns.get(key);
  if (known) return known;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = context(canvas);
  const dark = which === 'from';
  const base = dark ? g.createLinearGradient(0, 0, w, h) : g.createLinearGradient(w, 0, 0, h);
  base.addColorStop(0, dark ? '#50535c' : '#e4e6eb');
  base.addColorStop(1, dark ? '#17181b' : '#8e939e');
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const cx = dark ? w * 0.3 : w * 0.7;
  const cy = dark ? h * 0.28 : h * 0.72;
  const glow = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.6);
  glow.addColorStop(0, dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(255, 255, 255, 0.4)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);
  standIns.set(key, canvas);
  return canvas;
}

/* -------------------------------------------------------------------------------------------- */
/* Scratch canvases                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * The working canvases, one per job and reused for every tile and every frame: a thumbnail is
 * drawn start to finish in one call, so no two of them are ever in use at once, and allocating
 * five canvases per frame of the animated tile is garbage the preview beside it does not need.
 */
const scratches = new Map<string, HTMLCanvasElement>();

function scratch(name: string, w: number, h: number): HTMLCanvasElement {
  let canvas = scratches.get(name);
  if (!canvas) {
    canvas = document.createElement('canvas');
    scratches.set(name, canvas);
  }
  // Only written when it changes: writing either clears the canvas and reallocates its store.
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return canvas;
}

/**
 * Every context here is asked for with `willReadFrequently`, because the ones that are read back
 * are read back on every frame of the animated tile, and a GPU canvas turns each `getImageData`
 * into a stall. The attribute is fixed by the first call, so every call has to agree on it.
 */
function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
}

function reset(g: CanvasRenderingContext2D): void {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.imageSmoothingEnabled = true;
  if (CAN_FILTER) g.filter = 'none';
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
