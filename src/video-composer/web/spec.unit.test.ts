import { describe, expect, it } from 'vitest';

import type { ComposeClip, ComposeSpec } from '../definitions';

import { SpecError, validateSpec } from './spec';

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

  it('refuses more layers than there are decoders for, rather than dropping one', () => {
    expect(() =>
      validateSpec(
        spec({
          tracks: [
            { id: 'a', clips: [clip()], z: 1 },
            { id: 'b', clips: [clip()], z: 2 },
          ],
        }),
      ),
    ).toThrow(/at most 1 extra video track/);
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

  it('slides a rectangle back inside the frame rather than squashing it', () => {
    const checked = validateSpec(spec({ clips: [clip({ crop: { x: 0.9, y: 0, w: 0.5, h: 1 } })] }));
    // The size asked for is kept; a crop dragged to the right edge must not become a black frame.
    expect(checked.clips[0]?.crop).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
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
