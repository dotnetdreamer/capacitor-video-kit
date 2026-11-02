import { effect } from '@preact/signals-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultClipEdit, emptyManifest, type EditClip, type EditManifest, type EditOverlay } from '../editor';

import { resolveEditorHost } from '../host/defaults';
import type { EditorSource } from '../host/host.types';
import { TrackStoppedError, type TrackFrame, type TrackFrameSource } from '../video-composer/web/track-frames';
import { EditorStore } from './editor-store';

/*
 * The Track sheet's run, as the store drives it: what Stop and the sheet shutting leave on the layer, and
 * WHEN - Next reads the post in the same turn it shuts the sheet - the stretch of footage a run is asked
 * to read, and the frame a moved box is put on. The footage is made up: a still, textured picture, read a
 * frame at a time with a pause between frames, so a test can act while a run is part way. The player is
 * a stand-in that moves the playhead where it is told and plays when asked.
 */

const W = 90;
const H = 160;
const STEP = 1000 / 30;

function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Value noise a few pixels across: texture the tracker can hold on to. */
function texture(): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = x / 5;
      const gy = y / 5;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * fx;
      const bottom = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * fx;
      out[y * W + x] = 30 + 190 * (top + (bottom - top) * fy);
    }
  }
  return out;
}

const PICTURE = texture();

/** Footage read a frame at a time, a moment apart, with every stretch it was asked for kept. */
function footage(): { open: (uri: string) => Promise<TrackFrameSource>; asked: Array<{ fromMs: number; toMs: number }>; read: () => number } {
  const asked: Array<{ fromMs: number; toMs: number }> = [];
  let read = 0;
  const source: TrackFrameSource = {
    width: W,
    height: H,
    aspect: 720 / 1280,
    durationMs: 20_000,
    async *frames(fromMs: number, toMs: number, signal: AbortSignal): AsyncGenerator<TrackFrame> {
      asked.push({ fromMs, toMs });
      for (let k = Math.floor(fromMs / STEP + 1e-9); k * STEP <= toMs + 1e-9; k++) {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (signal.aborted) throw new TrackStoppedError('stopped');
        read++;
        yield { timeMs: k * STEP, luma: PICTURE };
      }
    },
    close() {},
  };
  return { open: async () => source, asked, read: () => read };
}

function clip(id: string, outMs: number, over: Partial<EditClip> = {}): EditClip {
  return { ...defaultClipEdit(id, outMs), ...over };
}

function caption(over: Partial<EditOverlay> = {}): EditOverlay {
  return {
    id: 't',
    kind: 'text',
    text: 'Runner',
    styleId: 'classic',
    color: '#ffffff',
    effect: 'shadow',
    align: 'center',
    cx: 0.5,
    cy: 0.5,
    scale: 1,
    rotationDeg: 0,
    opacity: 1,
    startMs: 0,
    endMs: 6000,
    ...over,
  } as EditOverlay;
}

describe('EditorStore tracking', () => {
  let store: EditorStore;
  let made: ReturnType<typeof footage>;

  /** The post, with every clip's shape already reported by the preview unless `shapes` is false. */
  function load(clips: EditClip[], overlays: EditOverlay[], shapes = true): void {
    const sources: EditorSource[] = clips.map(c => ({ key: c.clipKey, fileName: `${c.clipKey}.mp4`, playbackUrl: `https://example.test/${c.clipKey}.mp4` }));
    const m: EditManifest = { ...emptyManifest(), clips, overlays };
    m.output = { width: 720, height: 1280, fps: 30 };
    store.load(sources, new Map(clips.map(c => [c.clipKey, c.outMs])), m);
    if (shapes) for (const c of clips) store.noteSourceShape(c.clipKey, 720 / 1280);
  }

  /** A clip's shape read from its file only when `answer` is called, so a test can act while it is read. */
  function slowShape(): { answer: () => void; asked: () => number } {
    let asked = 0;
    const waiting: Array<() => void> = [];
    store.probeTrackFootage = async () => {
      asked++;
      await new Promise<void>(resolve => waiting.push(resolve));
      return { width: 720, height: 1280 };
    };
    return { answer: () => waiting.splice(0).forEach(resolve => resolve()), asked: () => asked };
  }

  const layer = () => store.manifest.value.overlays[0]!;

  /** Opens the Track sheet on the caption, with the playhead at `atMs`, the way the tool row does. */
  function openOn(atMs: number): void {
    store.seek(atMs);
    store.select({ kind: 'overlay', id: 't' });
    store.openTrack();
  }

  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 5000 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 2));
    if (!done()) throw new Error('timed out');
  }

  beforeEach(() => {
    store = new EditorStore(resolveEditorHost());
    store.attachPlayer({
      seek: ms => (store.playheadMs.value = ms),
      play: () => (store.playing.value = true),
      pause: () => (store.playing.value = false),
    });
    made = footage();
    store.openTrackFootage = made.open;
  });

  it('puts what a run had found on the layer the moment the sheet shuts, so Next reads it', async () => {
    load([clip('a', 10_000)], [caption()]);
    openOn(3000);
    const running = store.startTracking();
    await until(() => made.read() >= 8);
    // What Next does: shut the sheet, then read the post, in one turn.
    store.closePanel();
    const track = store.manifest.value.overlays[0]!.track;
    expect(track).toBeTruthy();
    expect(track!.atMs.length).toBeGreaterThanOrEqual(7);
    expect(store.trackRun.value).toBeNull();
    const shut = store.manifest.value;
    await running;
    // The run winding down afterwards puts nothing more on: one step, and the post as the sheet left it.
    expect(store.manifest.value).toBe(shut);
    store.undo();
    expect(layer().track).toBeUndefined();
    expect(store.canUndo.value).toBe(false);
  });

  it('puts what a run had found on the layer the moment Stop is pressed, and keeps the sheet open', async () => {
    load([clip('a', 10_000)], [caption()]);
    openOn(3000);
    const running = store.startTracking();
    await until(() => made.read() >= 8);
    store.stopTracking();
    expect(layer().track!.atMs.length).toBeGreaterThanOrEqual(7);
    expect(store.panel.value).toBe('track');
    expect(store.trackRun.value).toBeNull();
    const stopped = store.manifest.value;
    await running;
    expect(store.manifest.value).toBe(stopped);
    // Stopped is not finished: nothing plays back.
    expect(store.playing.value).toBe(false);
  });

  it('starts nothing once the sheet has shut while the clip was still being measured', async () => {
    // The preview has not reported the clip's shape yet, so the run reads it off the file first.
    load([clip('a', 10_000)], [caption()], false);
    const shape = slowShape();
    openOn(3000);
    const running = store.startTracking();
    expect(shape.asked()).toBe(1);
    // Under way from the tap: the sheet says so, and a second tap starts nothing more.
    expect(store.trackRun.value).not.toBeNull();
    void store.startTracking();
    expect(shape.asked()).toBe(1);
    store.closePanel();
    expect(store.trackRun.value).toBeNull();
    shape.answer();
    await running;
    expect(made.asked).toEqual([]);
    expect(store.trackRun.value).toBeNull();
    expect(layer().track).toBeUndefined();
    expect(store.canUndo.value).toBe(false);
  });

  it('starts nothing once Stop is pressed while the clip was still being measured, and can start again', async () => {
    // A second on screen, so the run that does start is a short one.
    load([clip('a', 10_000)], [caption({ startMs: 2500, endMs: 3500 })], false);
    const shape = slowShape();
    openOn(3000);
    const running = store.startTracking();
    store.stopTracking();
    expect(store.trackRun.value).toBeNull();
    shape.answer();
    await running;
    expect(made.asked).toEqual([]);
    expect(layer().track).toBeUndefined();
    expect(store.panel.value).toBe('track');
    // Tapped again, it runs.
    const again = store.startTracking();
    shape.answer();
    await again;
    expect(made.asked.length).toBeGreaterThan(0);
    expect(layer().track).toBeTruthy();
  });

  it('reads the outgoing clip on under a dissolve, where the layer is still on screen', async () => {
    // A one-second dissolve from a into b: a's slot ends at 9 s, its picture at 10 s. The caption runs
    // to 9.8 s, so a run on a reads to there, not to the end of a's slot.
    load([clip('a', 10_000), clip('b', 10_000, { transitionIn: { kind: 'dissolve', durationMs: 1000 } })], [caption({ startMs: 8000, endMs: 9800 })]);
    openOn(8500);
    await store.startTracking();
    const on = made.asked[0]!;
    expect(on.fromMs).toBeCloseTo(8500, 0);
    expect(on.toMs).toBeCloseTo(9800, 0);
    expect(layer().track!.atMs.at(-1)!).toBeGreaterThan(9700);
  });

  it('stops the result playing back when the box is taken hold of, so it is put on the frame the run starts from', async () => {
    load([clip('a', 10_000)], [caption({ startMs: 2500, endMs: 3500 })]);
    openOn(3000);
    await store.startTracking();
    // Finished with the sheet open: the layer rides along once, from its start.
    expect(store.playing.value).toBe(true);
    // The playback has got to 3.2 s when a finger lands on the box.
    store.playheadMs.value = 3200;
    store.holdTrackFrame();
    store.setTrackAim({ cx: 0.4, cy: 0.4, w: 0.3, h: 0.2 });
    expect(store.playing.value).toBe(false);
    expect(store.playheadMs.value).toBe(3200);
    // And the playback is over, not paused: reaching its end later parks nothing.
    store.playheadMs.value = 3500;
    await Promise.resolve();
    expect(store.playheadMs.value).toBe(3500);
  });

  it('reads no playhead for a layer with no track', () => {
    load([clip('a', 10_000)], [caption()]);
    let runs = 0;
    const stop = effect(() => {
      store.shownOverlay(store.manifest.value.overlays[0]!);
      runs++;
    });
    store.seek(1000);
    store.seek(2000);
    expect(runs).toBe(1);
    stop();
  });
});
