import { lostAt, overlayWireWindow, trackedFootage, trackedThingAt, type EditOverlay, type OverlayTrack } from '../../editor';
import type { EditorStore } from '../../state/editor-store';
import type { TrackAim } from '../../state/editor.types';

/**
 * The Track sheet on the picture: the box the customer aims, the run as it reads the footage, and the
 * path a tracked layer follows.
 *
 * Chrome, not picture, like the Focus sheet's outlines: a canvas of its own over the preview's, drawn
 * only while the sheet is open, and cleared otherwise. Three looks, one per thing the customer is doing:
 *
 *  - AIMING: the picture dims everywhere but the box, so what will be followed is the one bright part of
 *    the frame; lime brackets at its corners, handles to size it by, a dot at its middle.
 *  - RUNNING: the frame being read, grey, laid over the picture through the clip's own framing, with the
 *    box riding along on it and the way it has come trailing behind - the run watched, not waited for.
 *    Where the thing is lost the box goes amber and dashed, and finds it again in lime.
 *  - TRACKED: the path itself, faint, across the layer's time on screen - solid behind the playhead,
 *    dotted ahead of it, amber where the thing was out of sight - and the box round the thing now.
 *
 * Everything is placed through the same arithmetic the render places the footage with ([trackedFootage]),
 * so the box is where the thing is however the clip is cropped, fitted, placed, turned or zoomed into.
 */

/** The lost colour: amber, which reads as "look here" without reading as an error. */
const LOST = '#ffb340';

/** How dark the picture outside the box goes while it is aimed. */
const SPOTLIGHT = 'rgba(0, 0, 0, 0.42)';

/** How often the path is read, across the layer's time on screen. */
const PATH_STEP_MS = 1000 / 15;

export class TrackOverlay {
  private readonly ctx: CanvasRenderingContext2D | null;
  /** The frame a run is reading, as a picture: the luma laid into grey RGBA. */
  private readonly frame = document.createElement('canvas');
  private frameImage: ImageData | null = null;
  private pending = false;
  private destroyed = false;

  constructor(
    private readonly store: EditorStore,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext('2d');
  }

  /** Draws on the next animation frame. Asking twice before it runs still draws once. */
  request(): void {
    if (this.pending || this.destroyed) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.frame.width = 0;
    this.frame.height = 0;
    this.frameImage = null;
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || this.destroyed) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const store = this.store;
    const layer = store.trackLayer.value;
    if (store.panel.value !== 'track' || !layer) return;
    const accent = getComputedStyle(this.canvas).getPropertyValue('--ve-accent').trim() || '#a6ff2e';
    const view: View = { w, h, ratio, accent };

    if (store.trackRun.value) {
      this.drawRun(ctx, view);
      return;
    }
    const aiming = !layer.track || store.trackAimMoved.value;
    if (layer.track) this.drawPath(ctx, layer.track, layer, view, aiming);
    if (aiming) {
      const aim = store.shownAim();
      if (aim) {
        this.drawSpotlight(ctx, aim, view);
        this.drawBox(ctx, aimCorners(aim, w, h), view, 'aim');
      }
      return;
    }
    const thing = store.trackThing.value;
    if (thing && layer.track) {
      this.drawBox(
        ctx,
        thing.corners.map(c => ({ x: c.x * w, y: c.y * h })),
        view,
        lostAt(layer.track, thing.sourceMs) ? 'lost' : 'tracked',
      );
    }
  }

  /** The picture dimmed everywhere but the box. */
  private drawSpotlight(ctx: CanvasRenderingContext2D, aim: TrackAim, view: View): void {
    ctx.save();
    ctx.fillStyle = SPOTLIGHT;
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.globalCompositeOperation = 'destination-out';
    roundedPath(ctx, aimCorners(aim, view.w, view.h), 10 * view.ratio);
    ctx.fill();
    ctx.restore();
  }

  /**
   * The box: a thin outline, lime brackets at its corners, a dot at its middle. Aimed, it has white
   * handles at the corners to size it by; lost, it is amber and dashed.
   */
  private drawBox(ctx: CanvasRenderingContext2D, corners: Point[], view: View, look: 'aim' | 'tracked' | 'lost' | 'running'): void {
    const r = view.ratio;
    const colour = look === 'lost' ? LOST : view.accent;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // The outline, quiet: the brackets are what is looked at.
    roundedPath(ctx, corners, (look === 'aim' ? 10 : 6) * r);
    ctx.lineWidth = 1.5 * r;
    ctx.strokeStyle = look === 'lost' ? LOST : 'rgba(255, 255, 255, 0.85)';
    if (look === 'lost') ctx.setLineDash([6 * r, 5 * r]);
    ctx.stroke();
    ctx.setLineDash([]);

    // The brackets, a third of each side and never more than 22px, glowing a little: one path, so the
    // glow is worked out once rather than once a corner.
    ctx.lineWidth = 3.5 * r;
    ctx.strokeStyle = colour;
    ctx.shadowColor = colour;
    ctx.shadowBlur = 8 * r;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const at = corners[i]!;
      const prev = corners[(i + 3) % 4]!;
      const next = corners[(i + 1) % 4]!;
      const toPrev = towards(at, prev, Math.min(22 * r, distance(at, prev) / 3));
      const toNext = towards(at, next, Math.min(22 * r, distance(at, next) / 3));
      ctx.moveTo(toPrev.x, toPrev.y);
      ctx.lineTo(at.x, at.y);
      ctx.lineTo(toNext.x, toNext.y);
    }
    ctx.stroke();

    // The middle.
    const mid = centre(corners);
    ctx.beginPath();
    ctx.arc(mid.x, mid.y, 4 * r, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.shadowBlur = 0;

    // The handles, on a box that can be sized.
    if (look === 'aim') {
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 4 * r;
      for (const at of corners) {
        ctx.beginPath();
        ctx.arc(at.x, at.y, 5 * r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * The path the layer's thing takes across the layer's time on screen: solid up to the playhead, dotted
   * after it, amber where it was lost. Fainter while a mend is being aimed, which is about one frame.
   */
  private drawPath(ctx: CanvasRenderingContext2D, track: OverlayTrack, layer: EditOverlay, view: View, faint: boolean): void {
    const store = this.store;
    const scene = store.trackScene.value;
    const window = overlayWireWindow(layer, store.totalMs.value);
    const now = store.playheadMs.value;
    const points: { x: number; y: number; t: number; lost: boolean }[] = [];
    for (let t = window.startMs; t <= window.endMs; t += PATH_STEP_MS) {
      const thing = trackedThingAt(track, scene, t);
      if (thing) points.push({ x: thing.cx * view.w, y: thing.cy * view.h, t, lost: lostAt(track, thing.sourceMs) });
    }
    if (points.length < 2) return;
    const r = view.ratio;
    const strength = faint ? 0.45 : 0.9;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Behind the playhead solid, ahead of it dotted: each a few strokes, one per run of one colour.
    const split = points.findIndex(p => p.t > now);
    const past = split < 0 ? points : points.slice(0, split + 1);
    const ahead = split < 0 ? [] : points.slice(Math.max(0, split - 1));
    ctx.setLineDash([]);
    strokeRuns(ctx, past, view.accent, 2.5 * r, () => strength);
    ctx.setLineDash([1, 6 * r]);
    strokeRuns(ctx, ahead, view.accent, 2 * r, () => strength * 0.6);
    ctx.restore();
  }

  /** A run as it reads: the frame being read through the clip's framing, the way it has come, and the box on it. */
  private drawRun(ctx: CanvasRenderingContext2D, view: View): void {
    const store = this.store;
    const run = store.trackRun.value!;
    const live = store.trackLive.value;
    if (!live) {
      // Before the first frame: the box as it was aimed, so nothing jumps.
      const aim = store.shownAim();
      if (aim) {
        this.drawSpotlight(ctx, aim, view);
        this.drawBox(ctx, aimCorners(aim, view.w, view.h), view, 'running');
      }
      return;
    }
    const output = store.output.value;
    const footage = trackedFootage({ clipId: run.clipId, clipKey: run.clipKey, aspect: live.frame.width / live.frame.height }, store.trackScene.value, run.outputMs);
    if (!footage) return;
    const k = view.w / output.width;
    const map = footage.map;
    const at = (u: number, v: number): Point => {
      const out = map.toOutput(u, v);
      return { x: out.x * k, y: out.y * k };
    };

    // The frame, grey, cut to where the clip draws.
    const picture = this.framePicture(live.frame.width, live.frame.height, live.frame.luma);
    if (picture) {
      ctx.save();
      polygonPath(
        ctx,
        map.outline().map(p => ({ x: p.x * k, y: p.y * k })),
      );
      ctx.clip();
      const o = at(0, 0);
      const ex = at(1, 0);
      const ey = at(0, 1);
      ctx.setTransform((ex.x - o.x) / picture.width, (ex.y - o.y) / picture.width, (ey.x - o.x) / picture.height, (ey.y - o.y) / picture.height, o.x, o.y);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(picture, 0, 0);
      ctx.restore();
    }

    // The way it has come, glowing behind the box, its oldest stretch faintest. The glow is a wide faint
    // stroke under the line rather than a canvas shadow, which blurs every stroke it is on and, on a
    // phone, cost more than following the thing did.
    const r = view.ratio;
    const trail = live.trail;
    if (trail.length > 1) {
      const points = trail.map(p => ({ ...at(p.x, p.y), lost: p.lost }));
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      strokeRuns(ctx, points, view.accent, 9 * r, () => 0.16);
      strokeRuns(ctx, points, view.accent, 3 * r, i => 0.3 + 0.7 * (i / (points.length - 1)));
      ctx.restore();
    }

    // The box on the frame, turned with the thing only for a layer that turns with it (see `trackedThingAt`).
    const box = live.box;
    const rad = store.trackLayer.value?.track?.turnWith ? (box.angle * Math.PI) / 180 : 0;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const aspect = live.frame.width / live.frame.height;
    const hw = (box.w * aspect) / 2;
    const hh = box.h / 2;
    const corners = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([x, y]) => at(box.cx + (x! * cos - y! * sin) / aspect, box.cy + x! * sin + y! * cos));
    this.drawBox(ctx, corners, view, live.lost ? 'lost' : 'running');
  }

  /** The run's frame as a picture: its luma laid into a grey canvas the size it was read at. */
  private framePicture(width: number, height: number, luma: Uint8Array): HTMLCanvasElement | null {
    const fctx = this.frame.getContext('2d');
    if (!fctx) return null;
    if (this.frame.width !== width || this.frame.height !== height || !this.frameImage) {
      this.frame.width = width;
      this.frame.height = height;
      this.frameImage = fctx.createImageData(width, height);
    }
    // A pixel a write: grey is the same byte three times, under an opaque alpha, whichever way round
    // the platform keeps its bytes.
    const pixels = new Uint32Array(this.frameImage.data.buffer);
    const opaque = LITTLE_ENDIAN ? 0xff000000 : 0x000000ff;
    const shift = LITTLE_ENDIAN ? 0 : 8;
    for (let i = 0; i < luma.length; i++) {
      const v = luma[i]!;
      pixels[i] = (opaque | (((v << 16) | (v << 8) | v) << shift)) >>> 0;
    }
    fctx.putImageData(this.frameImage, 0, 0);
    return this.frame;
  }
}

/** Whether this platform keeps a 32-bit word's lowest byte first, which is how a pixel's red lands first. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * A line through `points`, stroked once per run of points of one colour - the thing's own colour where
 * it was seen, amber where it was lost - each run with the alpha `alphaAt` gives its first point, so a
 * line of hundreds of points is a handful of strokes.
 */
function strokeRuns(ctx: CanvasRenderingContext2D, points: readonly (Point & { lost: boolean })[], colour: string, width: number, alphaAt: (index: number) => number): void {
  if (points.length < 2) return;
  ctx.lineWidth = width;
  // A run ends where the colour changes, and at most every sixteen points so a fade along it shows.
  let start = 0;
  for (let i = 1; i <= points.length; i++) {
    const end = i === points.length || points[i]!.lost !== points[start]!.lost || i - start >= 16;
    if (!end) continue;
    const last = Math.min(i, points.length - 1);
    ctx.beginPath();
    ctx.moveTo(points[start]!.x, points[start]!.y);
    for (let k = start + 1; k <= last; k++) ctx.lineTo(points[k]!.x, points[k]!.y);
    ctx.strokeStyle = points[start]!.lost ? LOST : colour;
    ctx.globalAlpha = alphaAt(start);
    ctx.stroke();
    start = last;
    if (i === points.length) break;
  }
}

interface Point {
  x: number;
  y: number;
}

interface View {
  w: number;
  h: number;
  ratio: number;
  accent: string;
}

/** The aim's corners in canvas pixels: top-left, top-right, bottom-right, bottom-left. */
export function aimCorners(aim: TrackAim, w: number, h: number): Point[] {
  const x0 = (aim.cx - aim.w / 2) * w;
  const x1 = (aim.cx + aim.w / 2) * w;
  const y0 = (aim.cy - aim.h / 2) * h;
  const y1 = (aim.cy + aim.h / 2) * h;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function towards(from: Point, to: Point, by: number): Point {
  const d = distance(from, to) || 1;
  return { x: from.x + ((to.x - from.x) * by) / d, y: from.y + ((to.y - from.y) * by) / d };
}

function centre(points: Point[]): Point {
  return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
}

function polygonPath(ctx: CanvasRenderingContext2D, points: Point[]): void {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
}

/** A four-cornered shape with its corners rounded by up to `radius`, turned or not. */
function roundedPath(ctx: CanvasRenderingContext2D, corners: Point[], radius: number): void {
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const at = corners[i]!;
    const prev = corners[(i + 3) % 4]!;
    const next = corners[(i + 1) % 4]!;
    const r = Math.min(radius, distance(at, prev) / 2, distance(at, next) / 2);
    const start = towards(at, prev, r);
    const end = towards(at, next, r);
    if (i === 0) ctx.moveTo(start.x, start.y);
    else ctx.lineTo(start.x, start.y);
    ctx.quadraticCurveTo(at.x, at.y, end.x, end.y);
  }
  ctx.closePath();
}
