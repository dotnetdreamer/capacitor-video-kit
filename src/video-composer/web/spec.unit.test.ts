import { describe, expect, it } from 'vitest';

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
    pendingPostId: 'p',
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
