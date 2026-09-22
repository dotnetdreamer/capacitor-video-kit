import { describe, expect, it } from 'vitest';

import type { ComposeClip, ComposeSpec } from '../definitions';

import { buildPlan, clipIndexAt, evenOutput, sourceTimeUs, visibleIndexAt, type ProbedInput } from './plan';

/**
 * The layout every other part of the render is measured against: where each clip lands, how long
 * the post is, how many times the music repeats and where the voiceovers go.
 *
 * All of it pure, and all of it a port of `RenderPlan.kt` - so these are the cases its own test
 * pins, written against the browser's copy.
 */

function clip(over: Partial<ComposeClip> = {}): ComposeClip {
  return {
    key: 'c1',
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

const probed = (over: Partial<ProbedInput> = {}): ProbedInput => ({
  durationMs: 10_000,
  width: 1920,
  height: 1080,
  hasAudio: true,
  hasVideo: true,
  ...over,
});

describe('buildPlan', () => {
  it('lays clips end to end and makes their total the post', () => {
    const plan = buildPlan(spec({ clips: [clip({ outMs: 1000 }), clip({ key: 'c2', inMs: 500, outMs: 2000 })] }), new Map());
    expect(plan.prefixOutUs).toEqual([0, 1_000_000]);
    expect(plan.totalUs).toBe(1_000_000 + 1_500_000);
  });

  it('FLOORS a sped-up clip, because Media3 floors', () => {
    // 1000 ms at 3x is 333.333... ms. A rounded plan would claim a microsecond the item has not
    // got, and that microsecond is a frame of black at the join.
    const plan = buildPlan(spec({ clips: [clip({ outMs: 1000, speed: 3 })] }), new Map());
    expect(plan.clips[0]?.outDurUs).toBe(333_333);
  });

  it('clamps a trim to what the file actually holds', () => {
    // The manifest says four seconds; the file turned out to be two.
    const plan = buildPlan(spec({ clips: [clip({ outMs: 4000 })] }), new Map([['file:///a.mp4', probed({ durationMs: 2000 })]]));
    expect(plan.clips[0]?.outUs).toBe(2_000_000);
  });

  it('drops a clip audio when the spec mutes everything, and when the file is silent', () => {
    const muted = buildPlan(spec({ audio: { originalMuted: true, originalVolume: 1, music: null, voiceover: [] } }), new Map());
    expect(muted.clips[0]?.removeAudio).toBe(true);
    expect(muted.hasAudio).toBe(false);

    const silent = buildPlan(spec(), new Map([['file:///a.mp4', probed({ hasAudio: false })]]));
    expect(silent.clips[0]?.removeAudio).toBe(true);
  });

  it('knows a clip that asks for no crop and no rect, which is the fast path', () => {
    expect(buildPlan(spec(), new Map()).clips[0]?.reframed).toBe(false);
    const framed = buildPlan(spec({ clips: [clip({ crop: { x: 0, y: 0, w: 0.5, h: 1 } })] }), new Map());
    expect(framed.clips[0]?.reframed).toBe(true);
  });

  it('rounds the output down to an even pair, which is all an H.264 encoder will take', () => {
    expect(evenOutput({ width: 721, height: 1281, fps: 30, videoBitrate: 1, audioBitrate: 1 })).toMatchObject({ width: 720, height: 1280 });
  });
});

describe('extra video layers', () => {
  it('sorts bottom to top and keeps the spec order for a tie', () => {
    const plan = buildPlan(
      spec({
        clips: [clip({ outMs: 5000 })],
        tracks: [
          { id: 'top', clips: [clip({ key: 'b' })], z: 1 },
          { id: 'also-top', clips: [clip({ key: 'c' })], z: 1 },
        ],
      }),
      new Map(),
    );
    expect(plan.tracks.map(track => track.id)).toEqual(['top', 'also-top']);
  });

  it('turns a layer rect into its frame and takes it off the clip', () => {
    const plan = buildPlan(
      spec({
        clips: [clip({ outMs: 5000 })],
        tracks: [
          {
            id: 'pip',
            z: 1,
            clips: [clip({ key: 'b', rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } })],
          },
        ],
      }),
      new Map(),
    );
    const layer = plan.tracks[0];
    expect(layer?.clips[0]?.frame).toEqual({ width: 360, height: 640 });
    // Left on the clip, the rectangle would place the picture inside the layer a second time.
    expect(layer?.clips[0]?.clip.rect).toBeUndefined();
    expect(layer?.placements[0]?.rect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
  });

  it("carries the layer's angle on its placement, and sizes its frame from the UPRIGHT rectangle", () => {
    const plan = buildPlan(
      spec({
        clips: [clip({ outMs: 5000 })],
        tracks: [
          {
            id: 'pip',
            z: 1,
            clips: [clip({ key: 'b', rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.25, rotationDeg: 45 } })],
          },
        ],
      }),
      new Map(),
    );
    const layer = plan.tracks[0];
    // `fit` is measured BEFORE the turn and the fitted picture is turned as one piece, so the frame
    // is the rectangle's own size - not the bounding box of the turned one, which would make a clip
    // swell and shrink as it spun.
    expect(layer?.clips[0]?.frame).toEqual({ width: 360, height: 320 });
    expect(layer?.placements[0]?.rect.rotationDeg).toBe(45);
  });

  it('CUTS a layer that would outlast the base rather than lengthening the post', () => {
    const plan = buildPlan(
      spec({
        clips: [clip({ outMs: 1000 })],
        tracks: [{ id: 'long', z: 1, clips: [clip({ key: 'b', outMs: 5000 })] }],
      }),
      new Map(),
    );
    expect(plan.tracks[0]?.placements[0]?.endUs).toBe(plan.totalUs);
  });

  it('drops a layer that starts after the base has ended', () => {
    const plan = buildPlan(
      spec({
        clips: [clip({ outMs: 1000 })],
        tracks: [{ id: 'late', z: 1, startMs: 5000, clips: [clip({ key: 'b' })] }],
      }),
      new Map(),
    );
    expect(plan.tracks).toHaveLength(0);
  });

  it('hides a layer before its start and after its last clip', () => {
    const plan = buildPlan(
      spec({
        clips: [clip({ outMs: 5000 })],
        tracks: [{ id: 'mid', z: 1, startMs: 1000, clips: [clip({ key: 'b', outMs: 1000 })] }],
      }),
      new Map(),
    );
    const track = plan.tracks[0];
    expect(track).toBeDefined();
    if (!track) return;
    expect(visibleIndexAt(track, 500_000)).toBe(-1);
    expect(visibleIndexAt(track, 1_500_000)).toBe(0);
    expect(visibleIndexAt(track, 2_500_000)).toBe(-1);
  });
});

describe('music', () => {
  it('repeats just enough to cover the video, and cuts the last one exactly at the end', () => {
    const plan = buildPlan(
      spec({
        clips: [clip({ outMs: 2500 })],
        audio: {
          originalMuted: false,
          originalVolume: 1,
          voiceover: [],
          music: {
            uri: 'file:///m.mp3',
            startMs: 0,
            inMs: 0,
            outMs: 1000,
            volume: 0.5,
            loop: true,
            fadeInMs: 0,
            fadeOutMs: 500,
          },
        },
      }),
      new Map(),
    );
    const items = plan.music?.items ?? [];
    expect(items).toHaveLength(3);
    expect(items[2]?.atUs).toBe(2_000_000);
    expect((items[2]?.outUs ?? 0) - (items[2]?.inUs ?? 0)).toBe(500_000);
    // A fade belongs to the end of the VIDEO, not to every repetition.
    expect(items[0]?.fadeOutStartUs).toBe(-1);
    expect(items[2]?.fadeOutStartUs).toBe(0);
  });

  it('does not loop when it was not asked to', () => {
    const plan = buildPlan(
      spec({
        clips: [clip({ outMs: 5000 })],
        audio: {
          originalMuted: false,
          originalVolume: 1,
          voiceover: [],
          music: {
            uri: 'file:///m.mp3',
            startMs: 0,
            inMs: 0,
            outMs: 1000,
            volume: 1,
            loop: false,
            fadeInMs: 0,
            fadeOutMs: 0,
          },
        },
      }),
      new Map(),
    );
    expect(plan.music?.items).toHaveLength(1);
  });
});

describe('voiceovers', () => {
  it('keeps them in time order and loses the later of two that overlap', () => {
    const plan = buildPlan(
      spec({
        clips: [clip({ outMs: 10_000 })],
        audio: {
          originalMuted: false,
          originalVolume: 1,
          music: null,
          voiceover: [
            { uri: 'file:///v2.m4a', startMs: 500, durationMs: 1000, volume: 1 },
            { uri: 'file:///v1.m4a', startMs: 0, durationMs: 1000, volume: 1 },
            { uri: 'file:///v3.m4a', startMs: 2000, durationMs: 1000, volume: 1 },
          ],
        },
      }),
      new Map(),
    );
    // v1 runs 0..1000 and v2 would start inside it, so v2 is dropped rather than silently shifted.
    expect(plan.voice.map(take => take.uri)).toEqual(['file:///v1.m4a', 'file:///v3.m4a']);
  });
});

describe('reading the timeline', () => {
  it('finds the clip on screen at an instant, and nothing past the end', () => {
    const plan = buildPlan(spec({ clips: [clip({ outMs: 1000 }), clip({ key: 'c2', outMs: 1000 })] }), new Map());
    expect(clipIndexAt(plan, 0)).toBe(0);
    expect(clipIndexAt(plan, 1_500_000)).toBe(1);
    expect(clipIndexAt(plan, 2_500_000)).toBe(-1);
  });

  it('runs a sped-up clip through its source faster', () => {
    const plan = buildPlan(spec({ clips: [clip({ outMs: 4000, speed: 2 })] }), new Map());
    const planned = plan.clips[0];
    expect(planned).toBeDefined();
    if (!planned) return;
    // One second into its place on the output is two seconds into the file.
    expect(sourceTimeUs(planned, 1_000_000)).toBe(2_000_000);
  });
});

/*
 * The tail, on the wire. `durationMs` is the output's length when it runs past the base track, and
 * everything the plan measures against the output has to be measured against the longer number -
 * a layer's cut, the music, a voiceover, the poster.
 */
describe('buildPlan with a tail past the base track', () => {
  const probes = new Map([['file:///a.mp4', probed()], ['file:///b.mp4', probed()]]);

  it('runs the output on past the clips', () => {
    const plan = buildPlan(spec({ durationMs: 4000 }), probes);
    expect(plan.totalUs).toBe(4_000_000);
  });

  it('ignores a duration the clips already cover', () => {
    // 0, absent, or anything at or below the base track all say the same thing, and a floor UNDER
    // what was planned would be a base track cut off by a key that is only ever asking for more.
    expect(buildPlan(spec({ durationMs: 500 }), probes).totalUs).toBe(1_000_000);
    expect(buildPlan(spec({ durationMs: 0 }), probes).totalUs).toBe(1_000_000);
    expect(buildPlan(spec(), probes).totalUs).toBe(1_000_000);
  });

  it('keeps a layer laid in the tail', () => {
    // The whole point: before the key existed this layer started past the end of the output and was
    // planned away to nothing.
    const track = { id: 'vt', clips: [clip({ uri: 'file:///b.mp4' })], startMs: 2000, z: 1, opacity: 1 };

    const plan = buildPlan(spec({ durationMs: 4000, tracks: [track] }), probes);

    expect(plan.tracks).toHaveLength(1);
    expect(plan.tracks[0].placements[0].startUs).toBe(2_000_000);
  });
});
