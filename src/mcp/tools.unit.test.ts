import { describe, expect, it } from 'vitest';

import { MIN_STORED_ZOOM_MS, MIN_ZOOM_MS, emptyManifest, defaultClipEdit, normaliseManifest, type EditManifest } from '../editor/edit-manifest';
import type { EditorEditingOptions } from '../host/host.types';
import { OP_NAMES, ZOOM_OPS, applyEditOps, EditOpError } from './ops';
import { OP_REFERENCE, createTools, type ToolDefinition, type ToolResult } from './tools';
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

describe('the catalogue', () => {
  /*
   * Its category lists are the editor's own constants. An in-process host that edits the answer it
   * was handed must not be editing them - for the next call, for the next server, or for the editor.
   */
  function named(tools: ToolDefinition[], name: string): ToolDefinition {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  }

  it('hands out copies, so changing one answer changes nothing the next call sees', () => {
    const sections = ['filters', 'effects', 'transitions', 'textStyles'] as const;
    const first = createTools();
    const before = named(first, 'catalog_list').run({}).structuredContent as Record<string, { categories: unknown[] }>;
    const snapshot = JSON.stringify(sections.map((section) => before[section]?.categories));
    for (const section of sections) {
      const categories = before[section]?.categories;
      expect(Array.isArray(categories) && categories.length > 0).toBe(true);
      categories?.splice(0, categories.length);
    }
    for (const tools of [first, createTools()]) {
      const after = named(tools, 'catalog_list').run({}).structuredContent as Record<string, { categories: unknown[] }>;
      expect(JSON.stringify(sections.map((section) => after[section]?.categories))).toBe(snapshot);
    }
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

  /*
   * The op table is a plain object, so a name every object inherits is a property of it without
   * being an op. Looked up as one, `constructor` quietly did nothing, `toString` handed back a
   * string as the manifest, and the rest failed with a TypeError from inside that named no op at
   * all - where the answer an agent can act on is the list of ops there are.
   */
  it('is refused as unknown for a name every object has, which is still not an op', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf']) {
      expect(() => applyEditOps(threeClips(), [{ op: name }])).toThrow(new RegExp(`^op 0 \\(${name}\\): unknown op`));
    }
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

/*
 * `editing.zoom`, the editor's setting, as the tools take it. The ops' own refusal is pinned next
 * door in `zoom-ops.unit.test.ts`. What is here is the rule the tools add on top - with Zoom off, no
 * post on the server holds a zoom, so a manifest that holds one is refused at the door - and that
 * what they TELL an agent agrees with what they then let it do, and that one set of tools' setting
 * stays its own.
 */
describe('an app that has turned Zoom off', () => {
  const off = { editing: { zoom: false } };

  function named(tools: ToolDefinition[], name: string): ToolDefinition {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  }

  /** A ten second post with no zoom, opened in these tools, and its id. */
  function opened(tools: ToolDefinition[]): string {
    const created = named(tools, 'manifest_create').run({ sources: [{ clipKey: 'v', durationMs: 10_000 }] });
    return (created.structuredContent as { manifestId: string }).manifestId;
  }

  const post = (): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('v', 10_000)] });

  /** A post that holds a zoom, as a draft the app saved would, built where Zoom is on. */
  function withZoom(): EditManifest {
    return applyEditOps(post(), [{ op: 'addZoom', id: 'z', startMs: 1000, endMs: 3000 }]);
  }

  const zoomsOf = (result: { structuredContent?: Record<string, unknown> }) =>
    (result.structuredContent as { manifest: EditManifest }).manifest.zooms;

  const catalogOps = (tools: ToolDefinition[]) => named(tools, 'catalog_list').run({ section: 'ops' });

  /** Every tool that takes a manifest whole, with arguments that would otherwise go through. */
  function wholeManifestCalls(manifest: unknown): [string, Record<string, unknown>][] {
    return [
      ['manifest_inspect', { manifest }],
      ['manifest_validate', { manifest }],
      ['manifest_edit', { manifest, ops: [{ op: 'setClipSpeed', clipId: 'v', speed: 2 }] }],
    ];
  }

  /*
   * The list above has to be every tool with a `manifest` argument, or a tool added later with one
   * would be the way round the door that nobody tested.
   */
  it('knows every tool that takes a manifest whole', () => {
    const takers = createTools(off)
      .filter((definition) => 'manifest' in ((definition.inputSchema['properties'] ?? {}) as Record<string, unknown>))
      .map((definition) => definition.name)
      .sort();
    expect(takers).toEqual(wholeManifestCalls(null).map(([name]) => name).sort());
  });

  it('is not what a host that says nothing gets: those tools add zooms as they always have', () => {
    for (const tools of [createTools(), createTools({}), createTools({ editing: {} }), createTools({ editing: { zoom: true } })]) {
      const result = named(tools, 'manifest_edit').run({ manifestId: opened(tools), ops: [{ op: 'addZoom', id: 'z', startMs: 1000 }] });
      expect(zoomsOf(result).map((zoom) => zoom.id)).toEqual(['z']);
    }
  });

  it('refuses a manifest that holds a zoom, on every tool that takes one whole', () => {
    const tools = createTools(off);
    for (const [name, args] of wholeManifestCalls(withZoom())) {
      expect(() => named(tools, name).run(args), name).toThrow(/Zoom is turned off for this app.*holds 1 zoom/s);
    }
  });

  it('says how many zooms there are and which, and what to send instead', () => {
    const two = applyEditOps(withZoom(), [{ op: 'addZoom', id: 'y', startMs: 5000, endMs: 7000 }]);
    expect(() => named(createTools(off), 'manifest_inspect').run({ manifest: two })).toThrow(
      /^Zoom is turned off for this app, and this manifest holds 2 zooms \("z", "y"\)\. Take them out - "zooms": \[\] - and pass the manifest again/,
    );
    expect(() => named(createTools(off), 'manifest_inspect').run({ manifest: withZoom() })).toThrow(/holds 1 zoom \("z"\)\. Take it out/);
  });

  /* The one tool that makes a manifest has no `manifest` argument, and nothing else it is handed gets in. */
  it('builds a post with no zoom in manifest_create, whatever else it is handed', () => {
    const created = named(createTools(off), 'manifest_create').run({
      sources: [{ clipKey: 'v', durationMs: 10_000 }],
      manifest: withZoom(),
      zooms: withZoom().zooms,
    });
    expect(zoomsOf(created)).toEqual([]);
  });

  /* A refused manifest is not half taken in: nothing is stored, so there is no id to carry on with. */
  it('stores nothing when it refuses', () => {
    const tools = createTools(off);
    for (const [name, args] of wholeManifestCalls(withZoom())) expect(() => named(tools, name).run(args)).toThrow(/turned off/);
    expect(() => named(tools, 'manifest_inspect').run({ manifestId: 'm1' })).toThrow(/no manifest "m1" is open\. /);
  });

  /*
   * Judged as `normaliseManifest` leaves it, which is the object the store would keep, so the test
   * of "holds a zoom" is the editor's own reading of the field and not a second opinion about it.
   */
  it('takes a manifest with no zoom however the field is spelled, including zooms that normalise away', () => {
    const tools = createTools(off);
    const { zooms: _dropped, ...noField } = post();
    const shapes: [string, unknown][] = [
      ['no zooms field', noField],
      ['"zooms": []', { ...post(), zooms: [] }],
      ['"zooms": null', { ...post(), zooms: null }],
      ['"zooms": {}', { ...post(), zooms: {} }],
      ['"zooms": "z"', { ...post(), zooms: 'z' }],
      [
        'entries that are no zoom',
        {
          ...post(),
          zooms: [
            null,
            7,
            'z',
            {},
            { id: 'a', startMs: '1000', endMs: '3000' },
            { id: 'b', startMs: 1000 },
            { id: 'c', startMs: Number.NaN, endMs: 3000 },
            { id: 'd', startMs: 1000, endMs: 1000 + MIN_STORED_ZOOM_MS - 1 },
          ],
        },
      ],
    ];
    for (const [label, manifest] of shapes) {
      for (const [name, args] of wholeManifestCalls(manifest)) {
        expect(zoomsOf(named(tools, name).run(args)), `${label} through ${name}`).toEqual([]);
      }
    }
  });

  it('refuses whatever the normaliser reads as a zoom, however it is spelled', () => {
    const tools = createTools(off);
    const zoom = { id: 'z', startMs: 1000, endMs: 3000 };
    const shapes: [string, unknown][] = [
      ['a zoom with only its window', { ...post(), zooms: [zoom] }],
      ['no id at all', { ...post(), zooms: [{ startMs: 1000, endMs: 3000 }] }],
      ['an id that is not a string', { ...post(), zooms: [{ ...zoom, id: 7 }] }],
      ['values out of range', { ...post(), zooms: [{ ...zoom, scale: 99, cx: -3, rampMs: 1e9, ease: 'bouncy' }] }],
      ['one real zoom among junk', { ...post(), zooms: [null, 'z', { startMs: 'x' }, zoom] }],
      ['a manifest of an old version', { ...post(), version: 1, zooms: [zoom] }],
      ['a manifest of a version newer than this build', { ...post(), version: 99, zooms: [zoom] }],
      ['a manifest with no version', { clips: post().clips, zooms: [zoom] }],
      ['two zooms on one window, the second moved on', { ...post(), zooms: [zoom, { ...zoom, endMs: 3000 + MIN_ZOOM_MS }] }],
      [
        'a template punch, shorter than the zoom sheet makes and long enough to keep',
        { ...post(), zooms: [{ id: 'p', startMs: 1000, endMs: 1000 + MIN_STORED_ZOOM_MS, rampMs: 90, rampOutMs: 0 }] },
      ],
    ];
    for (const [label, manifest] of shapes) {
      for (const [name, args] of wholeManifestCalls(manifest)) {
        expect(() => named(tools, name).run(args), `${label} through ${name}`).toThrow(/Zoom is turned off for this app/);
      }
    }
  });

  /*
   * The review's attack on the host check the README used to suggest - compare the zoom ids that
   * come back with the ones handed out - which an agent beat by reusing an id. None of it gets past
   * the door now, because the door does not care where a zoom came from or what it is called.
   */
  it('refuses the reused-id attack, and every other way of bringing a zoom back, at the door', () => {
    const tools = createTools(off);
    const edit = named(tools, 'manifest_edit');

    // A draft holding zoom "a", handed back as JSON with a second zoom wearing the same id.
    const handedOut = applyEditOps(post(), [{ op: 'addZoom', id: 'a', startMs: 1000, endMs: 3000 }]);
    const returned = JSON.parse(JSON.stringify(handedOut)) as { zooms: Record<string, unknown>[] };
    returned.zooms.push({ ...returned.zooms[0], startMs: 5000, endMs: 7000 });
    for (const [name, args] of wholeManifestCalls(returned)) {
      expect(() => named(tools, name).run(args), name).toThrow(/holds 2 zooms \("a", "a~"\)/);
    }

    // The same draft, with its zoom deleted and added back under the same id, in one list.
    const reAdd = [
      { op: 'deleteZoom', id: 'a' },
      { op: 'addZoom', id: 'a', startMs: 5000, endMs: 7000 },
    ];
    expect(() => edit.run({ manifest: handedOut, ops: reAdd })).toThrow(/^Zoom is turned off for this app, and this manifest holds 1 zoom/);

    // A fresh manifest carrying a zoom the draft never had.
    const fresh = { ...post(), zooms: [{ id: 'b', startMs: 2000, endMs: 4000 }] };
    for (const [name, args] of wholeManifestCalls(fresh)) expect(() => named(tools, name).run(args), name).toThrow(/holds 1 zoom \("b"\)/);

    // And the ops themselves, on a post with no zoom, inline and by id.
    expect(() => edit.run({ manifest: post(), ops: [{ op: 'addZoom', id: 'a', startMs: 1000 }] })).toThrow(/op 0 \(addZoom\)/);
    const id = opened(tools);
    expect(() => edit.run({ manifestId: id, ops: reAdd })).toThrow(/op 0 \(deleteZoom\): zoom is turned off/);
    expect(zoomsOf(named(tools, 'manifest_inspect').run({ manifestId: id }))).toEqual([]);
  });

  it('refuses every zoom op through manifest_edit, saying the app turned Zoom off', () => {
    const tools = createTools(off);
    const edit = named(tools, 'manifest_edit');
    const ops: Record<string, Record<string, unknown>> = {
      addZoom: { op: 'addZoom', id: 'z', startMs: 1000 },
      duplicateZoom: { op: 'duplicateZoom', id: 'z', newId: 'z2' },
      updateZoom: { op: 'updateZoom', id: 'z', scale: 3 },
      setZoomWindow: { op: 'setZoomWindow', id: 'z', startMs: 4000, endMs: 7000 },
      deleteZoom: { op: 'deleteZoom', id: 'z' },
    };
    expect(Object.keys(ops).sort()).toEqual([...ZOOM_OPS]);
    for (const [name, op] of Object.entries(ops)) {
      expect(() => edit.run({ manifestId: opened(tools), ops: [op] }), name).toThrow(
        new RegExp(`op 0 \\(${name}\\): zoom is turned off for this app`),
      );
    }
  });

  it('leaves every zoom op out of manifest_edit’s description and its op schema, and says why', () => {
    const edit = named(createTools(off), 'manifest_edit');
    const schema = edit.inputSchema as { properties: { ops: { items: { properties: { op: { enum: string[] } } } } } };
    const offered = schema.properties.ops.items.properties.op.enum;
    for (const name of ZOOM_OPS) {
      expect(edit.description).not.toContain(name);
      expect(offered).not.toContain(name);
    }
    expect(offered).toEqual(OP_NAMES.filter((name) => !ZOOM_OPS.includes(name)));
    expect(edit.description).toMatch(/Zoom is turned off for this app, so there are no zoom ops/);
    expect(edit.description).toMatch(/a manifest passed in with one is refused/);

    // And a host that left it on still offers every one, with nothing said about it.
    const onEdit = named(createTools(), 'manifest_edit');
    for (const name of ZOOM_OPS) expect(onEdit.description).toContain(name);
    expect(onEdit.description).not.toMatch(/turned off/);
  });

  it('leaves every zoom op out of catalog_list, and says there that Zoom is off', () => {
    const result = catalogOps(createTools(off));
    const text = result.content[0]?.text ?? '';
    const listed = Object.keys((result.structuredContent as { ops: Record<string, string> }).ops).sort();
    for (const name of ZOOM_OPS) {
      expect(text).not.toContain(name);
      expect(listed).not.toContain(name);
    }
    expect(listed).toEqual(OP_NAMES.filter((name) => !ZOOM_OPS.includes(name)));
    expect(text).toMatch(/Zoom is turned off for this app, so there are no zoom ops/);

    expect(catalogOps(createTools()).content[0]?.text).not.toMatch(/turned off/);
  });

  /* Each zoom limit only answers a question about a zoom, and a post here has none. */
  it('drops every zoom limit, and says why they are missing', () => {
    const on = named(createTools(), 'catalog_list').run({ section: 'limits' });
    const limits = named(createTools(off), 'catalog_list').run({ section: 'limits' });
    const data = (limits.structuredContent as { limits: Record<string, unknown> }).limits;
    const zoomKeys = ['maxZooms', 'minZoomMs', 'zoomScale', 'zoomRampMs', 'zoomChainGapMs'];
    for (const key of zoomKeys) {
      expect((on.structuredContent as { limits: Record<string, unknown> }).limits).toHaveProperty(key);
      expect(data).not.toHaveProperty(key);
    }
    expect(Object.keys(data).filter((key) => /zoom/i.test(key))).toEqual([]);
    expect(limits.content[0]?.text).toMatch(/no zooms: Zoom is turned off for this app/);
    expect(limits.content[0]?.text).not.toMatch(/at most \d+ zooms|ramps|pan from/);
  });

  /* Told where the manifest goes in, so the first an agent hears of the rule is not the refusal. */
  it('says on every manifest input that a manifest holding a zoom is refused', () => {
    const help = (tools: ToolDefinition[], name: string) =>
      String((named(tools, name).inputSchema['properties'] as Record<string, { description?: string }>)['manifest']?.description);
    for (const [name] of wholeManifestCalls(null)) {
      expect(help(createTools(off), name), name).toMatch(/Zoom is turned off for this app, so a manifest that holds a zoom is refused/);
      expect(help(createTools(), name), name).not.toMatch(/Zoom/);
    }
  });

  /* Exported, so it is anyone's to read; a view is derived per set of tools and this is left alone. */
  it('does not touch the exported OP_REFERENCE', () => {
    const before = { ...OP_REFERENCE };
    catalogOps(createTools(off));
    expect(OP_REFERENCE).toEqual(before);
    for (const name of ZOOM_OPS) expect(OP_REFERENCE).toHaveProperty(name);
  });

  /*
   * Two sets of tools in one process - which is what these tests are, and what a host serving two
   * apps would be - each held to its own setting, built in either order and used interleaved.
   */
  it('keeps two sets of tools in one process to their own settings', () => {
    const first = createTools();
    const second = createTools(off);
    const third = createTools();

    const add = [{ op: 'addZoom', id: 'z', startMs: 1000 }];
    expect(() => named(second, 'manifest_edit').run({ manifestId: opened(second), ops: add })).toThrow(/turned off/);
    expect(zoomsOf(named(first, 'manifest_edit').run({ manifestId: opened(first), ops: add }))).toHaveLength(1);
    expect(() => named(second, 'manifest_edit').run({ manifestId: opened(second), ops: add })).toThrow(/turned off/);
    expect(zoomsOf(named(third, 'manifest_edit').run({ manifestId: opened(third), ops: add }))).toHaveLength(1);

    expect(zoomsOf(named(first, 'manifest_inspect').run({ manifest: withZoom() }))).toHaveLength(1);
    expect(() => named(second, 'manifest_inspect').run({ manifest: withZoom() })).toThrow(/turned off/);
    expect(zoomsOf(named(third, 'manifest_inspect').run({ manifest: withZoom() }))).toHaveLength(1);

    for (const name of ZOOM_OPS) {
      expect(catalogOps(first).content[0]?.text).toContain(name);
      expect(catalogOps(second).content[0]?.text).not.toContain(name);
      expect(catalogOps(third).content[0]?.text).toContain(name);
    }
  });

  /*
   * The README tells a host to pass on the setting it already has. That is only true while the
   * editor's own type, with its other fields, is accepted as it is - held in a variable, or written
   * out in place, where TypeScript checks an object literal for properties the type does not have -
   * and `npm run typecheck` compiles this file through `tsconfig.mcp-tests.json` to check exactly
   * that. At run time the other fields are read the same way: not at all.
   */
  it('takes the editor’s own editing object as it is, in a variable or written out in place', () => {
    const hostEditing: EditorEditingOptions = { replaceKeepsLength: false, pictures: true, zoom: false };
    for (const tools of [
      createTools({ editing: hostEditing }),
      createTools({ editing: { pictures: true, zoom: false } }),
      createTools({ editing: { replaceKeepsLength: true, pictures: false, zoom: false } }),
    ]) {
      expect(() => named(tools, 'manifest_edit').run({ manifestId: opened(tools), ops: [{ op: 'addZoom', id: 'z', startMs: 1000 }] })).toThrow(
        /turned off/,
      );
      expect(() => named(tools, 'manifest_inspect').run({ manifest: withZoom() })).toThrow(/turned off/);
    }
    // With Zoom left on, the other fields change nothing either.
    const on = createTools({ editing: { pictures: true, replaceKeepsLength: false } });
    expect(zoomsOf(named(on, 'manifest_inspect').run({ manifest: withZoom() }))).toHaveLength(1);
  });

  /*
   * An agent reads the op list once, at tools/list. Changing the object afterwards must not leave it
   * held to a different rule from the one it was given, in either direction.
   */
  it('settles the setting when the tools are built', () => {
    const editing = { zoom: true };
    const tools = createTools({ editing });
    editing.zoom = false;
    expect(named(tools, 'manifest_edit').description).toContain('addZoom');
    const result = named(tools, 'manifest_edit').run({ manifestId: opened(tools), ops: [{ op: 'addZoom', id: 'z', startMs: 1000 }] });
    expect(zoomsOf(result)).toHaveLength(1);
    expect(zoomsOf(named(tools, 'manifest_inspect').run({ manifest: withZoom() }))).toHaveLength(1);

    const later = { zoom: false };
    const strict = createTools({ editing: later });
    later.zoom = true;
    expect(() => named(strict, 'manifest_inspect').run({ manifest: withZoom() })).toThrow(/turned off/);
  });
});

/*
 * Zoom on, which every app is unless it says otherwise, and which is how every app ran before the
 * setting existed. None of the above may reach it: a manifest's zooms go through every tool exactly
 * as they did, and every zoom op and limit is still offered.
 */
describe('an app that leaves Zoom on', () => {
  function named(tools: ToolDefinition[], name: string): ToolDefinition {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  }

  /** Two zooms, with every field off its default, so "unchanged" has something to be unchanged. */
  function withZooms(): EditManifest {
    return normaliseManifest(
      applyEditOps({ ...emptyManifest(), clips: [defaultClipEdit('v', 10_000)] }, [
        { op: 'addZoom', id: 'z', startMs: 1000, endMs: 3000, cx: 0.7, cy: 0.4, scale: 3, rampMs: 150, ease: 'snappy' },
        { op: 'addZoom', id: 'y', startMs: 3500, endMs: 6000, scale: 1.5, ease: 'steady' },
      ]),
    );
  }

  const manifestOf = (result: { structuredContent?: Record<string, unknown> }) =>
    (result.structuredContent as { manifest: EditManifest }).manifest;

  it('passes a manifest with zooms through every tool unchanged', () => {
    for (const tools of [createTools(), createTools({ editing: { zoom: true } }), createTools({ editing: { pictures: true } })]) {
      const input = withZooms();
      const inspected = named(tools, 'manifest_inspect').run({ manifest: input });
      expect(manifestOf(inspected)).toEqual(input);

      const validated = named(tools, 'manifest_validate').run({ manifest: JSON.parse(JSON.stringify(input)) });
      expect(manifestOf(validated)).toEqual(input);
      expect(validated.content[0]?.text).toMatch(/Nothing had to change/);

      const edited = named(tools, 'manifest_edit').run({ manifest: input, ops: [{ op: 'setClipMuted', clipId: 'v', muted: true }] });
      expect(manifestOf(edited).zooms).toEqual(input.zooms);
      expect(manifestOf(edited)).toEqual({ ...input, clips: [{ ...input.clips[0], muted: true }] });

      // And by id, as stored.
      const id = (edited.structuredContent as { manifestId: string }).manifestId;
      expect(manifestOf(named(tools, 'manifest_inspect').run({ manifestId: id })).zooms).toEqual(input.zooms);
    }
  });

  it('still takes every zoom op, on a zoom a manifest brought in', () => {
    const edit = named(createTools(), 'manifest_edit');
    const next = manifestOf(
      edit.run({
        manifest: withZooms(),
        ops: [
          { op: 'updateZoom', id: 'z', scale: 2 },
          { op: 'setZoomWindow', id: 'y', startMs: 4000, endMs: 6000 },
          { op: 'duplicateZoom', id: 'y', newId: 'x' },
          { op: 'deleteZoom', id: 'z' },
          { op: 'addZoom', id: 'w', startMs: 500, endMs: 1500 },
        ],
      }),
    );
    expect(next.zooms.map((zoom) => [zoom.id, zoom.startMs, zoom.endMs])).toEqual([
      ['w', 500, 1500],
      ['y', 4000, 6000],
      ['x', 6000, 8000],
    ]);
  });

  it('offers every zoom op and every zoom limit, and says nothing about Zoom being off', () => {
    const tools = createTools();
    const edit = named(tools, 'manifest_edit');
    const schema = edit.inputSchema as { properties: { ops: { items: { properties: { op: { enum: string[] } } } } } };
    expect(schema.properties.ops.items.properties.op.enum).toEqual([...OP_NAMES]);
    const catalog = named(tools, 'catalog_list').run({});
    expect(Object.keys((catalog.structuredContent as { ops: Record<string, string> }).ops).sort()).toEqual([...OP_NAMES]);
    expect((catalog.structuredContent as { limits: Record<string, unknown> }).limits).toMatchObject({
      maxZooms: expect.any(Number),
      minZoomMs: MIN_ZOOM_MS,
    });
    const everything = [edit.description, JSON.stringify(tools.map((t) => t.inputSchema)), catalog.content[0]?.text].join('\n');
    expect(everything).not.toMatch(/turned off/);
  });
});

/*
 * A host that runs the server in its own process holds the very object an answer carries - it
 * calls `run` itself, or goes through an SDK client on InMemoryTransport, which hands objects
 * across as they are (`server.unit.test.ts` pins that end). What it does to that object is its own
 * business and must not reach the post stored under the answer's id. With Zoom off it used to be a
 * way to put a zoom in the store behind the door, found a call later only as an internal error.
 */
describe('what a tool answers with, and what it was handed', () => {
  const off = { editing: { zoom: false } };

  function named(tools: ToolDefinition[], name: string): ToolDefinition {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  }

  type Answer = { manifestId: string; manifest: EditManifest };
  const answer = (result: { structuredContent?: Record<string, unknown> }) => result.structuredContent as Answer;

  /**
   * Zoom on, the post has zooms for a host to change; off, it has none, and gaining one is the
   * point.
   */
  function source(zoom: boolean): EditManifest {
    const post: EditManifest = { ...emptyManifest(), clips: [defaultClipEdit('v', 10_000)] };
    if (!zoom) return post;
    return normaliseManifest(applyEditOps(post, [{ op: 'addZoom', id: 'z', startMs: 1000, endMs: 3000, scale: 3 }]));
  }

  /**
   * Whatever a host might do to a manifest it holds, and first the zoom the door is there to keep
   * out.
   */
  function vandalise(manifest: EditManifest): void {
    for (const zoom of manifest.zooms) zoom.scale = 4;
    manifest.zooms.push({ id: 'sneaked', startMs: 5000, endMs: 7000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 300, ease: 'smooth' });
    manifest.clips[0]!.speed = 3;
    manifest.clips.push(defaultClipEdit('x', 1000));
    manifest.output.width = 16;
    manifest.adjust.brightness = 1;
  }

  /*
   * Every way a tool answers with a manifest, each from a set of tools of its own. The ones by id
   * open their post with manifest_validate first, so with Zoom on it is the one with zooms.
   */
  function calls(zoom: boolean): [string, (tools: ToolDefinition[]) => ToolResult][] {
    const idOf = (tools: ToolDefinition[]) => answer(named(tools, 'manifest_validate').run({ manifest: source(zoom) })).manifestId;
    const ops = [{ op: 'setClipMuted', clipId: 'v', muted: true }];
    return [
      ['manifest_create', (tools) => named(tools, 'manifest_create').run({ sources: [{ clipKey: 'v', durationMs: 10_000 }] })],
      ['manifest_validate', (tools) => named(tools, 'manifest_validate').run({ manifest: source(zoom) })],
      ['manifest_inspect, handed a manifest', (tools) => named(tools, 'manifest_inspect').run({ manifest: source(zoom) })],
      ['manifest_inspect, by id', (tools) => named(tools, 'manifest_inspect').run({ manifestId: idOf(tools) })],
      ['manifest_edit, handed a manifest', (tools) => named(tools, 'manifest_edit').run({ manifest: source(zoom), ops })],
      ['manifest_edit, by id', (tools) => named(tools, 'manifest_edit').run({ manifestId: idOf(tools), ops })],
    ];
  }

  /* The list above has to be every tool that answers with a manifest, or a new one goes untested. */
  it('covers every tool that answers with a manifest', () => {
    const covered = new Set(calls(true).map(([label]) => label.split(',')[0]));
    const answering = createTools()
      .filter((definition) => definition.name !== 'catalog_list')
      .map((definition) => definition.name);
    expect([...covered].sort()).toEqual(answering.sort());
    // And catalog_list, the one left out, answers with no manifest at all.
    expect(named(createTools(), 'catalog_list').run({}).structuredContent).not.toHaveProperty('manifest');
  });

  for (const [setting, options, zoom] of [
    ['Zoom on', {}, true],
    ['Zoom off', off, false],
  ] as const) {
    it(`leaves the stored post alone when the answer is changed, with ${setting}`, () => {
      for (const [label, call] of calls(zoom)) {
        const tools = createTools(options);
        const { manifestId, manifest } = answer(call(tools));
        const stored = JSON.stringify(manifest);
        vandalise(manifest);

        // Read back by id, twice over: the second answer is changed as well before the third read.
        const again = answer(named(tools, 'manifest_inspect').run({ manifestId }));
        expect(JSON.stringify(again.manifest), label).toBe(stored);
        vandalise(again.manifest);
        expect(JSON.stringify(answer(named(tools, 'manifest_inspect').run({ manifestId })).manifest), label).toBe(stored);

        // And edited on by id, which with Zoom off is where a zoom left in the store would have
        // failed the call as an internal error.
        const edited = answer(named(tools, 'manifest_edit').run({ manifestId, ops: [{ op: 'setClipVolume', clipId: 'v', volume: 0.5 }] }));
        expect(edited.manifest.zooms, label).toEqual((JSON.parse(stored) as EditManifest).zooms);
        if (!zoom) expect(edited.manifest.zooms, label).toEqual([]);
        expect(edited.manifest.clips.map((clip) => [clip.id, clip.speed]), label).toEqual([['v', 1]]);
      }
    });

    /*
     * The other direction, and why the store copies on the way in: an op's patch is spread onto the
     * post as it was handed over, so the manifest a call builds can hold the caller's own objects.
     */
    it(`keeps no hold on what a call was handed, with ${setting}`, () => {
      const tools = createTools(options);
      const draft = source(zoom);
      const meta = { by: 'agent' };
      const { manifestId } = answer(
        named(tools, 'manifest_edit').run({
          manifest: draft,
          ops: [
            { op: 'addText', id: 't', text: 'Hi' },
            { op: 'patchOverlay', id: 't', patch: { opacity: 0.5, meta } },
          ],
        }),
      );
      const stored = JSON.stringify(answer(named(tools, 'manifest_inspect').run({ manifestId })).manifest);

      meta.by = 'someone else';
      vandalise(draft);

      expect(JSON.stringify(answer(named(tools, 'manifest_inspect').run({ manifestId })).manifest)).toBe(stored);
      expect(stored).toContain('"meta":{"by":"agent"}');
    });
  }
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

  /* Every tool answer's text, from a set of tools with these settings, for a post with no zoom. */
  function answers(editing?: EditorEditingOptions): string[] {
    const tools = createTools({ editing });
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((candidate) => candidate.name === name)!.run(args).content[0]?.text ?? '';
    return [
      run('manifest_create', { sources: [{ clipKey: 'v', durationMs: 10_000 }] }),
      run('manifest_validate', { manifest: threeClips() }),
      run('manifest_inspect', { manifest: threeClips() }),
      run('manifest_inspect', { manifestId: 'm1' }),
      run('manifest_edit', { manifest: threeClips(), ops: [{ op: 'setClipMuted', clipId: 'a', muted: true }] }),
    ];
  }

  /* With Zoom on the zoom section is what it always was, whether the setting is left out or said. */
  it('keeps "Zooms: none" exactly where it was with Zoom on', () => {
    const manifest = threeClips();
    const summary = summariseManifest(manifest);
    expect(summary).toMatch(/\nVoiceover: none\n\nZooms: none\n\nLook: /);
    for (const editing of [undefined, {}, { zoom: true }, { pictures: true, zoom: true }]) {
      expect(summariseManifest(manifest, { editing })).toBe(summary);
    }
    for (const text of [...answers(), ...answers({ zoom: true })]) expect(text).toContain('\n\nZooms: none\n\n');
  });

  /*
   * With Zoom off the line goes, gap and all, as the zoom limits go from the catalogue: no post on
   * such a server has a zoom, so it would say the same thing on every answer. Nothing else moves.
   */
  it('says nothing about zooms with Zoom off, and changes nothing else', () => {
    const manifest = threeClips();
    const summary = summariseManifest(manifest, { editing: { zoom: false } });
    expect(summary).not.toMatch(/zoom/i);
    expect(summary).toBe(summariseManifest(manifest).replace('\n\nZooms: none', ''));
    expect(summary).toMatch(/\nVoiceover: none\n\nLook: /);
    for (const text of answers({ zoom: false })) expect(text).not.toMatch(/zoom/i);
  });

  /*
   * Only a host calling it directly can hand it one with Zoom off, and a summary never hides part
   * of a post.
   */
  it('still lists a zoom the manifest holds, whatever the setting', () => {
    const withZoom = applyEditOps(threeClips(), [{ op: 'addZoom', id: 'z', startMs: 1000, endMs: 3000 }]);
    const summary = summariseManifest(withZoom, { editing: { zoom: false } });
    expect(summary).toContain('\n\nZooms: 1 zoom\n  "z" ');
    expect(summary).toBe(summariseManifest(withZoom));
  });
});
