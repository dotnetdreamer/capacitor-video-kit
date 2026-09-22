import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { NEUTRAL_SIDE, TRANSITIONS, compileTransition, lookAt, transitionPixel, type RGB, type TransitionLook, type TransitionSide } from '../../editor/transitions';
import type { ComposeTransition } from '../definitions';

import { Painter, WHOLE_FRAME, type LayerDraw, type TransitionDraw } from './painter';

/**
 * Transitions, drawn by the real painter in a real browser and held to the reference drawing.
 *
 * `transitionPixel` in `editor/transitions.ts` is the definition: the slow, obvious per-pixel
 * working of the contract every engine is tested against. Every transition in the catalogue is
 * drawn here at three moments and compared pixel for pixel with what that function says, reading
 * each side from the very frame the painter draws for it when it is on its own - so what is under
 * test is exactly the transition, and none of the framing that other tests already pin.
 *
 * The two sides have STRUCTURE, which is the whole point of the fixture. Solid colours would pass a
 * slide that went the wrong way, a turn with its sign flipped and a mask read upside down; a hard
 * red-yellow edge, a gradient down one side and a gradient across the other catch all three. The
 * outgoing side is letterboxed, so its bars are black and part of its frame, and have to move and
 * fade with it.
 *
 * Pixels right on a discontinuity - a frame's own edge, a mosaic cell's edge, the red-yellow line -
 * are left out of the comparison, and only those: a pixel is compared unless nudging it a fifth of a
 * pixel changes what the reference says by more than a few levels. Everything else must be within
 * [TOLERANCE] of the reference, which is tight enough that any wrong sign, direction or order of
 * operations fails loudly, and each case must compare most of its frame or it fails too.
 */

const W = 90;
const H = 160;

/** 12/255: a few levels of 8-bit rounding and bilinear weights, and nothing a mistake could hide in. */
const TOLERANCE = 12 / 255;
/** How far a pixel is nudged to decide whether it sits on a discontinuity. */
const NUDGE = 0.2;
/** How much the reference may move under that nudge before the pixel is judged to be on an edge. */
const STEADY = 8 / 255;
/**
 * The 2D fallback's nudge. A canvas antialiases the edge of a moved image across the pixel it
 * crosses, where the shader cuts it at the pixel's centre, so a pixel within half a pixel of a
 * frame's edge is a coin toss between the two and is left out.
 */
const NUDGE_2D = 0.75;
/** The least share of the grid a case must actually compare. */
const MIN_COMPARED = 0.6;

const MOMENTS = [0.2, 0.5, 0.8];

/** Every shape `ComposeTransitionMask` names, whether or not a catalogue transition uses it yet. */
const MASK_SHAPES = ['linear', 'circle', 'diamond', 'clock', 'blinds', 'split'] as const;

/**
 * The outgoing side: a square, so letterboxed on a tall post. Green steps from none to full halfway
 * across - red on the left, yellow on the right - blue rises down the frame, and red drops a third
 * of the way across, so a colour split that pulls red the wrong way moves an edge the test can see.
 */
function outgoingSource(): HTMLCanvasElement {
  return paintSource(120, 120, (x, y) => [x < 40 ? 255 : 150, x < 60 ? 0 : 255, Math.round((y / 119) * 220)]);
}

/**
 * The incoming side: nearly the post's shape, fitted cover. Green rises across, red rises down, and
 * blue steps down two thirds of the way across - the edge a wrong-way split of blue would move.
 */
function incomingSource(): HTMLCanvasElement {
  return paintSource(60, 100, (x, y) => [Math.round((y / 99) * 180), Math.round((x / 59) * 255), x < 40 ? 255 : 90]);
}

function paintSource(width: number, height: number, colour: (x: number, y: number) => [number, number, number]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      const at = (y * width + x) * 4;
      image.data[at] = r;
      image.data[at + 1] = g;
      image.data[at + 2] = b;
      image.data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function layerOf(source: HTMLCanvasElement, fit: 'contain' | 'cover'): LayerDraw {
  return { source, sourceWidth: source.width, sourceHeight: source.height, framing: { fit }, dest: WHOLE_FRAME, opacity: 1 };
}

/** Everything the painter drew, as 8-bit RGBA. */
function pixels(painter: Painter): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(painter.frame, 0, 0);
  return ctx.getImageData(0, 0, W, H).data;
}

/**
 * A side's whole frame as the reference reads it: bilinear between pixel centres, edges clamped -
 * which is how a GPU samples a texture set to LINEAR and CLAMP_TO_EDGE - and blurred on request by a
 * separable Gaussian with the same edge clamp.
 */
class SideFrame {
  private readonly blurs = new Map<number, SideFrame>();

  constructor(private readonly data: Float32Array) {}

  static of(bytes: Uint8ClampedArray): SideFrame {
    const data = new Float32Array(W * H * 3);
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) data[i * 3 + c] = (bytes[i * 4 + c] ?? 0) / 255;
    return new SideFrame(data);
  }

  at(x: number, y: number): RGB {
    const fx = x - 0.5;
    const fy = y - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const out: RGB = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = this.texel(x0, y0, c) * (1 - tx) + this.texel(x0 + 1, y0, c) * tx;
      const b = this.texel(x0, y0 + 1, c) * (1 - tx) + this.texel(x0 + 1, y0 + 1, c) * tx;
      out[c] = a * (1 - ty) + b * ty;
    }
    return out;
  }

  blurred(sigma: number): SideFrame {
    const key = Math.round(sigma * 1000);
    const cached = this.blurs.get(key);
    if (cached) return cached;
    const radius = Math.ceil(4 * sigma);
    const weights = Array.from({ length: radius + 1 }, (_, i) => Math.exp((-i * i) / (2 * sigma * sigma)));
    const total = weights[0]! + 2 * weights.slice(1).reduce((sum, w) => sum + w, 0);
    const across = new Float32Array(W * H * 3);
    const down = new Float32Array(W * H * 3);
    const pass = (from: Float32Array, into: Float32Array, dx: number, dy: number): void => {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let i = -radius; i <= radius; i++) {
              const sx = Math.min(W - 1, Math.max(0, x + i * dx));
              const sy = Math.min(H - 1, Math.max(0, y + i * dy));
              sum += weights[Math.abs(i)]! * from[(sy * W + sx) * 3 + c]!;
            }
            into[(y * W + x) * 3 + c] = sum / total;
          }
        }
      }
    };
    pass(this.data, across, 1, 0);
    pass(across, down, 0, 1);
    const frame = new SideFrame(down);
    this.blurs.set(key, frame);
    return frame;
  }

  private texel(x: number, y: number, c: number): number {
    const cx = Math.min(W - 1, Math.max(0, x));
    const cy = Math.min(H - 1, Math.max(0, y));
    return this.data[(cy * W + cx) * 3 + c]!;
  }
}

interface Sides {
  from: SideFrame;
  to: SideFrame;
}

function reference(sides: Sides, t: Pick<ComposeTransition, 'mask' | 'fromTint' | 'toTint'>, look: TransitionLook, qx: number, qy: number): RGB {
  return transitionPixel(t, look, qx, qy, W, H, (side, x, y, sigma) => (sigma >= 0.25 ? sides[side].blurred(sigma) : sides[side]).at(x, y));
}

interface Verdict {
  compared: number;
  total: number;
  worst: number;
  where: string;
}

/**
 * The painter's frame against the reference over a grid of pixel centres, leaving out only pixels
 * on a discontinuity of the reference itself.
 */
function judge(actual: Uint8ClampedArray, expected: (qx: number, qy: number) => RGB, step = 2, nudge = NUDGE): Verdict {
  let compared = 0;
  let total = 0;
  let worst = 0;
  let where = '';
  for (let py = 1; py < H; py += step) {
    for (let px = 1; px < W; px += step) {
      total += 1;
      const qx = px + 0.5;
      const qy = py + 0.5;
      const want = expected(qx, qy);
      const steady = [
        [nudge, 0],
        [-nudge, 0],
        [0, nudge],
        [0, -nudge],
      ].every(([dx, dy]) => {
        const near = expected(qx + dx!, qy + dy!);
        return Math.abs(near[0] - want[0]) <= STEADY && Math.abs(near[1] - want[1]) <= STEADY && Math.abs(near[2] - want[2]) <= STEADY;
      });
      if (!steady) continue;
      compared += 1;
      const at = (py * W + px) * 4;
      for (let c = 0; c < 3; c++) {
        const miss = Math.abs((actual[at + c] ?? 0) / 255 - want[c]);
        if (miss > worst) {
          worst = miss;
          where = `(${px}, ${py}) channel ${c}: drew ${actual[at + c]}, reference ${Math.round(want[c] * 255)}`;
        }
      }
    }
  }
  return { compared, total, worst, where };
}

/** Largest channel difference between two whole frames, in levels. */
function largestDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let largest = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    largest = Math.max(largest, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return largest;
}

function pixel(data: Uint8ClampedArray, x: number, y: number): [number, number, number] {
  const at = (y * W + x) * 4;
  return [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0];
}

function side(over: Partial<TransitionSide> = {}): TransitionSide {
  return { ...NEUTRAL_SIDE, ...over };
}

function drawOf(kind: string, p: number, from: LayerDraw | null, to: LayerDraw | null): TransitionDraw {
  const compiled = compileTransition(kind);
  if (!compiled) throw new Error(`no transition ${kind}`);
  return { kind: 'transition', from, to, look: lookAt(compiled.curves, p), transition: compiled };
}

/** The painter, with or without its GPU. Without is how the 2D fallback is reached in a browser that has one. */
function painterFor(gpu: boolean): Painter {
  if (gpu) return new Painter({ width: W, height: H });
  const real = HTMLCanvasElement.prototype.getContext;
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string, options?: unknown) {
    return type === 'webgl2' ? null : (real as (this: HTMLCanvasElement, type: string, options?: unknown) => RenderingContext | null).call(this, type, options);
  } as typeof real);
  try {
    return new Painter({ width: W, height: H });
  } finally {
    spy.mockRestore();
  }
}

describe('a transition on the GPU, against the reference drawing', () => {
  let painter: Painter;
  let from: LayerDraw;
  let to: LayerDraw;
  let fromFrame: Uint8ClampedArray;
  let toFrame: Uint8ClampedArray;
  let sides: Sides;

  beforeAll(() => {
    painter = painterFor(true);
    painter.setColour(null, { filter: 'none', tints: [] });
    from = layerOf(outgoingSource(), 'contain');
    to = layerOf(incomingSource(), 'cover');
    painter.paintLayers([from]);
    fromFrame = pixels(painter);
    painter.paintLayers([to]);
    toFrame = pixels(painter);
    sides = { from: SideFrame.of(fromFrame), to: SideFrame.of(toFrame) };
  });

  afterAll(() => painter.dispose());

  it('has a GPU to test', () => {
    // Every case below is about the shader; a browser without WebGL2 would test the fallback twice.
    expect(painter.usesGpu).toBe(true);
    // The outgoing side really is letterboxed: its top rows are bars.
    expect(pixel(fromFrame, 45, 10)).toEqual([0, 0, 0]);
    expect(pixel(fromFrame, 20, 80)[0]).toBeGreaterThan(240);
  });

  for (const preset of TRANSITIONS) {
    it(`draws ${preset.id} as the reference does`, () => {
      const compiled = compileTransition(preset.id)!;
      for (const p of MOMENTS) {
        const draw = drawOf(preset.id, p, from, to);
        painter.paintLayers([draw]);
        const verdict = judge(pixels(painter), (qx, qy) => reference(sides, compiled, draw.look, qx, qy));
        expect(verdict.compared / verdict.total, `${preset.id} at ${p}: compared too little of the frame`).toBeGreaterThanOrEqual(MIN_COMPARED);
        expect(verdict.worst, `${preset.id} at ${p}: ${verdict.where}`).toBeLessThanOrEqual(TOLERANCE);
      }
    });

    it(`starts ${preset.id} on the outgoing frame and ends it on the incoming one`, () => {
      painter.paintLayers([drawOf(preset.id, 0, from, to)]);
      expect(largestDifference(pixels(painter), fromFrame), `${preset.id} at 0`).toBeLessThanOrEqual(2);
      painter.paintLayers([drawOf(preset.id, 1, from, to)]);
      expect(largestDifference(pixels(painter), toFrame), `${preset.id} at 1`).toBeLessThanOrEqual(2);
    });
  }

  it('draws every mask shape the contract names, at any angle and either way round', () => {
    /*
     * The catalogue alone leaves most of the contract's mask unrun: nothing in it is a diamond or a
     * split, no linear edge travels off the axes, and every transition tints both sides the same
     * colour, so a shader that measured a diamond by the wrong half-size or tinted the incoming side
     * with the outgoing side's colour would pass every case above. The contract is what the native
     * engines draw, so all of it is held to the reference here.
     */
    for (const shape of MASK_SHAPES) {
      for (const angleDeg of [0, 35, 200]) {
        for (const invert of [false, true]) {
          for (const reveal of [0.3, 0.65]) {
            const transition: TransitionDraw['transition'] = {
              mask: { shape, angleDeg, count: 3, feather: 0.05, invert },
              fromTint: [0.9, 0.2, 0.1],
              toTint: [0.1, 0.3, 0.95],
            };
            const look: TransitionLook = { alpha: 0.85, reveal, from: side({ gain: 1.3, tint: 0.35 }), to: side({ gain: 0.8, tint: 0.45 }) };
            painter.paintLayers([{ kind: 'transition', from, to, look, transition }]);
            const verdict = judge(pixels(painter), (qx, qy) => reference(sides, transition, look, qx, qy));
            const label = `${shape} at ${angleDeg} degrees, ${invert ? 'inverted' : 'upright'}, open ${reveal}`;
            expect(verdict.compared / verdict.total, `${label}: compared too little of the frame`).toBeGreaterThanOrEqual(MIN_COMPARED);
            expect(verdict.worst, `${label}: ${verdict.where}`).toBeLessThanOrEqual(TOLERANCE);
          }
        }
      }
    }
  });

  it('dissolves a letterboxed side as a WHOLE frame, its bars fading with it', () => {
    const red = layerOf(
      paintSource(90, 160, () => [255, 0, 0]),
      'cover',
    );
    const boxed = layerOf(
      paintSource(40, 40, () => [0, 0, 255]),
      'contain',
    );
    // Halfway through a dissolve INTO the letterboxed clip, its bars are half over the red: the
    // incoming frame is its picture AND its black, so the red dims there rather than staying red.
    const look: TransitionLook = { alpha: 0.5, reveal: 1, from: side(), to: side() };
    painter.paintLayers([{ kind: 'transition', from: red, to: boxed, look, transition: {} }]);
    const into = pixels(painter);
    const bar = pixel(into, 45, 10);
    expect(bar[0]).toBeGreaterThan(118);
    expect(bar[0]).toBeLessThan(138);
    expect(bar[2]).toBeLessThan(6);
    const middle = pixel(into, 45, 80);
    expect(middle[0]).toBeGreaterThan(118);
    expect(middle[2]).toBeGreaterThan(118);

    // ...and out of it: the outgoing bars fade into the incoming picture rather than hold black.
    painter.paintLayers([{ kind: 'transition', from: boxed, to: red, look, transition: {} }]);
    const out = pixel(pixels(painter), 45, 10);
    expect(out[0]).toBeGreaterThan(118);
    expect(out[0]).toBeLessThan(138);
  });

  it('moves the bars WITH the picture on a slide', () => {
    // Halfway through a slide left, the incoming frame covers the right half and the outgoing one
    // has drifted a sixth of the width (13.5 px of 90) left under it, darkened by 0.175 - bars and
    // all, so the top of the left half is still black.
    const draw = drawOf('slide-left', 0.5, from, to);
    painter.paintLayers([draw]);
    const frame = pixels(painter);
    expect(pixel(frame, 20, 10)).toEqual([0, 0, 0]);
    // Output x 35 reads the outgoing frame at 48.5, past its green step at 45: the frame moved left.
    // Unmoved, the same pixel would have no green at all.
    const moved = pixel(frame, 35, 80);
    expect(moved[1]).toBeGreaterThan(195);
    expect(moved[1]).toBeLessThan(225);
    expect(moved[0]).toBeGreaterThan(114);
    expect(moved[0]).toBeLessThan(134);
    // ...and the incoming frame has arrived from the right, its blue left edge right of centre.
    const blue = pixel(frame, 60, 80);
    expect(blue[2]).toBeGreaterThan(240);
    expect(blue[1]).toBeLessThan(120);
  });

  it('draws a side with no picture yet as absent, not as black', () => {
    const look: TransitionLook = { alpha: 0.5, reveal: 1, from: side(), to: side() };
    // No incoming frame: the outgoing one alone, untouched.
    painter.paintLayers([{ kind: 'transition', from, to: null, look, transition: {} }]);
    expect(largestDifference(pixels(painter), fromFrame)).toBeLessThanOrEqual(2);
    // No outgoing frame: the incoming one at half strength over black.
    painter.paintLayers([{ kind: 'transition', from: null, to, look, transition: {} }]);
    const half = pixels(painter);
    const [r, g, b] = pixel(toFrame, 45, 80);
    const [hr, hg, hb] = pixel(half, 45, 80);
    expect(Math.abs(hr - r / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(hg - g / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(hb - b / 2)).toBeLessThanOrEqual(2);
  });

  it('paints the layers after a transition over it', () => {
    const white = layerOf(
      paintSource(20, 20, () => [255, 255, 255]),
      'cover',
    );
    // The right half of the frame, a quarter of it down from the middle: x 45..90, y 80..120.
    painter.paintLayers([drawOf('dissolve', 0.5, from, to), { ...white, dest: { x: 0.5, y: 0.5, w: 0.5, h: 0.25 } }]);
    const frame = pixels(painter);
    expect(pixel(frame, 70, 100)).toEqual([255, 255, 255]);
    // ...and not over the rest of it.
    expect(pixel(frame, 20, 80)[2]).toBeGreaterThan(100);
  });

  it('leaves the painter exactly as it found it for the frames after', () => {
    // A frame drawn right after a transition must be the frame a painter that never drew one draws:
    // any program, blend or framebuffer left behind would show here.
    const fresh = painterFor(true);
    fresh.setColour({ m: [0.8, 0.1, 0, 0, 0.9, 0.1, 0.1, 0, 0.7], o: [0.05, 0, 0.02] }, { filter: 'none', tints: [] });
    fresh.paintLayers([from]);
    const expected = pixels(fresh);
    fresh.dispose();

    painter.setColour({ m: [0.8, 0.1, 0, 0, 0.9, 0.1, 0.1, 0, 0.7], o: [0.05, 0, 0.02] }, { filter: 'none', tints: [] });
    painter.paintLayers([drawOf('whip-left', 0.5, from, to)]);
    painter.paintLayers([from]);
    const after = pixels(painter);
    painter.setColour(null, { filter: 'none', tints: [] });
    expect(largestDifference(after, expected)).toBe(0);
  });

  it('grades each side before it moves, exactly as it grades a clip with no transition', () => {
    // The colour matrix goes on each SIDE's picture - not on the finished mix, where it would tint
    // the bars - so the frame at p = 0 under a grade is the graded outgoing frame, bars still black.
    const grade = { m: [0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5], o: [0.3, 0, 0] };
    painter.setColour(grade, { filter: 'none', tints: [] });
    painter.paintLayers([from]);
    const graded = pixels(painter);
    painter.paintLayers([drawOf('dissolve', 0, from, to)]);
    const start = pixels(painter);
    painter.setColour(null, { filter: 'none', tints: [] });
    expect(largestDifference(start, graded)).toBeLessThanOrEqual(1);
    expect(pixel(start, 45, 10)).toEqual([0, 0, 0]);
  });
});

describe('the GPU blur', () => {
  let painter: Painter;
  let from: LayerDraw;
  let sides: Sides;

  beforeAll(() => {
    painter = painterFor(true);
    painter.setColour(null, { filter: 'none', tints: [] });
    from = layerOf(outgoingSource(), 'contain');
    painter.paintLayers([from]);
    const frame = SideFrame.of(pixels(painter));
    sides = { from: frame, to: frame };
  });

  afterAll(() => painter.dispose());

  function blurredBy(blur: number): Uint8ClampedArray {
    const look: TransitionLook = { alpha: 0, reveal: 1, from: side({ blur }), to: side() };
    painter.paintLayers([{ kind: 'transition', from, to: null, look, transition: {} }]);
    return pixels(painter);
  }

  it('is a true Gaussian of the sigma asked for, at full size', () => {
    // 0.03 of the shorter side is 2.7 pixels here: blurred at full size, no halving.
    const blur = 0.03;
    const look: TransitionLook = { alpha: 0, reveal: 1, from: side({ blur }), to: side() };
    const verdict = judge(blurredBy(blur), (qx, qy) => reference(sides, {}, look, qx, qy), 1);
    expect(verdict.worst, verdict.where).toBeLessThanOrEqual(4 / 255);
    expect(verdict.compared / verdict.total).toBeGreaterThan(0.95);
  });

  it('is still that Gaussian when the frame is halved to blur it', () => {
    // 0.2 of the shorter side is 18 pixels: halved three times, blurred at a sigma of about two
    // texels, and read back up. What the halvings and the read back add is taken off the sigma, so
    // the result is the full-size Gaussian to within a few levels everywhere.
    const blur = 0.2;
    const look: TransitionLook = { alpha: 0, reveal: 1, from: side({ blur }), to: side() };
    const verdict = judge(blurredBy(blur), (qx, qy) => reference(sides, {}, look, qx, qy), 2);
    expect(verdict.compared / verdict.total).toBeGreaterThan(0.95);
    expect(verdict.worst, verdict.where).toBeLessThanOrEqual(10 / 255);
  });

  it('clamps the edges rather than darkening them', () => {
    // Right at the frame's left edge, halfway down, the picture is red: blurred with the edge
    // clamped it stays red rather than fading towards the black a transparent border would give.
    const frame = blurredBy(0.05);
    expect(pixel(frame, 0, 80)[0]).toBeGreaterThan(245);
  });
});

describe('a transition without a GPU', () => {
  let painter: Painter;
  let from: LayerDraw;
  let to: LayerDraw;
  let fromFrame: Uint8ClampedArray;
  let toFrame: Uint8ClampedArray;
  let sides: Sides;

  beforeAll(() => {
    painter = painterFor(false);
    painter.setColour(null, { filter: 'none', tints: [] });
    from = layerOf(outgoingSource(), 'contain');
    to = layerOf(incomingSource(), 'cover');
    painter.paintLayers([from]);
    fromFrame = pixels(painter);
    painter.paintLayers([to]);
    toFrame = pixels(painter);
    sides = { from: SideFrame.of(fromFrame), to: SideFrame.of(toFrame) };
  });

  afterAll(() => painter.dispose());
  afterEach(() => vi.restoreAllMocks());

  it('really is the 2D path', () => {
    expect(painter.usesGpu).toBe(false);
  });

  for (const preset of TRANSITIONS) {
    it(`starts and ends ${preset.id} on the right frames`, () => {
      painter.paintLayers([drawOf(preset.id, 0, from, to)]);
      expect(largestDifference(pixels(painter), fromFrame), `${preset.id} at 0`).toBeLessThanOrEqual(2);
      painter.paintLayers([drawOf(preset.id, 1, from, to)]);
      expect(largestDifference(pixels(painter), toFrame), `${preset.id} at 1`).toBeLessThanOrEqual(2);
    });
  }

  /*
   * The fallback approximates a blur, a mosaic and a colour split, and says so. Everything else it
   * draws exactly - a move, a turn, a scale, gain, tint, the mask - and those transitions are held
   * to the reference here, with a little more room than the GPU gets for the canvas's own
   * antialiasing where a moved frame's edge crosses a pixel.
   */
  const EXACT = TRANSITIONS.map(preset => preset.id).filter(id => {
    const curves = compileTransition(id)!.curves;
    return ![curves.from, curves.to].some(side => side && (side.blur || side.pixelate || side.split));
  });

  for (const id of EXACT) {
    it(`draws ${id} as the reference does`, () => {
      const compiled = compileTransition(id)!;
      for (const p of MOMENTS) {
        const draw = drawOf(id, p, from, to);
        painter.paintLayers([draw]);
        const verdict = judge(pixels(painter), (qx, qy) => reference(sides, compiled, draw.look, qx, qy), 2, NUDGE_2D);
        expect(verdict.compared / verdict.total, `${id} at ${p}: compared too little of the frame`).toBeGreaterThanOrEqual(MIN_COMPARED);
        expect(verdict.worst, `${id} at ${p}: ${verdict.where}`).toBeLessThanOrEqual(16 / 255);
      }
    });
  }

  it('draws every mask shape and each side in its own tint colour', () => {
    // The fallback's mask IS `maskAlpha`, so this is less about the shapes than about the plumbing
    // around them: the right tint on the right side, the mask cutting the incoming side only.
    for (const shape of MASK_SHAPES) {
      for (const invert of [false, true]) {
        const transition: TransitionDraw['transition'] = {
          mask: { shape, angleDeg: 35, count: 3, feather: 0.05, invert },
          fromTint: [0.9, 0.2, 0.1],
          toTint: [0.1, 0.3, 0.95],
        };
        const look: TransitionLook = { alpha: 0.85, reveal: 0.5, from: side({ gain: 1.3, tint: 0.35 }), to: side({ gain: 0.8, tint: 0.45 }) };
        painter.paintLayers([{ kind: 'transition', from, to, look, transition }]);
        const verdict = judge(pixels(painter), (qx, qy) => reference(sides, transition, look, qx, qy), 2, NUDGE_2D);
        const label = `${shape}, ${invert ? 'inverted' : 'upright'}`;
        expect(verdict.compared / verdict.total, `${label}: compared too little of the frame`).toBeGreaterThanOrEqual(MIN_COMPARED);
        expect(verdict.worst, `${label}: ${verdict.where}`).toBeLessThanOrEqual(16 / 255);
      }
    }
  });

  it('draws the approximated ones close to the reference where it matters', () => {
    // The blurred, pixelated and split transitions, with room for the approximations: a mistake in
    // direction or order would still miss by far more than this.
    for (const id of TRANSITIONS.map(preset => preset.id).filter(id => !EXACT.includes(id))) {
      const compiled = compileTransition(id)!;
      for (const p of MOMENTS) {
        const draw = drawOf(id, p, from, to);
        painter.paintLayers([draw]);
        const drawn = pixels(painter);
        const mean = meanMiss(drawn, (qx, qy) => reference(sides, compiled, draw.look, qx, qy));
        expect(mean, `${id} at ${p}: mean miss`).toBeLessThanOrEqual(12 / 255);
      }
    }
  });
});

/** The mean channel difference over the grid, for the approximated paths: the worst is at edges by design. */
function meanMiss(actual: Uint8ClampedArray, expected: (qx: number, qy: number) => RGB, step = 3): number {
  let sum = 0;
  let count = 0;
  for (let py = 1; py < H; py += step) {
    for (let px = 1; px < W; px += step) {
      const want = expected(px + 0.5, py + 0.5);
      const at = (py * W + px) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs((actual[at + c] ?? 0) / 255 - want[c]);
      count += 3;
    }
  }
  return sum / count;
}

describe('a painter whose GPU context is lost', () => {
  /*
   * A lost WebGL context draws nothing and throws nothing. Before the painter checked for it, the
   * frame it handed on was the last one the context had drawn, forever: a preview frozen on one
   * picture and a web render encoding that picture to the end of the post, without a word.
   */
  it('goes on drawing on the 2D path instead of holding its last frame', () => {
    const painter = new Painter({ width: W, height: H });
    try {
      const red = layerOf(paintSource(10, 10, () => [255, 0, 0]), 'cover');
      const blue = layerOf(paintSource(10, 10, () => [0, 0, 255]), 'cover');
      painter.paintLayers([red]);
      expect(pixel(pixels(painter), 45, 80)[0]).toBeGreaterThan(240);
      const gl = (painter as unknown as { gl: WebGL2RenderingContext | null }).gl;
      const lose = gl?.getExtension('WEBGL_lose_context');
      // Without a GPU the 2D path is the only one there is, and nothing here can be lost.
      if (!lose) return;
      lose.loseContext();
      painter.paintLayers([blue]);
      const [r, , b] = pixel(pixels(painter), 45, 80);
      expect(b).toBeGreaterThan(240);
      expect(r).toBeLessThan(15);
      expect(painter.usesGpu).toBe(false);
    } finally {
      painter.dispose();
    }
  });
});
