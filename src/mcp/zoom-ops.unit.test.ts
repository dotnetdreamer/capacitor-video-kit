import { describe, expect, it } from 'vitest';

import { FILTER_PRESETS, defaultClipEdit, emptyManifest, normaliseManifest, type EditManifest } from '../editor/edit-manifest';
import { EFFECT_PRESETS } from '../editor/effects';
import { layoutPresets } from '../editor/layout-presets';
import { OP_NAMES, ZOOM_OPS, applyEditOps, opNamesFor, type EditOp } from './ops';
import { summariseManifest } from './summary';

/* An agent's zoom ops land on the same manifest the editor's own actions do, and fail by name. */

const post = (): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('v', 10_000)] });

describe('zoom ops', () => {
  it('adds, updates, moves, duplicates and deletes', () => {
    let m = applyEditOps(post(), [
      { op: 'addZoom', id: 'z', startMs: 1000, cx: 0.9, scale: 3, ease: 'snappy' },
      { op: 'updateZoom', id: 'z', rampMs: 400 },
      { op: 'setZoomWindow', id: 'z', startMs: 1000, endMs: 3000 },
      { op: 'duplicateZoom', id: 'z', newId: 'z2' },
    ]);
    expect(m.zooms.map((z) => [z.id, z.startMs, z.endMs])).toEqual([
      ['z', 1000, 3000],
      ['z2', 3000, 5000],
    ]);
    expect(m.zooms[0]).toMatchObject({ scale: 3, cx: 0.8333, rampMs: 400, ease: 'snappy' });
    expect(summariseManifest(m)).toContain('Zooms: 2 zooms');
    m = applyEditOps(m, [{ op: 'deleteZoom', id: 'z2' }]);
    expect(m.zooms.map((z) => z.id)).toEqual(['z']);
  });

  it('refuses what cannot be done, by name', () => {
    const m = applyEditOps(post(), [{ op: 'addZoom', id: 'z', startMs: 1000, endMs: 4000 }]);
    expect(() => applyEditOps(m, [{ op: 'updateZoom', id: 'nope', scale: 2 }])).toThrow(/no zoom "nope"/);
    expect(() => applyEditOps(m, [{ op: 'addZoom', id: 'z', startMs: 6000 }])).toThrow(/already on this post/);
    expect(() => applyEditOps(m, [{ op: 'addZoom', id: 'y', startMs: 2000 }])).toThrow(/no room/);
    expect(() => applyEditOps(m, [{ op: 'updateZoom', id: 'z', ease: 'bouncy' }])).toThrow();
  });
});

/*
 * The editor's `editing.zoom`, as the ops honour it. Off, every zoom op is refused: the server built
 * on these keeps no zoom in any post, so there is none to change, retime or delete, and adding or
 * duplicating one would put one in. That is stricter than the editor, which keeps a draft's zoom
 * reachable, and `tools.ts` says why. What the ops do NOT do is judge the manifest they are handed:
 * the tools do that at the door, and pin it in `tools.unit.test.ts`.
 */
describe('zoom ops on an app that has turned Zoom off', () => {
  const off = { editing: { zoom: false } };
  const withZoom = (): EditManifest => applyEditOps(post(), [{ op: 'addZoom', id: 'z', startMs: 1000, endMs: 3000 }]);

  /* Each zoom op as an agent would send it, values and all, so it is the setting that refuses it. */
  const zoomOps: Record<string, EditOp> = {
    addZoom: { op: 'addZoom', id: 'z2', startMs: 5000 },
    duplicateZoom: { op: 'duplicateZoom', id: 'z', newId: 'z2' },
    updateZoom: { op: 'updateZoom', id: 'z', scale: 3 },
    setZoomWindow: { op: 'setZoomWindow', id: 'z', startMs: 2000, endMs: 5000 },
    deleteZoom: { op: 'deleteZoom', id: 'z' },
  };

  it('has an example here for every zoom op there is', () => {
    expect(Object.keys(zoomOps).sort()).toEqual([...ZOOM_OPS]);
    expect(OP_NAMES.filter((name) => /zoom/i.test(name))).toEqual([...ZOOM_OPS]);
  });

  it('refuses every zoom op, and says it is the app that turned Zoom off', () => {
    for (const [name, op] of Object.entries(zoomOps)) {
      expect(() => applyEditOps(withZoom(), [op], off), name).toThrow(
        new RegExp(`^op 0 \\(${name}\\): zoom is turned off for this app, so no post on this server holds a zoom`),
      );
    }
    expect(() => applyEditOps(post(), [zoomOps['addZoom']!], off)).toThrow(/none can be added/);
    expect(() => applyEditOps(withZoom(), [zoomOps['duplicateZoom']!], off)).toThrow(/a copy of one would be a new zoom/);
    expect(() => applyEditOps(withZoom(), [zoomOps['deleteZoom']!], off)).toThrow(/no zoom for deleteZoom to act on/);
  });

  /*
   * Before the op's own values are read. An agent told "\"id\" must be a non-empty string" would fix
   * the id and send it again, only to be told the second time that the op was never going to work.
   */
  it('refuses before reading the op, so no correction of its values would get it through', () => {
    for (const name of ZOOM_OPS) expect(() => applyEditOps(post(), [{ op: name }], off), name).toThrow(/turned off/);
  });

  it('refuses the whole list, leaving the post as it was', () => {
    const before = post();
    const snapshot = JSON.stringify(before);
    expect(() =>
      applyEditOps(
        before,
        [
          { op: 'setClipSpeed', clipId: 'v', speed: 2 },
          { op: 'addZoom', id: 'z', startMs: 1000 },
        ],
        off,
      ),
    ).toThrow(/^op 1 \(addZoom\)/);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('leaves every zoom op out of the list an unknown op is answered with', () => {
    expect(() => applyEditOps(post(), [{ op: 'zoomIn' }], off)).toThrow(/unknown op/);
    try {
      applyEditOps(post(), [{ op: 'zoomIn' }], off);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('setClipSpeed');
      for (const name of ZOOM_OPS) expect(message).not.toContain(name);
    }
  });

  it('leaves every zoom op out of opNamesFor, and nothing else', () => {
    expect(opNamesFor({ zoom: false })).toEqual(OP_NAMES.filter((name) => !ZOOM_OPS.includes(name)));
    // The editor's own object written out in place, other fields and all, as a host passes it on.
    expect(opNamesFor({ pictures: true, zoom: false })).toEqual(opNamesFor({ zoom: false }));
    expect(opNamesFor({ replaceKeepsLength: true, pictures: true, zoom: true })).toBe(OP_NAMES);
  });

  /*
   * Both lists are exported, and a host written in plain JavaScript is not stopped by `readonly`,
   * which is a type and nothing at run time. Emptied from outside, the one would have let every
   * server in the process with Zoom off take zoom ops again while its tools still told their agents
   * there were none, and the other would change the op list a server had already handed out.
   */
  it('cannot be talked out of the refusal by changing the exported lists', () => {
    expect(Object.isFrozen(ZOOM_OPS)).toBe(true);
    expect(Object.isFrozen(OP_NAMES)).toBe(true);
    expect(() => (ZOOM_OPS as string[]).splice(0)).toThrow(TypeError);
    expect(() => (OP_NAMES as string[]).push('makeItPop')).toThrow(TypeError);
    expect(() => applyEditOps(post(), [{ op: 'addZoom', id: 'z', startMs: 1000 }], off)).toThrow(/turned off/);
  });

  /* The editor's own rule: only an explicit false takes it away. */
  it('adds zooms as it always has when nothing is said, or when Zoom is said to be on', () => {
    for (const options of [undefined, {}, { editing: {} }, { editing: { zoom: true } }, { editing: { pictures: true, zoom: true } }]) {
      const m = applyEditOps(post(), [{ op: 'addZoom', id: 'z', startMs: 1000 }], options);
      expect(m.zooms.map((z) => z.id)).toEqual(['z']);
    }
  });

  /*
   * The manifest is the caller's. A host calling this directly with a draft that holds a zoom gets
   * the zoom back as it was, the same objects, with the other ops applied around it - it is the
   * tools that refuse such a manifest, at the door, before it gets here.
   */
  it('does not judge the manifest it is handed, and leaves a zoom already in it alone', () => {
    const draft = withZoom();
    const next = applyEditOps(draft, [{ op: 'setClipSpeed', clipId: 'v', speed: 2 }], off);
    expect(next.clips[0]?.speed).toBe(2);
    expect(next.zooms).toBe(draft.zooms);
  });
});

/*
 * No op but the five can put a zoom into a post. Each of the others calls an editor function that
 * spreads the manifest and changes something else, so `zooms` comes out as the array it went in as -
 * which on a server with Zoom off is empty. This runs every one of them, the ones that copy things
 * (duplicating and splitting clips and layers, moving a clip onto a new track, a layout preset)
 * among them, over a post that has clips, tracks, layers, music and a voiceover and no zoom, and
 * checks that none comes out, even after the app would normalise it on reopening.
 *
 * The table must cover every op an app with Zoom off has, so an op added later without a line here
 * fails the first test rather than going unchecked.
 */
describe('no op makes a zoom on a post that has none', () => {
  const off = { editing: { zoom: false } };

  /** Something for every op to name: three base clips, two layers of video, a text, music, a take. */
  function busy(): EditManifest {
    return applyEditOps(
      { ...emptyManifest(), clips: [defaultClipEdit('a', 6000), defaultClipEdit('b', 4000), defaultClipEdit('c', 5000)] },
      [
        { op: 'addVideoTrack', clipKey: 'd', durationMs: 3000, trackId: 'vt' },
        { op: 'addVideoTrack', clipKey: 'e', durationMs: 3000, trackId: 'vt2' },
        { op: 'addText', id: 't1', text: 'Hello' },
        { op: 'setMusic', music: { uri: 'file:///m.mp3', sourceDurationMs: 30_000 } },
        { op: 'addVoiceover', id: 'vo', uri: 'file:///vo.m4a', startMs: 2000, durationMs: 1000 },
      ],
      off,
    );
  }

  const sneaked = { id: 'x', startMs: 1000, endMs: 3000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 300, ease: 'smooth' };

  /* Each is a list, for the one op that needs another before it: a join needs a split. */
  const examples: Record<string, EditOp[]> = {
    trimClip: [{ op: 'trimClip', clipId: 'a', inMs: 500, outMs: 5000, sourceDurationMs: 6000 }],
    setClipSpeed: [{ op: 'setClipSpeed', clipId: 'a', speed: 2 }],
    setClipVolume: [{ op: 'setClipVolume', clipId: 'a', volume: 0.5 }],
    setClipTransition: [{ op: 'setClipTransition', clipId: 'b', transition: { kind: 'dissolve', durationMs: 300 } }],
    setAllTransitions: [{ op: 'setAllTransitions', transition: { kind: 'dissolve' } }],
    setClipMuted: [{ op: 'setClipMuted', clipId: 'a', muted: true }],
    setClipFit: [{ op: 'setClipFit', clipId: 'a', fit: 'cover' }],
    setClipCrop: [{ op: 'setClipCrop', clipId: 'a', crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } }],
    setClipRect: [{ op: 'setClipRect', clipId: 'd', rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 } }],
    setClipRotation: [{ op: 'setClipRotation', clipId: 'd', rotationDeg: 15 }],
    resetClipFraming: [
      { op: 'setClipCrop', clipId: 'a', crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
      { op: 'resetClipFraming', clipId: 'a' },
    ],
    splitClip: [{ op: 'splitClip', atMs: 3000, newId: 'a2' }],
    joinWithNext: [
      { op: 'splitClip', atMs: 3000, newId: 'a2' },
      { op: 'joinWithNext', clipId: 'a' },
    ],
    duplicateClip: [{ op: 'duplicateClip', clipId: 'b', newId: 'b2' }],
    removeClip: [{ op: 'removeClip', clipId: 'c' }],
    moveClip: [{ op: 'moveClip', clipId: 'c', toIndex: 0 }],
    insertClip: [{ op: 'insertClip', clipKey: 'f', durationMs: 3000 }],
    replaceClipSource: [{ op: 'replaceClipSource', clipId: 'b', clipKey: 'g', sourceDurationMs: 8000 }],
    setPostDuration: [{ op: 'setPostDuration', durationMs: 20_000 }],
    addVideoTrack: [{ op: 'addVideoTrack', clipKey: 'h', durationMs: 2000, trackId: 'vt3' }],
    removeVideoTrack: [{ op: 'removeVideoTrack', trackId: 'vt' }],
    setTrackStart: [{ op: 'setTrackStart', trackId: 'vt', startMs: 1000 }],
    setTrackOpacity: [{ op: 'setTrackOpacity', trackId: 'vt', opacity: 0.5 }],
    swapTrackZ: [{ op: 'swapTrackZ', trackId: 'vt' }],
    moveClipToTrack: [{ op: 'moveClipToTrack', clipId: 'c', target: { kind: 'new', index: 1 }, atMs: 0, newTrackId: 'vt4' }],
    // A corner rather than the first preset, which is the full frame a new track already fills.
    applyLayoutPreset: [{ op: 'applyLayoutPreset', trackId: 'vt', presetId: layoutPresets().find((p) => p.id === 'pipTR')!.id }],
    addText: [{ op: 'addText', id: 't2', text: 'Hi' }],
    addSticker: [{ op: 'addSticker', id: 's1', emoji: '🔥' }],
    addImage: [{ op: 'addImage', id: 'i1', uri: 'file:///x.png' }],
    addEffect: [{ op: 'addEffect', id: 'e1', effectId: EFFECT_PRESETS[0]!.id }],
    // The one op that takes an open-ended patch, handed a zoom list by an agent trying its luck: it
    // lands on the layer, where nothing reads it, and never on the post.
    patchOverlay: [{ op: 'patchOverlay', id: 't1', patch: { opacity: 0.5, zooms: [sneaked] } }],
    removeOverlay: [{ op: 'removeOverlay', id: 't1' }],
    duplicateOverlay: [{ op: 'duplicateOverlay', id: 't1', newId: 't1b' }],
    moveLayer: [
      { op: 'addText', id: 't2', text: 'Hi' },
      { op: 'moveLayer', id: 't1', move: 'front' },
    ],
    moveLayerTo: [
      { op: 'addText', id: 't2', text: 'Hi' },
      { op: 'moveLayerTo', id: 't2', toIndex: 0 },
    ],
    setOverlayWindow: [{ op: 'setOverlayWindow', id: 't1', startMs: 1000, endMs: 4000 }],
    splitOverlay: [{ op: 'splitOverlay', id: 't1', atMs: 2000, newId: 't1c' }],
    setMusic: [{ op: 'setMusic', music: { uri: 'file:///n.mp3', sourceDurationMs: 20_000 } }],
    // The other open-ended patch, tried the same way.
    patchMusic: [{ op: 'patchMusic', patch: { volume: 0.5, zooms: [sneaked] } }],
    addVoiceover: [{ op: 'addVoiceover', id: 'vo2', uri: 'file:///vo2.m4a', startMs: 8000, durationMs: 1000 }],
    patchVoiceover: [{ op: 'patchVoiceover', id: 'vo', volume: 0.5 }],
    moveVoiceover: [{ op: 'moveVoiceover', id: 'vo', startMs: 500 }],
    removeVoiceover: [{ op: 'removeVoiceover', id: 'vo' }],
    setFilter: [{ op: 'setFilter', filterId: FILTER_PRESETS[1]!.id }],
    setAdjust: [{ op: 'setAdjust', patch: { brightness: 0.2 } }],
    setFit: [{ op: 'setFit', fit: 'contain' }],
    setOriginalMuted: [{ op: 'setOriginalMuted', muted: true }],
    setOutput: [{ op: 'setOutput', aspect: '16:9' }],
  };

  it('has an example for every op an app with Zoom off has', () => {
    expect(Object.keys(examples).sort()).toEqual([...opNamesFor(off.editing)]);
  });

  it('comes out of every one of them with no zoom, as the post and as the app would reopen it', () => {
    for (const [name, ops] of Object.entries(examples)) {
      // Up to the op the example is for, and then that op, which has to really do something or it
      // would prove nothing about itself.
      const before = applyEditOps(busy(), ops.slice(0, -1), off);
      const next = applyEditOps(before, ops.slice(-1), off);
      expect(JSON.stringify(next), name).not.toBe(JSON.stringify(before));
      expect(next.zooms, name).toEqual([]);
      expect(normaliseManifest(JSON.parse(JSON.stringify(next))).zooms, name).toEqual([]);
    }
  });
});
