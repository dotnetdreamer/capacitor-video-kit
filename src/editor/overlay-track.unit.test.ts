import { describe, expect, it } from 'vitest';

import type { EditTrack, OverlayFollow, TrackSeam } from './edit-manifest';
import {
  coastLost,
  lostAt,
  MAX_TRACK_NAME,
  MAX_TRACK_SAMPLES,
  MEND_BLEND_MS,
  MIN_WEAK_MS,
  mendTrack,
  normaliseEditTrack,
  normaliseOverlayFollow,
  sameFollow,
  sameTrack,
  splitLayerTrack,
  sureAt,
  trackHealth,
  trackName,
  UNSURE_BELOW,
  weakSpots,
  type RunSamples,
} from './overlay-track';

/*
 * A track as the manifest keeps it - how sure it was along the way, where it lost the thing - and the
 * arithmetic a run's samples go through on their way into one: carried along where the thing was hidden,
 * and mended into an old path. The footage is made up: a thing in the middle of the picture unless a test
 * says otherwise, one sample every few milliseconds.
 */

/** Times from 0 to `toMs`, `stepMs` apart. */
function times(stepMs: number, toMs: number): number[] {
  return Array.from({ length: Math.floor(toMs / stepMs) + 1 }, (_, i) => i * stepMs);
}

/** A track of clip "a" sampled at `atMs`: the thing standing in the middle unless `overrides` say otherwise. */
function track(atMs: number[], overrides: Partial<EditTrack> = {}): EditTrack {
  return {
    id: 'k',
    name: 'Track 1',
    hue: 0,
    clipId: 'a',
    clipKey: 'a',
    aspect: 720 / 1280,
    box: { w: 0.2, h: 0.1 },
    atMs,
    x: atMs.map(() => 0.5),
    y: atMs.map(() => 0.5),
    scale: atMs.map(() => 1),
    turn: atMs.map(() => 0),
    ...overrides,
  };
}

describe('normaliseEditTrack', () => {
  it('keeps how sure each sample was beside it when samples are left out', () => {
    const read = normaliseEditTrack({ ...track([0, 500, 400, 900, 1000]), x: [0.1, 0.2, 0.3, Number.NaN, 0.5], sure: [90, 40, 70, 20, 10] })!;
    expect(read.atMs).toEqual([0, 500, 1000]);
    expect(read.x).toEqual([0.1, 0.2, 0.5]);
    expect(read.sure).toEqual([90, 40, 10]);
  });

  it('says nothing of how sure a track was that was sure throughout, as a track from before version 21 says nothing', () => {
    const sure = track(times(100, 500), { sure: [100, 100, 100, 100, 100, 100] });
    const read = normaliseEditTrack(sure)!;
    expect(read).not.toBe(sure);
    expect('sure' in read).toBe(false);
    expect(sameTrack(read, track(times(100, 500)))).toBe(true);
    // A sureness that is not one a sample is no sureness at all.
    expect('sure' in normaliseEditTrack({ ...track(times(100, 500)), sure: [10, 20] })!).toBe(false);
  });

  it('holds how sure a sample was to a whole number from 0 to 100, and a sample that says nothing to sure', () => {
    const read = normaliseEditTrack({ ...track(times(100, 300)), sure: [120, -3, 49.6, null] })!;
    expect(read.sure).toEqual([100, 0, 50, 100]);
  });

  it('keeps a track longer than it takes at a lower rate, its sureness still beside each sample', () => {
    const n = MAX_TRACK_SAMPLES + 2;
    const atMs = Array.from({ length: n }, (_, i) => i * 10);
    const read = normaliseEditTrack({ ...track(atMs), sure: atMs.map((_, i) => i % 100) })!;
    expect(read.atMs.length).toBe(Math.ceil(n / 2));
    expect(read.atMs.slice(0, 3)).toEqual([0, 20, 40]);
    expect(read.sure!.slice(0, 3)).toEqual([0, 2, 4]);
    expect(read.sure!.length).toBe(read.atMs.length);
  });

  it('names and colours a track as it is kept', () => {
    const read = (value: Record<string, unknown>) => normaliseEditTrack({ ...track([0]), ...value })!;
    expect(read({ name: '  The   dog  ' }).name).toBe('The dog');
    expect(read({ name: '   ' }).name).toBe('Track');
    expect(read({ name: 42 }).name).toBe('Track');
    expect(read({ name: 'x'.repeat(40) }).name).toBe('x'.repeat(MAX_TRACK_NAME));
    expect(trackName(undefined)).toBe('Track');
    expect(read({ hue: 7 }).hue).toBe(1);
    expect(read({ hue: -1 }).hue).toBe(5);
    expect(read({ hue: 'red' }).hue).toBe(0);
  });
});

describe('normaliseOverlayFollow', () => {
  it('hands a follow already in shape back as the very object', () => {
    const follow: OverlayFollow = { trackId: 'k', pin: { atMs: 1200, dx: 0.1, dy: -0.2, grow: 1.5 }, scaleWith: true, turnWith: true };
    expect(normaliseOverlayFollow(follow)).toBe(follow);
  });

  it('refuses what is not a follow', () => {
    expect(normaliseOverlayFollow(undefined)).toBeUndefined();
    expect(normaliseOverlayFollow('k')).toBeUndefined();
    expect(normaliseOverlayFollow({ trackId: '', pin: { atMs: 0, dx: 0, dy: 0 } })).toBeUndefined();
    expect(normaliseOverlayFollow({ trackId: 'k' })).toBeUndefined();
    expect(normaliseOverlayFollow({ trackId: 'k', pin: { atMs: 0, dx: 'up', dy: 0 } })).toBeUndefined();
  });

  it('holds the pin to its ranges and keeps only the ways of following that are on', () => {
    const read = normaliseOverlayFollow({ trackId: 'k', pin: { atMs: 1200.4, dx: 9, dy: -9, grow: 1 }, scaleWith: false, turnWith: 'yes', extra: 1 })!;
    expect(read).toEqual({ trackId: 'k', pin: { atMs: 1200, dx: 4, dy: -4 } });
    expect(Object.keys(read).sort()).toEqual(['pin', 'trackId']);
    expect(Object.keys(read.pin).sort()).toEqual(['atMs', 'dx', 'dy']);
    expect(normaliseOverlayFollow({ trackId: 'k', pin: { atMs: 0, dx: 0, dy: 0, grow: -2 } })!.pin).toEqual({ atMs: 0, dx: 0, dy: 0 });
    expect(normaliseOverlayFollow({ trackId: 'k', pin: { atMs: 0, dx: 0, dy: 0, grow: 5000 } })!.pin.grow).toBe(1000);
  });

  it('tells two follows apart by what they say, and only by that', () => {
    const a: OverlayFollow = { trackId: 'k', pin: { atMs: 0, dx: 0.1, dy: 0 }, scaleWith: true };
    expect(sameFollow(a, { ...a, pin: { ...a.pin } })).toBe(true);
    expect(sameFollow(a, { ...a, trackId: 'j' })).toBe(false);
    expect(sameFollow(a, { ...a, scaleWith: undefined })).toBe(false);
    expect(sameFollow(a, { ...a, pin: { ...a.pin, grow: 2 } })).toBe(false);
    expect(sameFollow(a, undefined)).toBe(false);
  });
});

describe('sameTrack', () => {
  it('tells two tracks apart by how sure they were as by their samples, and by their names and colours', () => {
    const a = track(times(100, 300), { sure: [100, 40, 40, 100] });
    expect(sameTrack(a, { ...a, atMs: [...a.atMs], sure: [...a.sure!] })).toBe(true);
    expect(sameTrack(a, { ...a, sure: [100, 40, 41, 100] })).toBe(false);
    expect(sameTrack(a, { ...a, sure: undefined })).toBe(false);
    expect(sameTrack(a, { ...a, name: 'Dog' })).toBe(false);
    expect(sameTrack(a, { ...a, hue: 3 })).toBe(false);
  });
});

describe('splitLayerTrack', () => {
  /** A version-20 layer's own track: its path and the layer's pin in one. */
  function layerTrack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      clipId: 'a',
      clipKey: 'a',
      aspect: 720 / 1280,
      box: { w: 0.2, h: 0.1 },
      atMs: [0, 1000],
      x: [0.4, 0.6],
      y: [0.5, 0.5],
      scale: [1, 1.2],
      turn: [0, 10],
      lost: [200, 400],
      smooth: 0.6,
      pin: { atMs: 500, dx: 0.1, dy: -0.1, grow: 2 },
      scaleWith: true,
      turnWith: true,
      ...overrides,
    };
  }

  it('makes a version-20 layer track into a track of the post and the layer\'s follow of it, pinned as it was', () => {
    const split = splitLayerTrack(layerTrack(), 'trk-t', 'Track 1', 0)!;
    expect(split.track).toEqual({
      id: 'trk-t',
      name: 'Track 1',
      hue: 0,
      clipId: 'a',
      clipKey: 'a',
      aspect: 720 / 1280,
      box: { w: 0.2, h: 0.1 },
      atMs: [0, 1000],
      x: [0.4, 0.6],
      y: [0.5, 0.5],
      scale: [1, 1.2],
      turn: [0, 10],
      lost: [200, 400],
      smooth: 0.6,
    });
    expect(split.follow).toEqual({ trackId: 'trk-t', pin: { atMs: 500, dx: 0.1, dy: -0.1, grow: 2 }, scaleWith: true, turnWith: true });
    expect(splitLayerTrack(layerTrack({ scaleWith: undefined, turnWith: false }), 'trk-t', 'Track 1', 0)!.follow).toEqual({
      trackId: 'trk-t',
      pin: { atMs: 500, dx: 0.1, dy: -0.1, grow: 2 },
    });
  });

  it('makes nothing of what was not a layer track', () => {
    expect(splitLayerTrack(undefined, 'trk-t', 'Track 1', 0)).toBeUndefined();
    expect(splitLayerTrack(layerTrack({ pin: undefined }), 'trk-t', 'Track 1', 0)).toBeUndefined();
    expect(splitLayerTrack(layerTrack({ x: [0.5] }), 'trk-t', 'Track 1', 0)).toBeUndefined();
  });
});

describe('trackHealth', () => {
  it('is one sure stretch for a track that says nothing of how sure it was', () => {
    expect(trackHealth(track(times(100, 1000)))).toEqual([{ fromMs: 0, toMs: 1000, health: 'sure' }]);
  });

  it('is touching stretches of one health each, in time order, each sample standing for the time halfway to its neighbours', () => {
    const t = track(times(100, 1000), { sure: [100, 100, 100, 20, 20, 100, 100, 0, 0, 100, 100], lost: [700, 800] });
    expect(trackHealth(t)).toEqual([
      { fromMs: 0, toMs: 250, health: 'sure' },
      { fromMs: 250, toMs: 450, health: 'unsure' },
      { fromMs: 450, toMs: 650, health: 'sure' },
      { fromMs: 650, toMs: 850, health: 'lost' },
      { fromMs: 850, toMs: 1000, health: 'sure' },
    ]);
  });

  it('is sure from UNSURE_BELOW up', () => {
    expect(trackHealth(track([0, 100], { sure: [UNSURE_BELOW, UNSURE_BELOW - 1] }))).toEqual([
      { fromMs: 0, toMs: 50, health: 'sure' },
      { fromMs: 50, toMs: 100, health: 'unsure' },
    ]);
  });
});

describe('weakSpots', () => {
  it('joins weak stretches near each other into one spot, lost if any of it was, and leaves out the tracker\'s wobble', () => {
    const atMs = times(50, 3000);
    const sure = atMs.map(() => 100);
    // 175..275: a tenth of a second unsure, the tracker's ordinary wobble.
    for (const i of [4, 5]) sure[i] = 30;
    // 975..1275, and 1475..1575 a fifth of a second after it: one spot.
    for (let i = 20; i <= 25; i++) sure[i] = 30;
    for (const i of [30, 31]) sure[i] = 30;
    // 2275..2375 unsure, then lost just after it.
    for (const i of [46, 47]) sure[i] = 30;
    sure[50] = 0;
    const spots = weakSpots(track(atMs, { sure, lost: [2500, 2501] }));
    expect(spots).toEqual([
      { fromMs: 975, toMs: 1575, lost: false },
      { fromMs: 2275, toMs: 2525, lost: true },
    ]);
    expect(1575 - 975).toBeGreaterThanOrEqual(MIN_WEAK_MS);
  });

  it('keeps a lost stretch however short, and an unsure one from MIN_WEAK_MS long', () => {
    const atMs = times(50, 2000);
    const sure = atMs.map(() => 100);
    sure[10] = 0;
    // Three samples: MIN_WEAK_MS of footage.
    for (const i of [30, 31, 32]) sure[i] = 30;
    expect(weakSpots(track(atMs, { sure, lost: [500, 501] }))).toEqual([
      { fromMs: 475, toMs: 525, lost: true },
      { fromMs: 1475, toMs: 1475 + MIN_WEAK_MS, lost: false },
    ]);
  });

  it('is none for a track sure the whole way', () => {
    expect(weakSpots(track(times(50, 2000)))).toEqual([]);
  });
});

describe('sureAt', () => {
  it('is the nearer sample\'s sureness, nothing where the thing was lost, and sure for a track that says nothing', () => {
    const t = track([0, 100, 200], { sure: [100, 40, 80], lost: [150, 160] });
    expect(sureAt(track([0, 100]), 50)).toBe(1);
    expect(sureAt(t, 40)).toBe(1);
    expect(sureAt(t, 60)).toBe(0.4);
    expect(sureAt(t, 155)).toBe(0);
    expect(lostAt(t, 155)).toBe(true);
    expect(lostAt(t, 161)).toBe(false);
    expect(sureAt(t, 190)).toBe(0.8);
    expect(sureAt(t, -50)).toBe(1);
    expect(sureAt(t, 900)).toBe(0.8);
  });
});

describe('coastLost', () => {
  /** A run's samples at `atMs`, with whatever `values` say for each; the run sure where `seen` says, and lost elsewhere. */
  function samples(atMs: number[], seen: (t: number) => boolean, values: (t: number) => { x: number; y?: number; scale?: number; turn?: number }): RunSamples {
    return {
      atMs,
      x: atMs.map(t => values(t).x),
      y: atMs.map(t => values(t).y ?? 0.5),
      scale: atMs.map(t => values(t).scale ?? 1),
      turn: atMs.map(t => values(t).turn ?? 0),
      sure: atMs.map(t => (seen(t) ? 90 : 0)),
      lost: [],
      anchorMs: 0,
    };
  }

  it('carries the thing between two sightings on a curve that leaves the one and meets the other at the speed it had there', () => {
    const atMs = times(10, 2000);
    const hidden = (t: number) => t >= 800 && t <= 1200;
    // Walking right at 0.0002 of the frame a millisecond until it is hidden, at twice that once it is seen
    // again, growing and turning meanwhile; hidden, the tracker holds it where it was last seen.
    const before = (t: number) => ({ x: 0.2 + 0.0002 * t, scale: 1, turn: 0 });
    const after = (t: number) => ({ x: 0.5 + 0.0004 * (t - 1210), scale: 1.44, turn: 20 });
    const run = { ...samples(atMs, t => !hidden(t), t => (hidden(t) ? before(790) : t < 800 ? before(t) : after(t))), lost: [800, 1200] };
    const coasted = coastLost(run, i => !hidden(atMs[i]!));
    const p = atMs.indexOf(790);
    const q = atMs.indexOf(1210);
    const speed = (i: number) => (coasted.x[i + 1]! - coasted.x[i]!) / 10;
    // Off at the speed it had, and in at the speed it has: neither a stop nor a jump at either end.
    expect(Math.abs(speed(p) / 0.0002 - 1)).toBeLessThan(0.05);
    expect(Math.abs(speed(q - 1) / 0.0004 - 1)).toBeLessThan(0.05);
    // On its way the whole time, never back.
    for (let i = p; i < q; i++) expect(speed(i), `speed at ${atMs[i]}`).toBeGreaterThan(0);
    // Its size and turn eased from the one sighting to the other: half way, half way.
    const mid = atMs.indexOf(1000);
    expect(coasted.scale[mid]).toBeCloseTo(1.2, 4);
    expect(coasted.turn[mid]).toBeCloseTo(10, 2);
    // The sightings as they were, and the stretch still not seen.
    expect(coasted.x[p]).toBeCloseTo(before(790).x, 5);
    expect(coasted.x[q]).toBeCloseTo(0.5, 5);
    expect(coasted.lost).toEqual([800, 1200]);
    expect(coasted.sure).toBe(run.sure);
    expect(coasted.atMs).toBe(run.atMs);
  });

  it('carries the thing on past its last sighting, slowing to a stop', () => {
    const atMs = times(10, 3000);
    const gone = (t: number) => t > 1000;
    const run = samples(atMs, t => !gone(t), t => ({ x: 0.2 + 0.0002 * Math.min(t, 1000) }));
    const coasted = coastLost(run, i => !gone(atMs[i]!));
    const last = atMs.indexOf(1000);
    const x = (t: number) => coasted.x[atMs.indexOf(t)]!;
    // Moving at first much as it was...
    expect(coasted.x[last + 1]! - coasted.x[last]!).toBeCloseTo(0.002, 4);
    // ...and hardly at all once it has been gone a while: no further than a moment at its old speed.
    const early = x(1500) - x(1000);
    const late = x(3000) - x(2500);
    expect(early).toBeGreaterThan(0.02);
    expect(late).toBeLessThan(early / 10);
    expect(x(3000) - x(1000)).toBeLessThan(0.0002 * 1000);
  });

  it('carries the thing back before its first sighting the same way, and never far off the frame', () => {
    const atMs = times(10, 2000);
    const first = (t: number) => t >= 500;
    const coasted = coastLost(
      samples(atMs, first, t => ({ x: 0.5 + 0.0002 * Math.max(0, t - 500) })),
      i => first(atMs[i]!),
    );
    const at = (t: number) => coasted.x[atMs.indexOf(t)]!;
    expect(at(490)).toBeLessThan(at(500));
    expect(at(0)).toBeLessThan(at(250));
    expect(at(500) - at(0)).toBeLessThan(0.0002 * 500);
    // A thing leaving fast, last seen at the frame's edge, is carried no further than a quarter of the
    // frame past it.
    const fast = coastLost(
      samples(atMs, t => t <= 500, t => ({ x: 0.6 + 0.0008 * Math.min(t, 500) })),
      i => atMs[i]! <= 500,
    );
    expect(fast.x[atMs.indexOf(500)]).toBeCloseTo(1, 5);
    expect(Math.max(...fast.x)).toBe(1.25);
  });

  it('leaves a run seen throughout where it was, and one never seen as it was', () => {
    const atMs = times(10, 500);
    const seen = samples(atMs, () => true, t => ({ x: 0.3 + 0.0001 * t }));
    expect(coastLost(seen, () => true).x).toEqual(seen.x.map(x => Math.round(x * 1e5) / 1e5));
    const never = samples(atMs, () => false, () => ({ x: 0.4 }));
    expect(coastLost(never, () => false).x).toEqual(never.x);
  });
});

describe('mendTrack', () => {
  /** The old path: one sample every 10 ms for 4 s, the thing walking right a tenth of the frame a second, growing to twice its size and turning 40 degrees. */
  function old(overrides: Partial<EditTrack> = {}): EditTrack {
    const atMs = times(10, 4000);
    return track(atMs, {
      x: atMs.map(t => 0.3 + t / 10_000),
      scale: atMs.map(t => 1 + t / 4000),
      turn: atMs.map(t => t / 100),
      smooth: 0,
      ...overrides,
    });
  }

  /** A run over `fromMs` to `toMs` from the frame at `anchorMs`: the thing 0.05 right of the old path, its size and turn measured against the anchor frame's. */
  function run(fromMs: number, toMs: number, anchorMs: number, sure = 80): RunSamples {
    const atMs = times(10, 5000).filter(t => t >= fromMs && t <= toMs);
    return {
      atMs,
      x: atMs.map(t => 0.35 + t / 10_000),
      y: atMs.map(() => 0.5),
      scale: atMs.map(t => (1 + t / 4000) / (1 + anchorMs / 4000)),
      turn: atMs.map(t => t / 100 - anchorMs / 100),
      sure: atMs.map(() => sure),
      lost: [],
      anchorMs,
    };
  }

  const seam = (atMs: number): TrackSeam => ({ atMs, then: { atMs: [], x: [], y: [], scale: [], turn: [] } });

  it('takes the run over its own span, handed over from the old path and back to it at both ends', () => {
    const before = old();
    const mended = mendTrack(before, run(1000, 3000, 2000));
    const at = (t: number) => mended.atMs.indexOf(t);
    const moved = (t: number) => mended.x[at(t)]! - before.x[at(t)]!;
    expect(mended.atMs).toEqual(before.atMs);
    // Either side of the run, the old samples as they were.
    expect(mended.x.slice(0, at(1000))).toEqual(before.x.slice(0, at(1000)));
    expect(mended.x.slice(at(3000) + 1)).toEqual(before.x.slice(at(3000) + 1));
    // At the run's ends the old path, half way MEND_BLEND_MS / 2 in, and the run's own from MEND_BLEND_MS in.
    expect(moved(1000)).toBeCloseTo(0, 5);
    expect(moved(1000 + MEND_BLEND_MS / 2)).toBeCloseTo(0.025, 5);
    for (const t of [1000 + MEND_BLEND_MS, 2000, 3000 - MEND_BLEND_MS]) expect(moved(t), `at ${t}`).toBeCloseTo(0.05, 5);
    expect(moved(3000 - MEND_BLEND_MS / 2)).toBeCloseTo(0.025, 5);
    expect(moved(3000)).toBeCloseTo(0, 5);
    expect(normaliseEditTrack(mended)).toBe(mended);
    expect(mended).toMatchObject({ id: 'k', name: 'Track 1', hue: 0, smooth: 0 });
  });

  it('carries the size and the turn on from where the old path had them at the run\'s anchor', () => {
    const before = old();
    const mended = mendTrack(before, run(1000, 3000, 2000));
    for (const t of [1500, 2000, 2500]) {
      const i = mended.atMs.indexOf(t);
      expect(mended.scale[i], `size at ${t}`).toBeCloseTo(before.scale[i]!, 4);
      expect(mended.turn[i], `turn at ${t}`).toBeCloseTo(before.turn[i]!, 2);
    }
  });

  it('blends only at an end where the old path goes on past the run', () => {
    // On past the old path's end: handed over at its start, the run's own to its end.
    const longer = mendTrack(old(), run(3000, 4500, 3500));
    const x = (t: number) => longer.x[longer.atMs.indexOf(t)]!;
    expect(longer.atMs.at(-1)).toBe(4500);
    expect(x(3000)).toBeCloseTo(0.3 + 0.3, 5);
    expect(x(4000)).toBeCloseTo(0.35 + 0.4, 5);
    expect(x(4500)).toBeCloseTo(0.35 + 0.45, 5);
    // From before the old path's start: the run's own from its first sample, handed back at its end.
    const later = old();
    const keep = later.atMs.map(t => t >= 1000);
    const pick = <T>(values: T[]) => values.filter((_, i) => keep[i]);
    const short = { ...later, atMs: pick(later.atMs), x: pick(later.x), y: pick(later.y), scale: pick(later.scale), turn: pick(later.turn) };
    const earlier = mendTrack(short, run(0, 2000, 1500));
    const y = (t: number) => earlier.x[earlier.atMs.indexOf(t)]!;
    expect(earlier.atMs[0]).toBe(0);
    expect(y(0)).toBeCloseTo(0.35, 5);
    expect(y(1000)).toBeCloseTo(0.35 + 0.1, 5);
    expect(y(2000)).toBeCloseTo(0.3 + 0.2, 5);
  });

  it('takes how sure the run was over its span, and keeps the old sureness either side', () => {
    const before = old({ sure: times(10, 4000).map(t => (t < 500 ? 30 : 100)) });
    const mended = mendTrack(before, run(1000, 3000, 2000, 70));
    const at = (t: number) => mended.atMs.indexOf(t);
    expect(mended.sure!.slice(0, at(500))).toEqual(before.sure!.slice(0, at(500)));
    expect(mended.sure![at(2000)]).toBe(70);
    expect(mended.sure![at(3500)]).toBe(100);
    // Sure the whole way once mended, it says nothing of sureness.
    expect('sure' in mendTrack(old(), run(1000, 3000, 2000, 100))).toBe(false);
  });

  it('drops the old lost stretches and seams inside the run\'s span for its own, and keeps those outside it', () => {
    const before = old({ lost: [200, 400, 1400, 1600, 3200, 3400], seams: [seam(600), seam(1500), seam(3600)] });
    const mended = mendTrack(before, { ...run(1000, 3000, 2000), lost: [1800, 1900] });
    expect(mended.lost).toEqual([200, 400, 1800, 1900, 3200, 3400]);
    expect(mended.seams!.map(s => s.atMs)).toEqual([600, 3600]);
    const seen = mendTrack(old({ lost: [1400, 1600], seams: [seam(1500)] }), run(1000, 3000, 2000));
    expect('lost' in seen).toBe(false);
    expect('seams' in seen).toBe(false);
  });

  // Known bug, to be flipped to `it` once fixed: mendTrack (overlay-track.ts, the `lost` loops) drops an old
  // lost stretch that straddles either end of the run whole, rather than keeping the part outside the span.
  it('keeps the part of an old lost stretch outside the run\'s span lost', () => {
    const mended = mendTrack(old({ lost: [800, 1200, 2800, 3200] }), run(1000, 3000, 2000));
    expect(lostAt(mended, 900)).toBe(true);
    expect(lostAt(mended, 3100)).toBe(true);
    expect(lostAt(mended, 2000)).toBe(false);
  });

  it('is no change for a run that found nothing', () => {
    const before = old();
    expect(mendTrack(before, { ...run(1000, 3000, 2000), atMs: [], x: [], y: [], scale: [], turn: [], sure: [] })).toBe(before);
  });
});
