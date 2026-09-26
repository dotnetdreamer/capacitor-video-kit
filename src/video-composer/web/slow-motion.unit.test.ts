import { describe, expect, it } from 'vitest';

import type { ComposeClip, ComposeSpec } from '../definitions';

import { buildPlan, type PlannedClip, type ProbedInput } from './plan';
import { MIN_TWEEN_WEIGHT, framePairAt, frameSeekTarget, frameTimes, isSlowMotion, slowFramesAt } from './slow-motion';

/**
 * Which two recorded frames every output frame of a slowed clip is made from, and how far between
 * them - the part of slow motion that is arithmetic, pinned here so the web export, the preview and
 * the Android engine can be held to the same answers. See `slow-motion.ts` for the rules.
 */

function clip(over: Partial<ComposeClip> = {}): ComposeClip {
  return { key: 'c1', uri: 'file:///a.mp4', inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: false, fit: 'contain', ...over };
}

function spec(clips: ComposeClip[], fps = 30): ComposeSpec {
  return {
    jobId: 'j',
    batchId: 'p',
    clips,
    output: { width: 720, height: 1280, fps, videoBitrate: 6_000_000, audioBitrate: 128_000 },
    filter: [],
    overlays: [],
    audio: { originalMuted: false, originalVolume: 1, music: null, voiceover: [] },
    posterAtMs: 0,
  };
}

const PROBED: ProbedInput = { durationMs: 10_000, width: 1920, height: 1080, hasAudio: true, hasVideo: true };

function planned(over: Partial<ComposeClip>): PlannedClip {
  const plan = buildPlan(spec([clip(over)]), new Map([['file:///a.mp4', PROBED]]));
  return plan.clips[0]!;
}

/** A constant-rate grid: `count` frames at `fps`, starting at 0. */
function grid(fps: number, count: number): Float64Array {
  return Float64Array.from({ length: count }, (_, i) => i / fps);
}

/** Output frame `k`'s place in a clip at `fps`, in microseconds - the render's own `atUs`. */
const outputUs = (k: number, fps: number): number => Math.round((k * 1_000_000) / fps);

/** `[a, weight]` for the first `n` output frames, weights to three places. */
function frames(slowed: PlannedClip, times: Float64Array, fps: number, n: number, from = 0): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const pair = slowFramesAt(slowed, outputUs(from + i, fps), times)!;
    return [pair.a, Math.round(pair.weight * 1000) / 1000];
  });
}

describe('which clips are synthesised', () => {
  it('a video slower than 1x, and nothing else', () => {
    expect(isSlowMotion(planned({ speed: 0.5 }))).toBe(true);
    expect(isSlowMotion(planned({ speed: 0.3 }))).toBe(true);
    // 1x and faster already have a recorded frame for every output frame, and are drawn exactly as
    // they always were.
    expect(isSlowMotion(planned({ speed: 1 }))).toBe(false);
    expect(isSlowMotion(planned({ speed: 2 }))).toBe(false);
    // A picture has one frame, whatever a hand-written spec says its speed is.
    expect(isSlowMotion(planned({ speed: 0.5, image: true }))).toBe(false);
  });
});

describe('the frames and weights of a slowed clip', () => {
  it('at 0.5x on 30 fps footage into a 30 fps post: every other output frame is halfway between two', () => {
    const times = grid(30, 90);
    expect(frames(planned({ speed: 0.5 }), times, 30, 6)).toEqual([
      [0, 0],
      [0, 0.5],
      [1, 0],
      [1, 0.5],
      [2, 0],
      [2, 0.5],
    ]);
  });

  it('at 0.3x: a new picture on EVERY output frame, where the plain path repeated each frame three or four times', () => {
    const times = grid(30, 90);
    const made = frames(planned({ speed: 0.3 }), times, 30, 8);
    expect(made).toEqual([
      [0, 0],
      [0, 0.3],
      [0, 0.6],
      [0, 0.9],
      [1, 0.2],
      [1, 0.5],
      [1, 0.8],
      [2, 0.1],
    ]);
    // No two neighbouring output frames are the same picture.
    for (let i = 1; i < made.length; i++) expect(made[i]).not.toEqual(made[i - 1]);
  });

  it('is independent of the output rate: 0.5x into a 60 fps post is four steps a frame', () => {
    expect(frames(planned({ speed: 0.5 }), grid(30, 90), 60, 5)).toEqual([
      [0, 0],
      [0, 0.25],
      [0, 0.5],
      [0, 0.75],
      [1, 0],
    ]);
  });

  it('starts on the frame at the clip’s in point, alone', () => {
    // An in point exactly on frame 30: the first output frame IS that frame, with nothing mixed in -
    // the same first frame the plain path draws.
    const first = slowFramesAt(planned({ speed: 0.3, inMs: 1000, outMs: 2000 }), 0, grid(30, 90))!;
    expect(first).toEqual({ a: 30, b: 31, weight: 0 });
  });

  it('holds the clip’s first frame while its in point is between two frames, and never blends in the one before', () => {
    // In at 1020 ms, between frame 30 (1000) and frame 31 (1033.3). Frame 30 was trimmed away, so the
    // clip's first frame is 31, and it stands until it is due - Android's lead, to the frame.
    const slowed = planned({ speed: 0.3, inMs: 1020, outMs: 2000 });
    expect(frames(slowed, grid(30, 90), 30, 3)).toEqual([
      [31, 0],
      [31, 0],
      [31, 0.2],
    ]);
    expect(slowFramesAt(slowed, 0, grid(30, 90))?.b).toBe(-1);
  });

  it('holds the clip’s last frame rather than blend in footage past its out point', () => {
    // 0..1000 ms at 0.5x is two seconds of post; its last output frame at 30 fps is 1966.7 ms in,
    // 983.3 ms into the source, halfway from frame 29 to frame 30 - and frame 30, at 1000 ms, is
    // the first frame the out point cuts away. So 29 is held, as Android holds its tail.
    const slowed = planned({ speed: 0.5, outMs: 1000 });
    expect(slowed.outDurUs).toBe(2_000_000);
    expect(slowFramesAt(slowed, outputUs(59, 30), grid(30, 90))).toEqual({ a: 29, b: -1, weight: 0 });
    // Ten milliseconds more of the clip, and frame 30 is its own: blended towards.
    const longer = slowFramesAt(planned({ speed: 0.5, outMs: 1010 }), outputUs(59, 30), grid(30, 90))!;
    expect(longer.a).toBe(29);
    expect(longer.b).toBe(30);
    expect(longer.weight).toBeCloseTo(0.5, 4);
  });

  it('draws the file’s last frame alone, with nothing after it to blend towards', () => {
    // The file ends at frame 29, and so does the clip.
    const slowed = planned({ speed: 0.5, outMs: 1000 });
    expect(slowFramesAt(slowed, outputUs(59, 30), grid(30, 30))).toEqual({ a: 29, b: -1, weight: 0 });
  });

  it('draws a clip too short to hold a frame of its own from the frame that covers it, alone', () => {
    // 1010..1020 ms lies wholly between frames 30 and 31.
    expect(framePairAt(grid(30, 90), 1.015, { from: 1.01, to: 1.02 })).toEqual({ a: 30, b: -1, weight: 0 });
  });
});

describe('framePairAt', () => {
  const times = grid(30, 30);

  it('is the frame itself, alone, at its own timestamp', () => {
    expect(framePairAt(times, 10 / 30)).toEqual({ a: 10, b: 11, weight: 0 });
  });

  it('is the fraction of the way to the next frame between two', () => {
    const pair = framePairAt(times, 10.25 / 30)!;
    expect(pair.a).toBe(10);
    expect(pair.b).toBe(11);
    expect(pair.weight).toBeCloseTo(0.25, 9);
  });

  it('takes an instant a rounding error short of a frame as that frame', () => {
    // 1/3 of a second, computed from microseconds the way the render computes it.
    expect(framePairAt(times, 333_333 / 1_000_000)).toEqual({ a: 10, b: 11, weight: 0 });
  });

  it('draws a weight too small for any 8-bit value to show as none, so B is never decoded for it', () => {
    const tiny = (10 + MIN_TWEEN_WEIGHT / 2) / 30;
    expect(framePairAt(times, tiny)?.weight).toBe(0);
  });

  it('is the first frame, alone, before it', () => {
    const late = Float64Array.from([0.1, 0.2, 0.3]);
    expect(framePairAt(late, 0)).toEqual({ a: 0, b: -1, weight: 0 });
  });

  it('is nothing for a file with no frames', () => {
    expect(framePairAt(new Float64Array(0), 0.5)).toBeNull();
  });

  it('weighs a VARIABLE frame rate by the time that really passed between the two frames', () => {
    // A phone in low light: 30 fps, then one frame held for twice as long, then 30 fps again.
    const vfr = Float64Array.from([0, 1 / 30, 3 / 30, 4 / 30]);
    // Halfway through the long frame is halfway between it and the next - not three quarters of the
    // way, which a constant 30 fps would have said.
    const pair = framePairAt(vfr, 2 / 30)!;
    expect(pair.a).toBe(1);
    expect(pair.b).toBe(2);
    expect(pair.weight).toBeCloseTo(0.5, 9);
  });
});

describe('frameTimes', () => {
  it('sorts a decode-order list into presentation order, once each', () => {
    // B-frames: I P B B, stored in decode order, and a packet the container carries twice.
    const times = frameTimes([0, 3 / 30, 1 / 30, 2 / 30, 2 / 30, Number.NaN]);
    expect([...times]).toEqual([0, 1 / 30, 2 / 30, 3 / 30]);
  });
});

describe('frameSeekTarget', () => {
  it('is the middle of the frame’s time on screen, so no browser can land on the frame either side', () => {
    const times = Float64Array.from([0, 0.1, 0.3]);
    expect(frameSeekTarget(times, 0)).toBeCloseTo(0.05, 9);
    expect(frameSeekTarget(times, 1)).toBeCloseTo(0.2, 9);
    // The last frame is taken to last as long as the one before it.
    expect(frameSeekTarget(times, 2)).toBeCloseTo(0.4, 9);
    // One frame, with nothing to measure it against, is its own time.
    expect(frameSeekTarget(Float64Array.from([0.5]), 0)).toBe(0.5);
  });
});
