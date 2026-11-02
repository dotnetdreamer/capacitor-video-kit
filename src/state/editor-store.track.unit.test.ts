import { effect } from '@preact/signals-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultClipEdit, emptyManifest, trackedPoseAt, trackedThingAt, type EditClip, type EditManifest, type EditOverlay, type EditTrack } from '../editor';

import { resolveEditorHost } from '../host/defaults';
import type { EditorSource } from '../host/host.types';
import { TrackStoppedError, type TrackFrame, type TrackFrameSource } from '../video-composer/web/track-frames';
import { EditorStore } from './editor-store';

/*
 * The Track sheet and the track rows, as the store drives them: what Stop and the sheet shutting leave on
 * the post, and WHEN - Next reads the post in the same turn it shuts the sheet - the stretch of footage a
 * run is asked to read, the frame a moved box is put on, and what each track tool does to the post's
 * tracks and the layers that follow them. The footage is made up: a still, textured picture, read a frame
 * at a time with a pause between frames, so a test can act while a run is part way. The player is a
 * stand-in that moves the playhead where it is told and plays when asked.
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

/** The frames of a 4 s clip, as a run reads them: SOURCE ms, thirty a second. */
const FRAMES = Array.from({ length: 121 }, (_, k) => Math.round(k * STEP));

/** The thing walking right a tenth of the frame a second, from 0.3 of the way across. */
const WALKING = FRAMES.map(t => 0.3 + t / 10_000);

/** Track "k" of clip "a", a sample a frame for 4 s: the thing standing still in the middle unless `over` says otherwise. */
function thing(over: Partial<EditTrack> = {}): EditTrack {
  return {
    id: 'k',
    name: 'Track 1',
    hue: 0,
    clipId: 'a',
    clipKey: 'a',
    aspect: 720 / 1280,
    box: { w: 0.2, h: 0.1 },
    atMs: FRAMES,
    x: FRAMES.map(() => 0.5),
    y: FRAMES.map(() => 0.5),
    scale: FRAMES.map(() => 1),
    turn: FRAMES.map(() => 0),
    smooth: 0,
    ...over,
  };
}

/** Following track "k" a tenth of the frame above the thing, pinned at `atMs`. */
function onThing(atMs = 0, dx = 0, dy = -0.1): EditOverlay['follow'] {
  return { trackId: 'k', pin: { atMs, dx, dy } };
}

describe('EditorStore tracking', () => {
  let store: EditorStore;
  let made: ReturnType<typeof footage>;

  /** The post, with every clip's shape already reported by the preview unless `shapes` is false. */
  function load(clips: EditClip[], overlays: EditOverlay[], shapes = true, tracks?: EditTrack[]): void {
    const sources: EditorSource[] = clips.map(c => ({ key: c.clipKey, fileName: `${c.clipKey}.mp4`, playbackUrl: `https://example.test/${c.clipKey}.mp4` }));
    const m: EditManifest = { ...emptyManifest(), clips, overlays, ...(tracks ? { tracks } : {}) };
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
  const overlay = (id: string) => store.manifest.value.overlays.find(o => o.id === id)!;

  /** Where `o` is drawn at `t` on the post as it is now. */
  const poseOf = (o: EditOverlay, t: number) => trackedPoseAt(o, store.trackScene.value, t)!;

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

  it('puts what a run had found on the post, the layer pinned to it, the moment the sheet shuts, so Next reads it', async () => {
    load([clip('a', 10_000)], [caption()]);
    openOn(3000);
    const running = store.startTracking();
    await until(() => made.read() >= 8);
    // What Next does: shut the sheet, then read the post, in one turn.
    store.closePanel();
    const track = store.manifest.value.tracks?.[0];
    expect(track).toBeTruthy();
    expect(track!.atMs.length).toBeGreaterThanOrEqual(7);
    expect(layer().follow?.trackId).toBe(track!.id);
    expect(store.trackRun.value).toBeNull();
    const shut = store.manifest.value;
    await running;
    // The run winding down afterwards puts nothing more on: one step, and the post as the sheet left it.
    expect(store.manifest.value).toBe(shut);
    store.undo();
    expect(layer().follow).toBeUndefined();
    expect(store.manifest.value.tracks).toBeUndefined();
    expect(store.canUndo.value).toBe(false);
  });

  it('puts what a run had found on the post the moment Stop is pressed, and keeps the sheet open', async () => {
    load([clip('a', 10_000)], [caption()]);
    openOn(3000);
    const running = store.startTracking();
    await until(() => made.read() >= 8);
    store.stopTracking();
    expect(store.tracks.value[0]!.atMs.length).toBeGreaterThanOrEqual(7);
    expect(layer().follow?.trackId).toBe(store.tracks.value[0]!.id);
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
    expect(layer().follow).toBeUndefined();
    expect(store.tracks.value).toEqual([]);
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
    expect(layer().follow).toBeUndefined();
    expect(store.panel.value).toBe('track');
    // Tapped again, it runs.
    const again = store.startTracking();
    shape.answer();
    await again;
    expect(made.asked.length).toBeGreaterThan(0);
    expect(layer().follow).toBeTruthy();
    expect(store.tracks.value).toHaveLength(1);
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
    expect(store.tracks.value[0]!.atMs.at(-1)!).toBeGreaterThan(9700);
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

  it('reads no playhead for a layer that follows nothing', () => {
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

  it('makes a new track from the main row over the whole segment under the box, and selects it', async () => {
    load([clip('a', 2000)], []);
    store.seek(1000);
    store.openNewTrack();
    expect(store.panel.value).toBe('track');
    expect(store.trackLayer.value).toBeNull();
    expect(store.trackAim.value).not.toBeNull();
    await store.startTracking();
    const tracks = store.manifest.value.tracks!;
    expect(tracks).toHaveLength(1);
    const track = tracks[0]!;
    expect(track).toMatchObject({ name: 'Track 1', hue: 0, clipId: 'a', clipKey: 'a' });
    // Both ways from the frame the box was put on, to either end of the segment.
    expect(track.atMs[0]).toBe(0);
    expect(track.atMs.at(-1)).toBe(2000);
    expect(store.manifest.value.overlays).toEqual([]);
    expect(store.selection.value).toEqual({ kind: 'track', id: track.id });
    expect(store.selectedTrack.value).toBe(track);
    expect(store.trackShown.value).toBe(track);
    store.undo();
    expect(store.manifest.value.tracks).toBeUndefined();
    expect(store.canUndo.value).toBe(false);
  });

  it('names and colours each new track apart from the post\'s others', async () => {
    load([clip('a', 1000)], [], true, [thing({ id: 'j', name: 'Track 1', hue: 0 })]);
    store.seek(500);
    store.openNewTrack();
    await store.startTracking();
    expect(store.tracks.value.map(t => [t.name, t.hue])).toEqual([
      ['Track 1', 0],
      ['Track 2', 1],
    ]);
  });

  it('pins the layer a run started from to the new track, standing where it was put, over the layer\'s time on screen', async () => {
    load([clip('a', 4000)], [caption({ startMs: 1000, endMs: 2000, cx: 0.4, cy: 0.3 })]);
    openOn(1500);
    await store.startTracking();
    const track = store.tracks.value[0]!;
    expect(layer().follow?.trackId).toBe(track.id);
    expect(store.selection.value).toEqual({ kind: 'overlay', id: 't' });
    expect(track.atMs[0]).toBeGreaterThanOrEqual(990);
    expect(track.atMs.at(-1)).toBeLessThanOrEqual(2010);
    // The footage is a still picture: the thing stands still, and the layer with it, where it was put.
    for (const t of [1000, 1500, 2000]) {
      expect(poseOf(layer(), t).cx, `x at ${t}`).toBeCloseTo(0.4, 3);
      expect(poseOf(layer(), t).cy, `y at ${t}`).toBeCloseTo(0.3, 3);
    }
  });

  it('asks which track the layer follows when the post has tracks, and pins it to the one picked where it is drawn', () => {
    load([clip('a', 4000)], [caption({ cx: 0.4, cy: 0.3 })], true, [thing({ x: WALKING })]);
    openOn(2000);
    expect(store.trackChoosing.value).toBe(true);
    // Track does nothing while the sheet is asking.
    void store.startTracking();
    expect(store.trackRun.value).toBeNull();
    store.chooseTrack('k');
    expect(store.trackChoosing.value).toBe(false);
    expect(store.trackShown.value?.id).toBe('k');
    expect(layer().follow?.trackId).toBe('k');
    expect(poseOf(layer(), 2000).cx).toBeCloseTo(0.4, 4);
    expect(poseOf(layer(), 2000).cy).toBeCloseTo(0.3, 4);
    // And from there on it goes with the thing.
    expect(poseOf(layer(), 3000).cx).toBeCloseTo(0.5, 4);
    store.undo();
    expect(layer().follow).toBeUndefined();
  });

  it('aims a new track round the layer when New track is picked instead', () => {
    load([clip('a', 4000)], [caption({ cx: 0.4, cy: 0.3 })], true, [thing()]);
    openOn(2000);
    store.chooseTrack(null);
    expect(store.trackChoosing.value).toBe(false);
    expect(store.trackShown.value).toBeNull();
    expect(store.trackAim.value).toMatchObject({ cx: 0.4, cy: 0.3 });
    expect(layer().follow).toBeUndefined();
    expect(store.canUndo.value).toBe(false);
  });

  it('opens the sheet on the track a layer already follows', () => {
    load([clip('a', 4000)], [caption({ follow: onThing() })], true, [thing()]);
    openOn(2000);
    expect(store.trackChoosing.value).toBe(false);
    expect(store.trackShown.value?.id).toBe('k');
    expect(store.trackAim.value).toBeNull();
  });

  it('puts the next sticker added on the thing, pinned to it, as one step, and only the next', () => {
    load([clip('a', 4000)], [], true, [thing({ x: WALKING })]);
    store.seek(2000);
    store.pinNextTo('k');
    const id = store.addSticker({ emoji: '\u2764' })!;
    const sticker = overlay(id);
    expect(sticker.follow?.trackId).toBe('k');
    const track = store.tracks.value[0]!;
    for (const t of [2000, 3000]) {
      const there = trackedThingAt(track, store.trackScene.value, t)!;
      expect(poseOf(sticker, t).cx, `x at ${t}`).toBeCloseTo(there.cx, 4);
      expect(poseOf(sticker, t).cy, `y at ${t}`).toBeCloseTo(there.cy, 4);
    }
    const second = store.addSticker({ emoji: '\u2764' })!;
    expect(overlay(second).follow).toBeUndefined();
    store.undo();
    expect(store.manifest.value.overlays.map(o => o.id)).toEqual([id]);
    store.undo();
    expect(store.manifest.value.overlays).toEqual([]);
  });

  it('puts the next text started just over the thing, pinned to it', () => {
    load([clip('a', 4000)], [], true, [thing()]);
    store.seek(2000);
    store.pinNextTo('k');
    store.startNewText();
    const text = layer();
    expect(text.kind).toBe('text');
    expect(text.follow?.trackId).toBe('k');
    const there = trackedThingAt(store.tracks.value[0]!, store.trackScene.value, 2000)!;
    const top = Math.min(...there.corners.map(c => c.y));
    expect(poseOf(text, 2000).cx).toBeCloseTo(there.cx, 4);
    expect(poseOf(text, 2000).cy).toBeCloseTo(top - 0.05, 4);
  });

  it('pins nothing next to a track the post does not have', () => {
    load([clip('a', 4000)], [], true, [thing()]);
    store.pinNextTo('gone');
    expect(overlay(store.addSticker({ emoji: '\u2764' })!).follow).toBeUndefined();
  });

  it('keeps every follower where it is drawn at the playhead when its track is smoothed, the drag one step', () => {
    // The thing shaking a fiftieth of the frame either way as it walks.
    const shaky = thing({ x: WALKING.map((x, k) => x + (k % 2 ? 0.02 : -0.02)) });
    load([clip('a', 4000)], [caption({ follow: onThing() }), caption({ id: 'u', follow: { trackId: 'k', pin: { atMs: 3000, dx: 0.1, dy: 0.05 }, scaleWith: true } })], true, [shaky]);
    store.openTrackSheet('k');
    store.seek(1234);
    const before = store.manifest.value;
    const drawn = before.overlays.map(o => poseOf(o, 1234));
    const drag = store.coalesceKey('smooth');
    store.setTrackSmooth(0.5, { coalesce: drag });
    store.setTrackSmooth(0.9, { coalesce: drag });
    expect(store.tracks.value[0]!.smooth).toBe(0.9);
    store.manifest.value.overlays.forEach((o, i) => {
      const now = poseOf(o, 1234);
      expect(now.cx, `x of ${o.id}`).toBeCloseTo(drawn[i]!.cx, 4);
      expect(now.cy, `y of ${o.id}`).toBeCloseTo(drawn[i]!.cy, 4);
      expect(now.scale, `size of ${o.id}`).toBeCloseTo(drawn[i]!.scale, 4);
    });
    store.undo();
    expect(store.manifest.value).toBe(before);
  });

  it('leaves every follower standing where it is drawn when its track is removed, and its pin for the next layer with it', () => {
    load([clip('a', 4000)], [caption({ follow: onThing() }), caption({ id: 'u', follow: onThing(1000, 0.1, 0.05) })], true, [thing({ x: WALKING })]);
    store.select({ kind: 'track', id: 'k' });
    store.pinNextTo('k');
    store.seek(2500);
    const before = store.manifest.value;
    const drawn = before.overlays.map(o => poseOf(o, 2500));
    store.deleteTrack('k');
    expect('tracks' in store.manifest.value).toBe(false);
    store.manifest.value.overlays.forEach((o, i) => {
      expect(o.follow, o.id).toBeUndefined();
      expect(o.cx, `x of ${o.id}`).toBeCloseTo(drawn[i]!.cx, 6);
      expect(o.cy, `y of ${o.id}`).toBeCloseTo(drawn[i]!.cy, 6);
    });
    expect(store.selection.value).toBeNull();
    const id = store.addSticker({ emoji: '\u2764' })!;
    expect(overlay(id).follow).toBeUndefined();
    store.undo();
    store.undo();
    expect(store.manifest.value).toBe(before);
  });

  it('mends a track both ways from the frame a fix starts on, to where the old path was right again', async () => {
    // The old path had the thing a hair low throughout, and from 1.5 s to 2.5 s 0.12 to the right of it.
    const slipped = thing({ x: FRAMES.map(t => (t >= 1500 && t <= 2500 ? 0.62 : 0.5)), y: FRAMES.map(() => 0.51) });
    load([clip('a', 4000)], [caption({ follow: onThing(500) }), caption({ id: 'u', follow: onThing(2000) })], true, [slipped]);
    store.openTrackSheet('k');
    store.seek(2000);
    const before = store.manifest.value;
    const scene = store.trackScene.value;
    const was = (id: string, t: number) => trackedPoseAt(before.overlays.find(o => o.id === id)!, scene, t)!;
    // The box dragged back onto the thing, which the still picture holds where the box is.
    store.setTrackAim({ cx: 0.5, cy: 0.5, w: 0.3, h: 0.3 * (720 / 1280) });
    expect(store.trackAimMoved.value).toBe(true);
    await store.startTracking();
    expect(store.trackAimMoved.value).toBe(false);
    const mended = store.tracks.value[0]!;
    expect(mended.atMs).toEqual(slipped.atMs);
    const at = (t: number) => mended.atMs.indexOf(t);
    // Where it had slipped, the thing is back where the box put it, both ways from the fix frame...
    for (const t of [1600, 2000, 2400]) {
      expect(mended.x[at(t)], `x at ${t}`).toBeCloseTo(0.5, 2);
      expect(mended.y[at(t)], `y at ${t}`).toBeCloseTo(0.5, 2);
    }
    // ...and each way stopped where the old path was right again: what lies beyond is as it was.
    for (const t of [0, 1000, 3000, 4000]) {
      expect(mended.x[at(t)], `x at ${t}`).toBe(slipped.x[at(t)]);
      expect(mended.y[at(t)], `y at ${t}`).toBe(0.51);
    }
    // Each follower is drawn where it was outside the mend, and the one pinned inside it is back on the thing.
    for (const id of ['t', 'u']) {
      for (const t of [500, 1000, 3000, 3500]) {
        expect(poseOf(overlay(id), t).cx, `x of ${id} at ${t}`).toBeCloseTo(was(id, t).cx, 5);
        expect(poseOf(overlay(id), t).cy, `y of ${id} at ${t}`).toBeCloseTo(was(id, t).cy, 5);
      }
    }
    expect(was('u', 2000).cx).toBeCloseTo(0.62, 5);
    expect(poseOf(overlay('u'), 2000).cx).toBeCloseTo(0.5, 2);
    store.undo();
    expect(store.manifest.value).toBe(before);
  });

  it('fixes nothing until the box is moved off the track\'s own thing', async () => {
    load([clip('a', 4000)], [], true, [thing()]);
    store.openTrackSheet('k');
    store.seek(2000);
    await store.startTracking();
    expect(made.asked).toEqual([]);
    expect(store.canUndo.value).toBe(false);
  });

  it('takes the playhead to the next spot of a track worth a second look, with the track\'s sheet open', () => {
    const spotty = thing({ sure: FRAMES.map(t => (t >= 1000 && t <= 1500 ? 20 : 100)) });
    load([clip('a', 4000)], [], true, [spotty]);
    store.seek(0);
    store.fixNextSpot('k');
    expect(store.panel.value).toBe('track');
    expect(store.trackShown.value?.id).toBe('k');
    expect(store.selection.value).toEqual({ kind: 'track', id: 'k' });
    expect(store.playheadMs.value).toBeCloseTo(1250, -1);
    // From past the last spot, round to the first.
    store.seek(3000);
    store.fixNextSpot('k');
    expect(store.playheadMs.value).toBeCloseTo(1250, -1);
  });

  it('says so when a track has no spot worth a second look', () => {
    load([clip('a', 4000)], [], true, [thing()]);
    store.fixNextSpot('k');
    expect(store.toast.value?.text).toBe('Nothing to check on this track');
    expect(store.panel.value).toBeNull();
  });

  it('renames a track as typed, held to a name, as one step', () => {
    load([clip('a', 4000)], [], true, [thing()]);
    store.renameTrack('k', '  The   dog  ');
    expect(store.tracks.value[0]!.name).toBe('The dog');
    store.renameTrack('k', '   ');
    expect(store.tracks.value[0]!.name).toBe('Track');
    store.undo();
    expect(store.tracks.value[0]!.name).toBe('The dog');
  });

  it('has the sheet\'s layer grow with the thing from where it is drawn now, without a jump', () => {
    const growing = thing({ x: WALKING, scale: FRAMES.map(t => 1 + t / 4000) });
    load([clip('a', 4000)], [caption({ follow: onThing() })], true, [growing]);
    openOn(2000);
    expect(store.trackShown.value?.id).toBe('k');
    const drawn = poseOf(layer(), 2000);
    store.setTrackFollow({ scaleWith: true });
    expect(layer().follow?.scaleWith).toBe(true);
    const now = poseOf(layer(), 2000);
    expect(now.cx).toBeCloseTo(drawn.cx, 5);
    expect(now.cy).toBeCloseTo(drawn.cy, 5);
    expect(now.scale).toBeCloseTo(drawn.scale, 5);
    // At 4 s the thing is twice its first size, and a third bigger than at 2 s.
    expect(poseOf(layer(), 4000).scale).toBeCloseTo((drawn.scale * 2) / 1.5, 4);
    store.setTrackFollow({ scaleWith: false });
    expect('scaleWith' in layer().follow!).toBe(false);
  });

  it('takes the sheet\'s layer off its track where it is drawn, keeps the track, and shuts the sheet', () => {
    load([clip('a', 4000)], [caption({ follow: onThing() })], true, [thing({ x: WALKING })]);
    openOn(3000);
    const drawn = poseOf(layer(), 3000);
    store.unpinLayer();
    expect(layer().follow).toBeUndefined();
    expect(layer().cx).toBeCloseTo(drawn.cx, 6);
    expect(layer().cy).toBeCloseTo(drawn.cy, 6);
    expect(store.panel.value).toBeNull();
    expect(store.tracks.value).toHaveLength(1);
    store.undo();
    expect(layer().follow?.trackId).toBe('k');
  });

  it('keeps a track selected, its sheet open, through an undo that leaves it on the post', () => {
    load([clip('a', 4000)], [], true, [thing()]);
    store.openTrackSheet('k');
    store.renameTrack('k', 'Dog');
    store.undo();
    expect(store.selection.value).toEqual({ kind: 'track', id: 'k' });
    expect(store.panel.value).toBe('track');
  });
});
