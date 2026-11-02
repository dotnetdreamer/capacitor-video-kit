import { describe, expect, it } from 'vitest';

import { TrackStoppedError, type TrackFrame, type TrackFrameSource } from '../video-composer/web/track-frames';

import { runTrack, startTrackRun, type TrackRun, type TrackRunLive, type TrackRunRequest } from './track-session';

/*
 * A source made up for the test: 30 fps, 180x320, a textured square drifting right and up over a
 * textured background - where it is at any frame known exactly.
 */

const W = 180;
const H = 320;
const STEP = 1000 / 30;

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number, seed: number, cell: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Where the thing's middle is at `t` ms, in the tracker's own pixel coordinates. */
function truth(t: number): { x: number; y: number } {
  return { x: 50 + 0.03 * t, y: 200 - 0.012 * t };
}

const HALF = 20;

function render(t: number, hidden = false): Uint8Array {
  const at = truth(t);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x - at.x) / HALF;
      const v = (y - at.y) / HALF;
      const cover = Math.min(1, Math.max(0, (1 - Math.max(Math.abs(u), Math.abs(v))) * HALF + 0.5));
      const back = 40 + 120 * noise(x, y, 7, 14) + 50 * noise(x, y, 11, 5);
      const s = (u + 1) * 30;
      const r = (v + 1) * 30;
      const thing = 20 + 90 * noise(s, r, 3, 16) + 70 * noise(s, r, 5, 7) + 50 * noise(s, r, 9, 3);
      out[y * W + x] = hidden && y > 120 && y < 260 ? 90 : cover * thing + (1 - cover) * back;
    }
  }
  return out;
}

function source(options: { hiddenFrom?: number; hiddenTo?: number; flat?: boolean } = {}): TrackFrameSource & { closed: number } {
  const made = {
    width: W,
    height: H,
    aspect: W / H,
    durationMs: 4000,
    closed: 0,
    async *frames(fromMs: number, toMs: number, signal: AbortSignal): AsyncGenerator<TrackFrame> {
      for (let k = Math.floor(fromMs / STEP + 1e-9); k * STEP <= toMs + 1e-9; k++) {
        if (signal.aborted) throw new TrackStoppedError('stopped');
        const t = k * STEP;
        const hidden = options.hiddenFrom !== undefined && t >= options.hiddenFrom && t < (options.hiddenTo ?? Infinity);
        yield { timeMs: t, luma: options.flat ? new Uint8Array(W * H).fill(128) : render(t, hidden) };
      }
    },
    close() {
      made.closed++;
    },
  };
  return made;
}

function request(overrides: Partial<TrackRunRequest> = {}): TrackRunRequest {
  const anchorMs = overrides.anchorMs ?? 1000;
  const at = truth(Math.floor(anchorMs / STEP + 1e-9) * STEP);
  return {
    uri: 'file:///clip.mp4',
    clipId: 'a',
    clipKey: 'a',
    anchorMs,
    box: { cx: (at.x + 0.5) / W, cy: (at.y + 0.5) / H, w: (2 * HALF) / W, h: (2 * HALF) / H },
    fromMs: 0,
    toMs: 2000,
    direction: 'both',
    ...overrides,
  };
}

describe('runTrack', () => {
  it('follows the thing both ways from the frame the box was drawn on, every frame once, in order', async () => {
    const src = source();
    const lives: TrackRunLive[] = [];
    const outcome = await runTrack(
      request(),
      live => lives.push(live),
      new AbortController().signal,
      async () => src,
    );
    const result = outcome.result!;
    expect(outcome.stopped).toBe(false);
    expect(result.atMs[0]).toBe(0);
    expect(result.atMs.at(-1)).toBe(2000);
    expect(result.atMs.length).toBe(61);
    for (let i = 1; i < result.atMs.length; i++) expect(result.atMs[i]!).toBeGreaterThan(result.atMs[i - 1]!);
    result.atMs.forEach((t, i) => {
      const at = truth(Math.round(t / STEP) * STEP);
      expect(Math.abs(result.x[i]! * W - 0.5 - at.x), `x at ${t}`).toBeLessThan(1);
      expect(Math.abs(result.y[i]! * H - 0.5 - at.y), `y at ${t}`).toBeLessThan(1);
    });
    expect(result.lost).toEqual([]);
    expect(result.anchorMs).toBe(1000);
    expect(src.closed).toBe(1);
    // The preview was told about every frame read, and the run's share went from nothing to all of it.
    expect(lives.length).toBe(61);
    expect(Math.max(...lives.map(live => live.progress))).toBeCloseTo(1, 1);
  });

  it('follows only on from the anchor when asked to mend a path', async () => {
    const outcome = await runTrack(
      request({ direction: 'forward' }),
      () => undefined,
      new AbortController().signal,
      async () => source(),
    );
    expect(outcome.result!.atMs[0]).toBeGreaterThanOrEqual(980);
    expect(outcome.result!.atMs.at(-1)).toBe(2000);
  });

  it('keeps what it found when stopped', async () => {
    const abort = new AbortController();
    let frames = 0;
    const outcome = await runTrack(
      request(),
      () => {
        if (++frames === 10) abort.abort();
      },
      abort.signal,
      async () => source(),
    );
    expect(outcome.stopped).toBe(true);
    expect(outcome.result!.atMs.length).toBe(10);
  });

  it('hears a stop between the frames it has already read for the way back', async () => {
    // Footage that never looks at the signal: the frames for the way back are read a stretch at a time,
    // so once they are in hand the run itself is all that can hear the stop.
    const src = source();
    const deaf: TrackFrameSource = { ...src, frames: (fromMs, toMs) => src.frames(fromMs, toMs, new AbortController().signal) };
    const abort = new AbortController();
    let frames = 0;
    let afterStop = 0;
    const outcome = await runTrack(
      request(),
      () => {
        if (abort.signal.aborted) afterStop++;
        // 31 frames on from 1000 to 2000, then five of the way back.
        if (++frames === 36) abort.abort();
      },
      abort.signal,
      async () => deaf,
    );
    expect(outcome.stopped).toBe(true);
    expect(afterStop).toBe(0);
    expect(outcome.result!.atMs.length).toBe(36);
  });

  it('hands over what it has found so far at any moment, the way back included, without waiting for the run to end', async () => {
    const abort = new AbortController();
    let frames = 0;
    let seen: ReturnType<TrackRun['found']> = null;
    const run: TrackRun = startTrackRun(
      request(),
      () => {
        if (++frames !== 40) return;
        seen = run.found();
        abort.abort();
      },
      abort.signal,
      async () => source(),
    );
    expect(run.found()).toBeNull();
    const outcome = await run.done;
    // 31 on and 9 back, oldest first.
    expect(seen!.atMs.length).toBe(40);
    expect(seen!.atMs[0]).toBe(Math.round(1000 - 9 * STEP));
    expect(seen!.atMs.at(-1)).toBe(2000);
    expect(outcome.result).toEqual(seen);
  });

  it('finds nothing to follow in a flat box', async () => {
    const outcome = await runTrack(
      request(),
      () => undefined,
      new AbortController().signal,
      async () => source({ flat: true }),
    );
    expect(outcome.result).toBeNull();
  });

  it('says where the thing was out of sight', async () => {
    const outcome = await runTrack(
      request({ anchorMs: 0, direction: 'forward' }),
      () => undefined,
      new AbortController().signal,
      async () => source({ hiddenFrom: 600, hiddenTo: 900 }),
    );
    const lost = outcome.result!.lost;
    expect(lost.length).toBe(2);
    expect(lost[0]!).toBeGreaterThanOrEqual(600);
    expect(lost[0]!).toBeLessThan(700);
    expect(lost[1]!).toBeGreaterThanOrEqual(860);
    expect(lost[1]!).toBeLessThan(1000);
  });
});
