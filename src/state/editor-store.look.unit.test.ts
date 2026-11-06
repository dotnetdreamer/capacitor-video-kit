import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_LOOK_AMOUNT, defaultClipEdit, defaultFocus, emptyManifest, setClipFocus, type EditManifest, type EditTrack } from '../editor';
import { resolveEditorHost } from '../host/defaults';
import type { HapticKind } from '../host/host.types';
import { EditorStore } from './editor-store';

/*
 * A track's look as the store keeps it and the preview reads it: what Blur, Spotlight, Colour pop and
 * Strength write on the track, as how many undo steps and with which haptics, and the frames the preview
 * draws a looked segment from - kept while nothing they were made from changes, so a drag elsewhere or a
 * Strength drag makes nothing it need not.
 */

/** The frames of a 4 s clip, as a run reads them: SOURCE ms, thirty a second. */
const FRAMES = Array.from({ length: 121 }, (_, k) => Math.round((k * 1000) / 30));

/** Track "k" of clip "a", a sample a frame for 4 s: the thing standing still in the middle. */
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

describe('EditorStore track looks', () => {
  let store: EditorStore;
  let felt: HapticKind[];

  const track = (): EditTrack => store.manifest.value.tracks![0]!;

  function load(tracks: EditTrack[]): void {
    const clip = defaultClipEdit('a', 10_000);
    const m: EditManifest = { ...emptyManifest(), clips: [clip], overlays: [], tracks };
    m.output = { width: 720, height: 1280, fps: 30 };
    store.load([{ key: 'a', fileName: 'a.mp4', playbackUrl: 'https://example.test/a.mp4' }], new Map([['a', 10_000]]), m);
  }

  beforeEach(() => {
    store = new EditorStore(resolveEditorHost());
    store.attachPlayer({
      seek: ms => (store.playheadMs.value = ms),
      play: () => (store.playing.value = true),
      pause: () => (store.playing.value = false),
    });
    felt = [];
    store.haptic = kind => {
      felt.push(kind);
    };
  });

  it('puts a look on at its usual strength as one step, felt as a selection', () => {
    load([thing()]);
    expect(store.setTrackLook('k', 'blur')).toBe(true);
    expect(track().look).toEqual({ kind: 'blur', amount: DEFAULT_LOOK_AMOUNT });
    expect(felt).toEqual(['selection']);
    store.undo();
    expect(track().look).toBeUndefined();
  });

  it('takes a Strength drag as one step, never down to nothing, and without a haptic for every step of it', () => {
    load([thing()]);
    store.setTrackLook('k', 'spotlight');
    const drag = store.coalesceKey('track-look');
    store.setTrackLook('k', 'spotlight', 0.5, { coalesce: drag });
    store.setTrackLook('k', 'spotlight', 0.2, { coalesce: drag });
    store.setTrackLook('k', 'spotlight', 0, { coalesce: drag });
    expect(track().look).toEqual({ kind: 'spotlight', amount: 0.01 });
    expect(felt).toEqual(['selection']);
    store.undo();
    expect(track().look).toEqual({ kind: 'spotlight', amount: DEFAULT_LOOK_AMOUNT });
    store.undo();
    expect(track().look).toBeUndefined();
  });

  it('keeps the strength through a change of kind, changes nothing for the look it has, and takes it off for none', () => {
    load([thing()]);
    store.setTrackLook('k', 'blur', 0.4);
    store.setTrackLook('k', 'pop');
    expect(track().look).toEqual({ kind: 'pop', amount: 0.4 });
    expect(store.setTrackLook('k', 'pop')).toBe(false);
    store.setTrackLook('k', null);
    expect('look' in track()).toBe(false);
    expect(felt).toEqual(['selection', 'selection', 'selection']);
    expect(store.setTrackLook('gone', 'blur')).toBe(false);
  });

  it('draws a looked segment from the frames the render reads, kept while nothing they were made from changes', () => {
    load([thing({ look: { kind: 'blur', amount: 0.7 } })]);
    const frames = store.focusFrames.value.get('a')!;
    expect(frames.focus).toMatchObject({ invert: true, blur: 0.021 });
    // The thing in the middle, softened; the corner kept.
    const draw = frames.at(2000);
    const middle = Math.floor(draw.maskHeight / 2) * draw.maskWidth + Math.floor(draw.maskWidth / 2);
    expect([draw.mask[middle], draw.mask[0]]).toEqual([0, 255]);

    // Nothing the look is made from changed: a rename, a trim.
    store.renameTrack('k', 'Face');
    expect(store.focusFrames.value.get('a')).toBe(frames);
    store.commit('Trim', m => ({ ...m, clips: m.clips.map(c => ({ ...c, outMs: 8000 })) }));
    expect(store.focusFrames.value.get('a')).toBe(frames);

    store.setTrackLook('k', 'blur', 0.3);
    const fainter = store.focusFrames.value.get('a')!;
    expect(fainter).not.toBe(frames);
    expect(fainter.track).toBe(frames.track);
    expect(fainter.focus.blur).toBe(0.009);

    // A Focus of the segment's own wins: no subjects found yet, so nothing at all.
    store.commit('Focus', m => setClipFocus(m, 'a', defaultFocus()));
    expect(store.focusFrames.value.has('a')).toBe(false);
  });

  it('draws nothing for a post with no look', () => {
    load([thing()]);
    expect(store.focusFrames.value.size).toBe(0);
  });

  it('tells the Track sheet when a Focus on the track’s own segment wins over its look', () => {
    load([thing({ look: { kind: 'spotlight', amount: 0.5 } })]);
    store.openTrackSheet('k');
    expect(store.trackFocusWins.value).toBe(false);
    store.commit('Focus', m => setClipFocus(m, 'a', defaultFocus()));
    expect(store.trackFocusWins.value).toBe(true);
    expect(store.focusWinsOverLook('k')).toBe(true);
    expect(store.focusWinsOverLook('gone')).toBe(false);
  });
});
