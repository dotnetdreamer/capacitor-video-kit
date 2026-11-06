import { describe, expect, it } from 'vitest';

import type { ComposeCamera, SubjectInfo } from '../video-composer/definitions';
import { subjectGrid } from '../video-composer/web/subject-tracker';

import { defaultClipEdit, emptyManifest, type EditClip, type EditManifest, type EditOverlay, type StickerOverlay } from './edit-manifest';
import { compileLayoutMotions } from './layout-motion';
import {
  MATTE_STEP_MS,
  PeopleMask,
  anyoneIn,
  behindWindows,
  buildPeopleMatte,
  buildPeopleMatteAsync,
  footageMap,
  hasBehindLayers,
  isBehind,
  matteKeys,
  matteTimes,
  peopleSourceKeys,
  planeAt,
  planeOf,
  videoLayersAt,
  type PeopleScene,
  type PeopleSources,
} from './people-matte';
import { encodeSubjectTrack, parseSubjectTrack, type SubjectTrack } from './subject-track';

/*
 * A 9:16 post. Source "a" is 9:16 too, its person a block of cells; source "b" is 16:9 with nobody in it, or its
 * own person, and goes on a layer as a picture in picture.
 */

const OUT = { width: 108, height: 192, fps: 30 };

/** A subject track of a `aspect` source whose cell (x, y) at frame time t is `id(t, x, y)`. */
function track(aspect: number, times: number[], id: (t: number, x: number, y: number, w: number, h: number) => number): SubjectTrack {
  const { width, height } = subjectGrid(aspect, 1);
  const frames = times.map(t => {
    const cells = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) cells[y * width + x] = id(t, x, y, width, height);
    return cells;
  });
  return parseSubjectTrack(encodeSubjectTrack({ width, height, times, frames, meta: { engine: 'mediapipe', kind: 'video', durationMs: 10_000, fps: 10, subjects: [] } }));
}

const TEN_FPS = Array.from({ length: 101 }, (_, i) => i * 100);

/** Somebody standing in the middle, drifting right a cell every 100 ms. */
const walker = track(9 / 16, TEN_FPS, (t, x, y) => (x >= 40 + t / 100 && x < 120 + t / 100 && y >= 40 && y < 300 ? 1 : 0));
const nobody = track(16 / 9, TEN_FPS, () => 0);

const sticker: StickerOverlay = { id: 'k', kind: 'sticker', emoji: null, assetId: 'heart', cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 1000, endMs: 4000, behind: true };

function post(extra: Partial<EditManifest> = {}): EditManifest {
  const m = emptyManifest();
  m.output = { ...OUT };
  m.fit = 'cover';
  m.clips = [defaultClipEdit('a', 10_000)];
  m.overlays = [sticker];
  return { ...m, ...extra };
}

function pip(clip: Partial<EditClip> = {}): EditManifest['videoTracks'][number] {
  return { id: 't1', clips: [{ ...defaultClipEdit('b', 10_000, 'b1'), fit: 'contain', rect: { x: 0, y: 0, w: 0.5, h: 0.25 }, ...clip }], startMs: 0, z: 1, opacity: 1 };
}

function scene(m: EditManifest, camera: ComposeCamera | null = null): PeopleScene {
  return { manifest: m, camera, layout: compileLayoutMotions(m) };
}

const SOURCES: PeopleSources = { people: new Map([['a', walker], ['b', nobody]]) };

/** The mask the long way round: every cell through [LayerMap.toSource], front-most layer first. */
function reference(s: PeopleScene, sources: PeopleSources, t: number): Uint8Array {
  const { width, height } = subjectGrid(OUT.width, OUT.height);
  const out = new Uint8Array(width * height);
  const layers = videoLayersAt(s.manifest, t).map(footage => {
    const people = sources.people.get(footage.clip.clipKey)!;
    const span = people.span(footage.sourceMs);
    return { map: footageMap(s, footage, t, people.width / people.height), people, cells: people.frame(span.weight < 0.5 ? span.from : span.to) };
  });
  for (let gy = 0; gy < height; gy++) {
    for (let gx = 0; gx < width; gx++) {
      for (let k = layers.length - 1; k >= 0; k--) {
        const { map, people, cells } = layers[k]!;
        const at = map?.toSource(((gx + 0.5) * OUT.width) / width, ((gy + 0.5) * OUT.height) / height);
        if (!at) continue;
        const cx = Math.min(people.width - 1, Math.floor(at.u * people.width));
        const cy = Math.min(people.height - 1, Math.floor(at.v * people.height));
        out[gy * width + gx] = cells[cy * people.width + cx]! > 0 ? 1 : 0;
        break;
      }
    }
  }
  return out;
}

function count(cells: Uint8Array): number {
  let n = 0;
  for (const c of cells) n += c;
  return n;
}

describe('which layers are behind the people', () => {
  it('is a layer that says so, never an effect, and only over the windows the wire carries', () => {
    expect(isBehind(sticker)).toBe(true);
    expect(isBehind({ kind: 'effect', behind: true })).toBe(false);
    expect(isBehind({ kind: 'text' })).toBe(false);
    const text = { id: 'x', kind: 'text', text: '  ', styleId: 'classic', color: '#fff', effect: 'shadow', align: 'center', cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 0, behind: true } as EditOverlay;
    const late = { ...sticker, id: 'late', startMs: 9_999, endMs: 0 };
    const second = { ...sticker, id: 'k2', startMs: 3500, endMs: 6000 };
    const m = post({ overlays: [sticker, text, late, second, { ...sticker, id: 'over', behind: undefined, startMs: 7000, endMs: 8000 }] });
    expect(hasBehindLayers(m)).toBe(true);
    expect(behindWindows(m)).toEqual([{ startMs: 1000, endMs: 6000 }]);
    expect(hasBehindLayers(post({ overlays: [] }))).toBe(false);
  });

  it('names every source on screen while a layer is behind, the pictures over the people included', () => {
    const m = post({ clips: [defaultClipEdit('a', 2000), defaultClipEdit('c', 2000), defaultClipEdit('d', 2000)], videoTracks: [{ ...pip(), startMs: 3000 }] });
    expect(peopleSourceKeys(m, behindWindows(m))).toEqual(['a', 'c', 'b']);
    expect(peopleSourceKeys(m, [{ startMs: 100, endMs: 900 }])).toEqual(['a']);
  });

  it('says whether anybody the finder found is on screen in a window', () => {
    const m = post();
    const seen = (startMs: number, endMs: number): SubjectInfo[] => [{ id: 1, kind: 'person', startMs, endMs, peakMs: startMs, box: { x: 0, y: 0, w: 1, h: 1 }, area: 0.2 }];
    expect(anyoneIn(m, { startMs: 1000, endMs: 4000 }, () => seen(3000, 9000))).toBe(true);
    expect(anyoneIn(m, { startMs: 1000, endMs: 4000 }, () => seen(5000, 9000))).toBe(false);
    expect(anyoneIn(m, { startMs: 1000, endMs: 4000 }, () => null)).toBe(false);
    // Slowed to half speed, the window shows 500..2000 of the source.
    const slow = post({ clips: [{ ...defaultClipEdit('a', 10_000), speed: 0.5 }] });
    expect(anyoneIn(slow, { startMs: 1000, endMs: 4000 }, () => seen(2500, 9000))).toBe(false);
    expect(anyoneIn(slow, { startMs: 1000, endMs: 4000 }, () => seen(1500, 9000))).toBe(true);
  });
});

describe('the people on the output frame', () => {
  it('lists the layers drawn at an instant bottom to top, a layer at no opacity left out', () => {
    const m = post({ videoTracks: [{ ...pip(), z: 2 }, { ...pip(), id: 't2', z: 1, opacity: 0 }] });
    expect(videoLayersAt(m, 500).map(f => [f.clip.id, f.base, f.sourceMs])).toEqual([
      ['a', true, 500],
      ['b1', false, 500],
    ]);
  });

  it('agrees with the painter placement cell for cell: turned, cropped, zoomed, a bar and all', () => {
    const turned = post({
      clips: [{ ...defaultClipEdit('a', 10_000), rect: { x: 0.1, y: 0.15, w: 0.8, h: 0.6, rotationDeg: 17 }, crop: { x: 0.05, y: 0, w: 0.9, h: 0.95 } }],
      videoTracks: [pip({ rect: { x: 0.3, y: 0.55, w: 0.6, h: 0.3, rotationDeg: -8 } })],
    });
    const camera: ComposeCamera = { atMs: [0, 4000], scale: [1, 2], cx: [0.5, 0.4], cy: [0.5, 0.45] };
    for (const [m, cam] of [
      [post({ videoTracks: [pip()] }), null],
      [turned, null],
      [turned, camera],
    ] as const) {
      const s = scene(m, cam);
      for (const t of [0, 1500, 2950]) {
        const mask = new PeopleMask().at(s, SOURCES, t);
        expect(Array.from(mask.cells)).toEqual(Array.from(reference(s, SOURCES, t)));
      }
    }
  });

  it('is the source person where the picture is, nobody under a picture over it, and the base through its bar', () => {
    const s = scene(post({ videoTracks: [pip()] }));
    const mask = new PeopleMask().at(s, SOURCES, 0);
    const { width } = mask;
    const at = (gx: number, gy: number) => mask.cells[gy * width + gx];
    expect(at(100, 200)).toBe(1);
    expect(at(10, 200)).toBe(0);
    // Under the picture in picture, which has nobody: 0.
    expect(at(60, 50)).toBe(0);
    // The layer's bar below its 16:9 picture is no picture, so the base decides.
    expect(at(60, 72)).toBe(1);
    expect(mask.any).toBe(true);
  });

  it('hands the same grid back while nothing it is made from moves', () => {
    const s = scene(post());
    const mask = new PeopleMask();
    const first = mask.at(s, SOURCES, 1000);
    expect(mask.at(s, SOURCES, 1020).version).toBe(first.version);
    expect(mask.at(s, SOURCES, 1180).version).toBe(first.version + 1);
    expect(mask.made).toBe(2);
  });

  it('is nobody where nobody was found, and nobody at all past every picture', () => {
    const s = scene(post());
    expect(new PeopleMask().at(s, { people: new Map() }, 1000).any).toBe(false);
    const past = new PeopleMask().at(scene(post({ durationMs: 20_000 })), SOURCES, 15_000);
    expect(past.any).toBe(false);
  });

  it('reads a plane exactly where the map does', () => {
    const m = post({ clips: [{ ...defaultClipEdit('a', 10_000), rect: { x: 0.2, y: 0.1, w: 0.5, h: 0.7, rotationDeg: 33 } }] });
    const s = scene(m, { atMs: [0], scale: [1.7], cx: [0.4], cy: [0.6] });
    const footage = videoLayersAt(m, 0)[0]!;
    const map = footageMap(s, footage, 0, 9 / 16)!;
    const plane = planeOf(map, OUT, null, new Uint8Array(180 * 320).fill(1), 180, 320)!;
    let random = 7;
    for (let i = 0; i < 2000; i++) {
      random = (random * 1103515245 + 12345) % 2147483648;
      const x = (random / 2147483648) * OUT.width;
      random = (random * 1103515245 + 12345) % 2147483648;
      const y = (random / 2147483648) * OUT.height;
      expect(planeAt(plane, x, y) === 1).toBe(map.toSource(x, y) !== null);
    }
  });
});

describe('the matte an export is handed', () => {
  it('has a frame every 30th of a second, or the finder frames where those are coarser, and either side of a cut', () => {
    const still = post({ clips: [defaultClipEdit('a', 2000), defaultClipEdit('a', 8000, 'a2')] });
    const times = matteTimes(scene(still), SOURCES, behindWindows(still));
    // The finder read 10 a second: coarser than 30, so its frames, from 1000 to 4000, with the cut at 2000 either side.
    expect(times).toContain(1000);
    expect(times).toContain(1100);
    expect(times).toContain(1999);
    expect(times).toContain(2000);
    expect(times).toContain(3999);
    expect(times.length).toBeLessThan(40);
    // A camera moves the people between two of the finder frames: every 30th of a second.
    const zoomed = matteTimes(scene(still, { atMs: [0, 5000], scale: [1, 2], cx: [0.5, 0.5], cy: [0.5, 0.5] }), SOURCES, behindWindows(still));
    expect(zoomed.length).toBeGreaterThanOrEqual(Math.floor(3000 / MATTE_STEP_MS));
    for (let i = 1; i < zoomed.length; i++) expect(zoomed[i]! - zoomed[i - 1]!).toBeLessThanOrEqual(34);
    // Sped up four times the finder frames are 25 ms apart, finer than 30 a second: the grid.
    const fast = post({ clips: [{ ...defaultClipEdit('a', 10_000), speed: 4 }] });
    const quick = matteTimes(scene(fast), SOURCES, behindWindows(fast));
    expect(quick.length).toBeLessThan(3000 / 25);
    expect(quick.every((t, i) => i === 0 || t > quick[i - 1]!)).toBe(true);
  });

  it('is a subject track over the output, its frames the mask at its times, read by one key', () => {
    const m = post({ videoTracks: [pip()], overlays: [{ ...sticker, id: 'fresh', startMs: 500 }] });
    const s = scene(m);
    const file = buildPeopleMatte(m, s, SOURCES)!;
    expect(file.keys).toEqual(matteKeys());
    const read = parseSubjectTrack(file.bytes);
    expect([read.width, read.height]).toEqual([180, 320]);
    const times = matteTimes(s, SOURCES, behindWindows(m));
    expect(Array.from(read.times)).toEqual(times);
    expect(file.frames).toBe(times.length);
    for (const i of [0, 5, times.length - 1]) expect(Array.from(read.frame(i))).toEqual(Array.from(reference(s, SOURCES, times[i]!)));
    // Made once: the same post hands the same bytes back.
    expect(buildPeopleMatte(m, s, SOURCES)).toBe(file);
  });

  it('is made a slice at a time, the same bytes', async () => {
    const m = post({ overlays: [{ ...sticker, id: 'sliced', endMs: 3000 }] });
    const s = scene(m);
    const sliced = await buildPeopleMatteAsync(m, s, SOURCES, { sliceMs: 0 });
    const whole = buildPeopleMatte({ ...m, overlays: [...m.overlays] }, { ...s }, { people: new Map(SOURCES.people) });
    expect(Array.from(sliced!.bytes)).toEqual(Array.from(whole!.bytes));
  });

  it('is none for a post with nobody behind, or nobody found', () => {
    const m = post({ overlays: [{ ...sticker, behind: undefined }] });
    expect(buildPeopleMatte(m, scene(m), SOURCES)).toBeNull();
    const lonely = post({ overlays: [{ ...sticker, id: 'lonely' }] });
    expect(buildPeopleMatte(lonely, scene(lonely), { people: new Map([['b', nobody]]) })).toBeNull();
  });

  it('costs a few milliseconds a frame for a 1080x1920 post with a picture in picture', () => {
    const big = post({ output: { width: 1080, height: 1920, fps: 30 }, videoTracks: [pip({ rect: { x: 0.45, y: 0.05, w: 0.5, h: 0.3, rotationDeg: 6 } })] });
    const s = scene(big, { atMs: [0, 10_000], scale: [1, 1.5], cx: [0.5, 0.45], cy: [0.5, 0.5] });
    const mask = new PeopleMask();
    for (let t = 0; t < 400; t += 20) mask.at(s, SOURCES, t);
    const started = performance.now();
    const frames = 60;
    for (let i = 0; i < frames; i++) mask.at(s, SOURCES, 1000 + i * 33);
    const each = (performance.now() - started) / frames;
    console.log(`[people-matte] one output-space mask frame (${mask.made} made): ${each.toFixed(2)} ms`);
    expect(count(mask.at(s, SOURCES, 3000).cells)).toBeGreaterThan(0);
    expect(each).toBeLessThan(60);
  });
});
