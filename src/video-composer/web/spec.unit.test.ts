import { describe, expect, it } from 'vitest';

import { TRANSITIONS, compileTransition } from '../../editor/transitions';
import type { ComposeClip, ComposeSpec } from '../definitions';

import { MAX_VIDEO_TRACKS, SpecError, validateSpec } from './spec';

/**
 * The refusals, which have to be the same refusals `ComposeSpecParser` makes.
 *
 * The split is the point of the file: a SHAPE error is a caller bug and fails the call with the
 * path that broke, while a value merely out of RANGE is clamped, because a render that comes out
 * slightly different beats a post the customer cannot make.
 */

const PNG = 'data:image/png;base64,AAAA';

function clip(over: Partial<ComposeClip> = {}): ComposeClip {
  return {
    key: 'c',
    uri: 'file:///a.mp4',
    inMs: 0,
    outMs: 1000,
    speed: 1,
    volume: 1,
    muted: false,
    fit: 'contain',
    ...over,
  };
}

function spec(over: Partial<ComposeSpec> = {}): ComposeSpec {
  return {
    jobId: 'j',
    batchId: 'p',
    clips: [clip()],
    output: { width: 720, height: 1280, fps: 30, videoBitrate: 6_000_000, audioBitrate: 128_000 },
    filter: [],
    overlays: [],
    audio: { originalMuted: false, originalVolume: 1, music: null, voiceover: [] },
    posterAtMs: 500,
    ...over,
  };
}

describe('refusals', () => {
  it('names the path that broke', () => {
    expect(() => validateSpec(spec({ jobId: '' }))).toThrow(SpecError);
    try {
      validateSpec(spec({ clips: [] }));
      expect.unreachable('an empty clip list is not a render');
    } catch (error) {
      expect((error as SpecError).path).toBe('clips');
    }
  });

  it('refuses a clip whose out is not after its in', () => {
    expect(() => validateSpec(spec({ clips: [clip({ outMs: 0 })] }))).toThrow(/clips\[0\]\.outMs/);
  });

  it('refuses a zero-sized output', () => {
    expect(() => validateSpec(spec({ output: { ...spec().output, width: 0 } }))).toThrow(/output\.width/);
  });

  it('refuses an overlay that is not a PNG data URL, because the engine places bitmaps only', () => {
    expect(() =>
      validateSpec(
        spec({
          overlays: [
            {
              id: 'o',
              png: 'https://example.com/sticker.png',
              cx: 0.5,
              cy: 0.5,
              wPx: 10,
              hPx: 10,
              rotationDeg: 0,
              startMs: 0,
              endMs: 100,
              opacity: 1,
            },
          ],
        }),
      ),
    ).toThrow(/overlays\[0\]\.png/);
  });

  it('takes as many layers as the contract allows, and refuses the one past it', () => {
    // The cap is NOT a decoder budget, which is what it used to be and what this test used to
    // assert: the export composites offline, and what a device can play at once is the preview's
    // business. It is a ceiling so an absurd spec comes back as a sentence rather than as an out
    // of memory kill, and it is the contract's own number so this renderer cannot drift from the
    // Swift and Kotlin ones again.
    const tracks = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `t${i}`, clips: [clip()], z: i + 1 }));

    expect(() => validateSpec(spec({ tracks: tracks(MAX_VIDEO_TRACKS - 1) }))).not.toThrow();
    expect(() => validateSpec(spec({ tracks: tracks(MAX_VIDEO_TRACKS) }))).toThrow(
      new RegExp(`at most ${MAX_VIDEO_TRACKS - 1} extra video track`),
    );
  });

  it('refuses a filter op it does not know', () => {
    expect(() =>
      // A caller that invents an op is a caller whose post would come out the wrong colour.
      validateSpec(spec({ filter: [{ op: 'vignette', amount: 1 } as never] })),
    ).toThrow(/filter\[0\]\.op/);
  });
});

describe('clamps', () => {
  it('brings a speed, a volume and an opacity back into range', () => {
    const checked = validateSpec(
      spec({
        clips: [clip({ speed: 8, volume: -1 })],
        overlays: [
          {
            id: 'o',
            png: PNG,
            cx: 0.5,
            cy: 0.5,
            wPx: 10,
            hPx: 10,
            rotationDeg: 0,
            startMs: 0,
            endMs: 100,
            opacity: 1.4,
          },
        ],
      }),
    );
    expect(checked.clips[0]?.speed).toBe(4);
    expect(checked.clips[0]?.volume).toBe(0);
    expect(checked.overlays[0]?.opacity).toBe(1);
  });

  it('slides a crop back inside the source rather than squashing it', () => {
    const checked = validateSpec(spec({ clips: [clip({ crop: { x: 0.9, y: 0, w: 0.5, h: 1 } })] }));
    // The size asked for is kept; a crop dragged to the right edge must not become a black frame.
    expect(checked.clips[0]?.crop).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it('leaves a placement hanging off the frame where the customer put it', () => {
    // A crop is a window on the source and cannot leave it. A placement says where the picture is
    // DRAWN, and this renderer cuts at the output frame like the other three, so a video dragged
    // half off the canvas has to reach it with its overhang intact or the browser draws a
    // different post from the one the preview showed.
    const checked = validateSpec(spec({ clips: [clip({ rect: { x: -0.3, y: 0.4, w: 0.6, h: 0.6 } })] }));
    expect(checked.clips[0]?.rect).toEqual({ x: -0.3, y: 0.4, w: 0.6, h: 0.6 });
  });

  it('leaves a strip of a placement on the frame, and caps how large it may be', () => {
    const far = validateSpec(spec({ clips: [clip({ rect: { x: -4, y: 9, w: 0.5, h: 0.5 } })] }));
    // Far past half off, stopping only where the rectangle would leave the frame altogether.
    expect(far.clips[0]?.rect?.x).toBeCloseTo(1 / 12 - 0.5, 4);
    expect(far.clips[0]?.rect?.y).toBeCloseTo(1 - 1 / 12, 4);

    const huge = validateSpec(spec({ clips: [clip({ rect: { x: 0, y: 0, w: 9, h: 5 } })] }));
    expect(huge.clips[0]?.rect).toEqual({ x: 0, y: 0, w: 2, h: 2 });
  });

  it('carries a placement ANGLE, which the renderer now turns the picture by', () => {
    const turned = validateSpec(spec({ clips: [clip({ rect: { x: 0.2, y: 0.2, w: 0.5, h: 0.5, rotationDeg: 30 } })] }));
    expect(turned.clips[0]?.rect?.rotationDeg).toBe(30);
    // Not wrapped into a single turn: a gesture spun twice round keeps its total, and the painter
    // reduces the angle itself the moment it takes a cosine of it.
    const spun = validateSpec(spec({ clips: [clip({ rect: { x: 0, y: 0, w: 1, h: 1, rotationDeg: 400 } })] }));
    expect(spun.clips[0]?.rect?.rotationDeg).toBe(400);
  });

  it('drops a whole number of turns rather than storing it as an angle', () => {
    // A missing key is what tells the painter there is no transform to build, so a rectangle turned
    // right round and a rectangle nobody touched have to produce the same spec.
    const upright = validateSpec(spec({ clips: [clip({ rect: { x: 0, y: 0, w: 0.5, h: 0.5, rotationDeg: -720 } })] }));
    expect(upright.clips[0]?.rect).not.toHaveProperty('rotationDeg');
  });

  it('ignores an angle that arrives on a CROP, which is a window and not a picture', () => {
    const cropped = validateSpec(
      spec({ clips: [clip({ crop: { x: 0, y: 0, w: 0.5, h: 0.5, rotationDeg: 45 } as never })] }),
    );
    expect(cropped.clips[0]?.crop).not.toHaveProperty('rotationDeg');
  });

  it('leaves an absent crop and rect absent, which is what every engine tests for', () => {
    const checked = validateSpec(spec());
    expect(checked.clips[0]).not.toHaveProperty('crop');
    expect(checked.clips[0]).not.toHaveProperty('rect');
    expect(checked).not.toHaveProperty('tracks');
  });

  it('copies rather than aliasing, so a caller still editing cannot change the render', () => {
    const original = spec();
    const checked = validateSpec(original);
    const first = original.clips[0];
    if (first) first.speed = 0.5;
    expect(checked.clips[0]?.speed).toBe(1);
  });
});

/*
 * Transitions. The paths below are the contract: the Kotlin and Swift parsers name the same ones,
 * in the same order, so a spec that is refused is refused with the same words on every engine.
 */
describe('a transition into a base clip', () => {
  const SAMPLES = 41;
  const ramp = (from = 0, to = 1, n = SAMPLES): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

  /** A dissolve into the second clip, its tail the last half second of the first, as `compose.ts` lowers one. */
  function transition(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: 'dissolve',
      from: clip({ key: 'a', inMs: 500, outMs: 1000 }),
      curves: { alpha: ramp() },
      ...over,
    };
  }

  function withTransition(value: unknown): ComposeSpec {
    return spec({ clips: [clip({ key: 'a', outMs: 500 }), { ...clip({ key: 'b' }), transitionIn: value } as unknown as ComposeClip] });
  }

  /** The path a refusal names; a spec that is NOT refused fails the test. */
  function pathOf(value: unknown): string {
    try {
      validateSpec(withTransition(value));
    } catch (error) {
      expect(error).toBeInstanceOf(SpecError);
      return (error as SpecError).path;
    }
    throw new Error('expected a refusal');
  }

  it('reads one on the second clip, copied, with the tail read as a clip', () => {
    const checked = validateSpec(withTransition(transition({ mask: { shape: 'linear', angleDeg: 90 }, fromTint: [1, 1, 1] })));
    const read = checked.clips[1]?.transitionIn;
    expect(read?.kind).toBe('dissolve');
    expect(read?.from).toEqual({ key: 'a', uri: 'file:///a.mp4', inMs: 500, outMs: 1000, speed: 1, volume: 1, muted: false, fit: 'contain' });
    expect(read?.curves.alpha).toEqual(ramp());
    // Every default written out, so no engine downstream has to know them.
    expect(read?.mask).toEqual({ shape: 'linear', angleDeg: 90, count: 1, feather: 0.01, invert: false });
    expect(read?.fromTint).toEqual([1, 1, 1]);
    expect(read).not.toHaveProperty('toTint');
    expect(checked.clips[0]).not.toHaveProperty('transitionIn');
  });

  it('carries every catalogue transition through untouched', () => {
    for (const preset of TRANSITIONS) {
      const compiled = JSON.parse(JSON.stringify(compileTransition(preset.id))) as Record<string, unknown> & { curves: unknown; mask?: { shape: string } };
      const read = validateSpec(withTransition({ ...compiled, from: clip({ key: 'a', inMs: 500, outMs: 1000 }) })).clips[1]?.transitionIn;
      expect(read?.curves, preset.id).toEqual(compiled.curves);
      expect(read?.mask?.shape, preset.id).toBe(compiled.mask?.shape);
    }
  });

  it('leaves a transition absent where there is none, and reads null as none', () => {
    expect(validateSpec(withTransition(undefined)).clips[1]).not.toHaveProperty('transitionIn');
    expect(validateSpec(withTransition(null)).clips[1]).not.toHaveProperty('transitionIn');
    const bare = validateSpec(withTransition(transition({ mask: null, fromTint: null, curves: { alpha: ramp(), from: null } }))).clips[1]?.transitionIn;
    expect(bare).not.toHaveProperty('mask');
    expect(bare).not.toHaveProperty('fromTint');
    expect(bare?.curves).not.toHaveProperty('from');
  });

  it('does not so much as look at one on the first clip or on a layer clip', () => {
    const checked = validateSpec(
      spec({
        clips: [{ ...clip(), transitionIn: 42 } as unknown as ComposeClip],
        tracks: [{ id: 't', z: 1, clips: [clip(), { ...clip(), transitionIn: 'nonsense' } as unknown as ComposeClip] }],
      }),
    );
    expect(checked.clips[0]).not.toHaveProperty('transitionIn');
    expect(checked.tracks?.[0]?.clips[1]).not.toHaveProperty('transitionIn');
  });

  it('refuses one that is not an object', () => {
    expect(pathOf(42)).toBe('clips[1].transitionIn');
    expect(pathOf([transition()])).toBe('clips[1].transitionIn');
  });

  it('refuses a missing or empty kind', () => {
    expect(pathOf(transition({ kind: undefined }))).toBe('clips[1].transitionIn.kind');
    expect(pathOf(transition({ kind: '' }))).toBe('clips[1].transitionIn.kind');
    expect(pathOf(transition({ kind: 7 }))).toBe('clips[1].transitionIn.kind');
  });

  it('reads the tail with the clip reader, at its own path', () => {
    expect(pathOf(transition({ from: undefined }))).toBe('clips[1].transitionIn.from');
    expect(pathOf(transition({ from: clip({ inMs: 900, outMs: 800 }) }))).toBe('clips[1].transitionIn.from.outMs');
    expect(pathOf(transition({ from: { ...clip(), uri: '' } }))).toBe('clips[1].transitionIn.from.uri');
  });

  it('refuses missing curves, and curves that are not an object', () => {
    expect(pathOf(transition({ curves: undefined }))).toBe('clips[1].transitionIn.curves');
    expect(pathOf(transition({ curves: [ramp()] }))).toBe('clips[1].transitionIn.curves');
  });

  it('refuses alpha or reveal that is not a list of finite numbers', () => {
    for (const name of ['alpha', 'reveal']) {
      for (const bad of ['0.5', [0, '1'], [0, Number.NaN], [0, Infinity], { 0: 1 }]) {
        expect(pathOf(transition({ curves: { [name]: bad } }))).toBe(`clips[1].transitionIn.curves.${name}`);
      }
    }
  });

  it('refuses a side that is not an object, and every side channel that is not a list of numbers', () => {
    for (const side of ['from', 'to']) {
      expect(pathOf(transition({ curves: { [side]: [1] } }))).toBe(`clips[1].transitionIn.curves.${side}`);
      for (const channel of ['x', 'y', 'scale', 'rotation', 'blur', 'pixelate', 'split', 'gain', 'tint']) {
        expect(pathOf(transition({ curves: { [side]: { [channel]: [0, 'x'] } } }))).toBe(`clips[1].transitionIn.curves.${side}.${channel}`);
      }
    }
  });

  it('refuses a key it does not know, at either level, rather than drawing without it', () => {
    expect(pathOf(transition({ curves: { alpha: ramp(), glow: ramp() } }))).toBe('clips[1].transitionIn.curves.glow');
    expect(pathOf(transition({ curves: { to: { x: ramp(), opacity: ramp() } } }))).toBe('clips[1].transitionIn.curves.to.opacity');
  });

  it('holds every curve to one length of 2 to 121, and names the first curve that breaks it', () => {
    const at = (curves: Record<string, unknown>) => pathOf(transition({ curves }));
    expect(at({ alpha: [1] })).toBe('clips[1].transitionIn.curves.alpha');
    expect(at({ alpha: [] })).toBe('clips[1].transitionIn.curves.alpha');
    expect(at({ reveal: ramp(0, 1, 122) })).toBe('clips[1].transitionIn.curves.reveal');
    expect(at({ alpha: ramp(), reveal: ramp(0, 1, 40) })).toBe('clips[1].transitionIn.curves.reveal');
    // Checked in the contract's order, not the object's: alpha sets the length, and to.x is the
    // first after it in that order to disagree, wherever the caller happened to put it.
    expect(at({ to: { x: ramp(0, 1, 5) }, from: { gain: ramp() }, alpha: ramp() })).toBe('clips[1].transitionIn.curves.to.x');
    expect(at({ from: { tint: ramp(0, 1, 3), x: ramp() } })).toBe('clips[1].transitionIn.curves.from.tint');
    // The two ends of the range are fine.
    expect(() => validateSpec(withTransition(transition({ curves: { alpha: [0, 1] } })))).not.toThrow();
    expect(() => validateSpec(withTransition(transition({ curves: { alpha: ramp(0, 1, 121), to: { x: ramp(0, 1, 121) } } })))).not.toThrow();
  });

  /*
   * A spec with TWO things wrong inside its curves, which is where an order could differ between
   * engines. These are the paths Android's `parseCurves` and the Swift `CurvesDTO` name for the same
   * specs: channels before their level's unknown keys, a side's unknown keys before the curves
   * object's own, each curve's own 2..121 as it is read, and the shared length last of all.
   */
  it('checks inside the curves in the order the native parsers do', () => {
    const at = (curves: Record<string, unknown>) => pathOf(transition({ curves }));
    // A broken channel is named before an unknown key beside it, at either level.
    expect(at({ glow: ramp(), alpha: 'bad' })).toBe('clips[1].transitionIn.curves.alpha');
    expect(at({ from: { opacity: ramp(), x: 'bad' } })).toBe('clips[1].transitionIn.curves.from.x');
    // A side's unknown key is named before the curves object's own.
    expect(at({ glow: ramp(), to: { opacity: ramp() } })).toBe('clips[1].transitionIn.curves.to.opacity');
    // Two lengths are only noticed once everything else has been read...
    expect(at({ alpha: ramp(), reveal: ramp(0, 1, 30), to: { x: 'bad' } })).toBe('clips[1].transitionIn.curves.to.x');
    expect(at({ alpha: ramp(), reveal: ramp(0, 1, 30), glow: ramp() })).toBe('clips[1].transitionIn.curves.glow');
    expect(at({ alpha: ramp(), reveal: ramp(0, 1, 30), from: { opacity: ramp() } })).toBe('clips[1].transitionIn.curves.from.opacity');
    // ...but a curve too short or too long to be one is named where it is read.
    expect(at({ alpha: ramp(), reveal: ramp(0, 1, 30), from: { x: [1] } })).toBe('clips[1].transitionIn.curves.from.x');
    expect(at({ alpha: ramp(), reveal: ramp(0, 1, 30), to: { tint: ramp(0, 1, 122) } })).toBe('clips[1].transitionIn.curves.to.tint');
    // With nothing else wrong, the first curve to disagree with the first one read.
    expect(at({ to: { gain: ramp(0, 1, 7) }, from: { y: ramp(0, 1, 7) }, reveal: ramp() })).toBe('clips[1].transitionIn.curves.from.y');
  });

  it('refuses a tail that is not an object as the tail itself', () => {
    expect(pathOf(transition({ from: [clip()] }))).toBe('clips[1].transitionIn.from');
    expect(pathOf(transition({ from: 'a' }))).toBe('clips[1].transitionIn.from');
    expect(pathOf(transition({ from: null }))).toBe('clips[1].transitionIn.from');
  });

  it('refuses a mask that is not an object, or whose shape nobody draws', () => {
    expect(pathOf(transition({ mask: 'circle' }))).toBe('clips[1].transitionIn.mask');
    expect(pathOf(transition({ mask: { shape: 'star' } }))).toBe('clips[1].transitionIn.mask.shape');
    expect(pathOf(transition({ mask: {} }))).toBe('clips[1].transitionIn.mask.shape');
    for (const shape of ['linear', 'circle', 'diamond', 'clock', 'blinds', 'split']) {
      expect(validateSpec(withTransition(transition({ mask: { shape } }))).clips[1]?.transitionIn?.mask?.shape).toBe(shape);
    }
  });

  it('refuses a tint that is not exactly three finite numbers', () => {
    for (const name of ['fromTint', 'toTint']) {
      for (const bad of [[1, 1], [1, 1, 1, 1], [1, Number.NaN, 1], '#fff', { r: 1 }]) {
        expect(pathOf(transition({ [name]: bad }))).toBe(`clips[1].transitionIn.${name}`);
      }
    }
  });

  it('checks the fields in the contract order: kind, from, curves, mask, then the tints', () => {
    const broken = { kind: '', from: null, curves: null, mask: 1, fromTint: 1, toTint: 1 };
    expect(pathOf(broken)).toBe('clips[1].transitionIn.kind');
    expect(pathOf({ ...broken, kind: 'x' })).toBe('clips[1].transitionIn.from');
    expect(pathOf({ ...broken, kind: 'x', from: clip() })).toBe('clips[1].transitionIn.curves');
    expect(pathOf({ ...broken, kind: 'x', from: clip(), curves: {} })).toBe('clips[1].transitionIn.mask');
    expect(pathOf({ ...broken, kind: 'x', from: clip(), curves: {}, mask: null })).toBe('clips[1].transitionIn.fromTint');
    expect(pathOf({ ...broken, kind: 'x', from: clip(), curves: {}, mask: null, fromTint: null })).toBe('clips[1].transitionIn.toTint');
  });

  it('names the clip it is on', () => {
    const three = spec({
      clips: [clip(), clip({ key: 'b' }), { ...clip({ key: 'c' }), transitionIn: transition({ kind: '' }) } as unknown as ComposeClip],
    });
    expect(() => validateSpec(three)).toThrow(/clips\[2\]\.transitionIn\.kind/);
  });

  it('clamps every channel into its range rather than refusing it', () => {
    const read = validateSpec(
      withTransition(
        transition({
          curves: {
            alpha: [-1, 2],
            reveal: [-0.5, 1.5],
            from: { x: [-9, 9], y: [-5, 5], scale: [0, 30], rotation: [-5000, 5000], blur: [-1, 1] },
            to: { pixelate: [-1, 0.7], split: [-1, 1], gain: [-1, 20], tint: [-1, 2] },
          },
        }),
      ),
    ).clips[1]?.transitionIn;
    expect(read?.curves.alpha).toEqual([0, 1]);
    expect(read?.curves.reveal).toEqual([0, 1]);
    expect(read?.curves.from).toEqual({ x: [-4, 4], y: [-4, 4], scale: [0.01, 20], rotation: [-3600, 3600], blur: [0, 0.5] });
    expect(read?.curves.to).toEqual({ pixelate: [0, 0.5], split: [-0.5, 0.5], gain: [0, 10], tint: [0, 1] });
  });

  it('brings a mask and the tints into range, with the defaults the contract names', () => {
    const at = (mask: Record<string, unknown>) => validateSpec(withTransition(transition({ mask }))).clips[1]?.transitionIn?.mask;
    expect(at({ shape: 'blinds' })).toEqual({ shape: 'blinds', angleDeg: 0, count: 1, feather: 0.01, invert: false });
    expect(at({ shape: 'blinds', angleDeg: 'up', count: 2.6, feather: 0, invert: 'yes' })).toEqual({
      shape: 'blinds',
      angleDeg: 0,
      count: 3,
      feather: 0.0005,
      invert: false,
    });
    expect(at({ shape: 'circle', angleDeg: 405, count: 900, feather: 3, invert: true })).toEqual({
      shape: 'circle',
      angleDeg: 405,
      count: 64,
      feather: 0.5,
      invert: true,
    });
    expect(at({ shape: 'blinds', count: -4 })?.count).toBe(1);
    const tints = validateSpec(withTransition(transition({ fromTint: [-1, 0.5, 2], toTint: [0.2, 0.3, 0.4] }))).clips[1]?.transitionIn;
    expect(tints?.fromTint).toEqual([0, 0.5, 1]);
    expect(tints?.toTint).toEqual([0.2, 0.3, 0.4]);
  });

  it('copies the curves rather than aliasing them', () => {
    const alpha = ramp();
    const checked = validateSpec(withTransition(transition({ curves: { alpha } })));
    alpha[20] = 99;
    expect(checked.clips[1]?.transitionIn?.curves.alpha?.[20]).toBeCloseTo(0.5);
  });
});
