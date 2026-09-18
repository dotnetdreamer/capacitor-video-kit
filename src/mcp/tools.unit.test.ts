import { describe, expect, it } from 'vitest';

import { emptyManifest, defaultClipEdit, normaliseManifest, type EditManifest } from '../editor/edit-manifest';
import { OP_NAMES, applyEditOps, EditOpError } from './ops';
import { OP_REFERENCE, createTools, type ToolDefinition } from './tools';
import { summariseManifest } from './summary';

/**
 * What these pin is the difference between the tools and the functions under them.
 *
 * The edit operations themselves are already tested next door, against the editor's own rules, and
 * re-testing them through a layer that forwards their arguments would only test the forwarding
 * twice. So what is here is the three things this layer adds and is the only place that could get
 * wrong: an op that names something absent has to FAIL rather than quietly do nothing, a list of
 * ops has to be all or nothing, and the two ways of handing a manifest in have to agree.
 *
 * Plus the one piece of documentation that can go stale silently: the op reference an agent reads
 * to find out what each op takes.
 */

function tool(name: string): ToolDefinition {
  const found = createTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

/** One post, three clips, nothing else - enough for an op to have something to name. */
function threeClips(): EditManifest {
  return {
    ...emptyManifest(),
    clips: [defaultClipEdit('a', 6000), defaultClipEdit('b', 4000), defaultClipEdit('c', 5000)],
  };
}

describe('the op reference an agent reads', () => {
  /*
   * The reference is a table of prose beside a table of functions, and nothing but this makes the
   * two stay together. An op added without a line here would be offered to an agent by name with no
   * way to find out what it takes.
   */
  it('has a line for every op and no line for anything else', () => {
    expect(Object.keys(OP_REFERENCE).sort()).toEqual([...OP_NAMES]);
  });

  it('is listed in the catalogue, so an agent can ask rather than guess', () => {
    const result = tool('catalog_list').run({ section: 'ops' });
    for (const name of OP_NAMES) expect(result.content[0]?.text).toContain(name);
  });
});

describe('an op that names something the post does not have', () => {
  /*
   * The editor's own functions return the manifest unchanged here, which is right for a UI - the
   * button belongs to the clip, so the clip is there - and wrong for a caller that can name
   * anything. Silence would leave an agent reading back a manifest its op did not appear in, with
   * no way to tell "refused" from "ignored".
   */
  it('is refused, and the message says which ids there are', () => {
    expect(() => applyEditOps(threeClips(), [{ op: 'setClipSpeed', clipId: 'nope', speed: 2 }])).toThrow(
      /no clip "nope".*a, b, c/s,
    );
  });

  it('names the position in the list, not just the op', () => {
    const ops = [
      { op: 'setClipSpeed', clipId: 'a', speed: 2 },
      { op: 'removeOverlay', id: 'ghost' },
    ];
    expect(() => applyEditOps(threeClips(), ops)).toThrow(/^op 1 \(removeOverlay\)/);
  });

  it('is refused for a layer, a track and a voiceover too', () => {
    const manifest = threeClips();
    for (const op of [
      { op: 'patchOverlay', id: 'ghost', patch: { opacity: 0.5 } },
      { op: 'setTrackStart', trackId: 'ghost', startMs: 100 },
      { op: 'removeVoiceover', id: 'ghost' },
    ]) {
      expect(() => applyEditOps(manifest, [op])).toThrow(EditOpError);
    }
  });

  it('is refused rather than guessed at when the op itself is not one', () => {
    expect(() => applyEditOps(threeClips(), [{ op: 'makeItPop' }])).toThrow(/unknown op/);
  });
});

describe('a list of ops', () => {
  it('applies them in order, each to what the one before left', () => {
    const next = applyEditOps(threeClips(), [
      { op: 'splitClip', atMs: 3000, newId: 'a2' },
      // Only reachable because the split above put 'a2' on the post.
      { op: 'setClipSpeed', clipId: 'a2', speed: 2 },
    ]);
    expect(next.clips.map((clip) => clip.id)).toEqual(['a', 'a2', 'b', 'c']);
    expect(next.clips[1]?.speed).toBe(2);
  });

  /*
   * The important one. An agent that had to work out which of its ops had landed before the failure
   * would have to re-read the whole manifest to find out, and the obvious guess - that a failure
   * means nothing happened - would be wrong.
   */
  it('changes nothing at all when any one of them is refused', () => {
    const before = threeClips();
    const snapshot = JSON.stringify(before);
    expect(() =>
      applyEditOps(before, [
        { op: 'setClipSpeed', clipId: 'a', speed: 2 },
        { op: 'setClipVolume', clipId: 'b', volume: 0.5 },
        { op: 'removeClip', clipId: 'ghost' },
      ]),
    ).toThrow();
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('goes through the editor’s own rules rather than writing what it was given', () => {
    // 99x is not a speed; the editor clamps to 4 and the tool has no opinion of its own about it.
    const next = applyEditOps(threeClips(), [{ op: 'setClipSpeed', clipId: 'a', speed: 99 }]);
    expect(next.clips[0]?.speed).toBe(4);
  });

  it('refuses an id that is already taken rather than making two clips nobody can tell apart', () => {
    expect(() => applyEditOps(threeClips(), [{ op: 'splitClip', atMs: 3000, newId: 'b' }])).toThrow(/already on this post/);
  });
});

describe('the two ways of handing a manifest in', () => {
  it('takes an id from an earlier call', () => {
    const tools = createTools();
    const created = tools.find((t) => t.name === 'manifest_create')!.run({ sources: [{ clipKey: 'a', durationMs: 4000 }] });
    const id = (created.structuredContent as { manifestId: string }).manifestId;

    const edited = tools
      .find((t) => t.name === 'manifest_edit')!
      .run({ manifestId: id, ops: [{ op: 'setClipMuted', clipId: 'a', muted: true }] });

    const manifest = (edited.structuredContent as { manifest: EditManifest }).manifest;
    expect(manifest.clips[0]?.muted).toBe(true);
    // Written back under the same id, so the next op sees the edit rather than the original.
    expect((edited.structuredContent as { manifestId: string }).manifestId).toBe(id);
  });

  it('takes a whole manifest, and normalises it on the way in', () => {
    const result = tool('manifest_inspect').run({
      manifest: { version: 1, clips: [{ id: 'x', clipKey: 'x.mp4', inMs: 0, outMs: 3000, speed: 1, volume: 1, muted: false }] },
    });
    const manifest = (result.structuredContent as { manifest: EditManifest }).manifest;
    expect(manifest.version).toBe(emptyManifest().version);
    expect(manifest.videoTracks).toEqual([]);
  });

  it('refuses both at once, and neither', () => {
    expect(() => tool('manifest_inspect').run({ manifestId: 'm1', manifest: {} })).toThrow(/not both/);
    expect(() => tool('manifest_inspect').run({})).toThrow(/one of/);
  });

  it('says which ids are open when one is not', () => {
    expect(() => tool('manifest_inspect').run({ manifestId: 'nope' })).toThrow(/no manifest "nope"/);
  });

  it('keeps two servers’ manifests apart', () => {
    const first = createTools().find((t) => t.name === 'manifest_create')!.run({});
    const id = (first.structuredContent as { manifestId: string }).manifestId;
    // A second server has its own store, and its ids start again from the same place.
    expect(() => createTools().find((t) => t.name === 'manifest_inspect')!.run({ manifestId: id })).toThrow(/no manifest/);
  });
});

describe('manifest_validate', () => {
  it('says what version it migrated from', () => {
    const result = tool('manifest_validate').run({ manifest: { version: 1, clips: [] } });
    expect(result.content[0]?.text).toMatch(/Migrated from version 1/);
  });

  it('says so plainly when a manifest it produced itself needs nothing done to it', () => {
    const clean = JSON.parse(JSON.stringify(normaliseManifest(threeClips())));
    const result = tool('manifest_validate').run({ manifest: clean });
    expect(result.content[0]?.text).toMatch(/Nothing had to change/);
  });

  /*
   * A manifest from a LATER version of this package is the case that would otherwise be silent: it
   * normalises without complaint, having quietly dropped whatever that version added.
   */
  it('warns when the manifest is newer than the build reading it', () => {
    const result = tool('manifest_validate').run({ manifest: { version: 99, clips: [] } });
    expect(result.content[0]?.text).toMatch(/NEWER/);
  });
});

describe('the tools themselves', () => {
  it('all declare an object schema and whether they change anything', () => {
    for (const definition of createTools()) {
      expect(definition.inputSchema['type']).toBe('object');
      expect(definition.description.length).toBeGreaterThan(80);
      expect(typeof definition.annotations.readOnlyHint).toBe('boolean');
    }
  });

  it('marks the three that only read as read-only', () => {
    const readOnly = createTools()
      .filter((definition) => definition.annotations.readOnlyHint)
      .map((definition) => definition.name)
      .sort();
    expect(readOnly).toEqual(['catalog_list', 'manifest_inspect', 'manifest_validate']);
  });

  it('refuses two sources that would share one id', () => {
    expect(() =>
      tool('manifest_create').run({ sources: [{ clipKey: 'a', durationMs: 1000 }, { clipKey: 'a', durationMs: 2000 }] }),
    ).toThrow(/share the id "a"/);
  });

  it('refuses a source with no length, because the trim is measured against it', () => {
    expect(() => tool('manifest_create').run({ sources: [{ clipKey: 'a' }] })).toThrow(/durationMs/);
  });
});

describe('the summary an agent reads instead of the JSON', () => {
  it('carries the ids, because an id is what the next op will name', () => {
    const manifest = applyEditOps(threeClips(), [
      { op: 'addText', id: 'title', text: 'Hello' },
      { op: 'addVideoTrack', clipKey: 'd', durationMs: 2000, trackId: 'vt1' },
    ]);
    const summary = summariseManifest(manifest);
    for (const id of ['a', 'b', 'c', 'title', 'vt1']) expect(summary).toContain(id);
  });

  it('gives every time in milliseconds and on the clock', () => {
    // Milliseconds are what the ops take; the clock is how long the post feels.
    expect(summariseManifest(threeClips())).toContain('15000ms (0:15.0)');
  });

  it('states the colour the render will apply, not the one the preset names', () => {
    // A preset at no intensity resolves to nothing at all, which the preset's own name would hide.
    const manifest = applyEditOps(threeClips(), [{ op: 'setFilter', filterId: 'vivid', intensity: 0 }]);
    expect(summariseManifest(manifest)).toMatch(/Resolved colour ops: none/);
  });

  it('says an empty base track renders nothing rather than printing an empty list', () => {
    expect(summariseManifest(emptyManifest())).toMatch(/renders nothing/);
  });
});
