import { describe, expect, it } from 'vitest';

import { MIN_STORED_ZOOM_MS, defaultClipEdit, emptyManifest, normaliseManifest, type EditManifest } from '../editor/edit-manifest';
import * as entry from './index';
import { ToolError, applyEditOps, createTools, refuseZooms, type EditOp } from './index';

/*
 * The door a host has to add for itself. With Zoom off, `applyEditOps` refuses the five zoom ops
 * and nothing more - a zoom already in the manifest it is handed comes back where it was - because
 * the door that refuses such a manifest is in the server's tools. A host that builds a tool of its
 * own on `applyEditOps` therefore adds the door itself, and these pin that the door it adds is the
 * tools' own, reached from `capacitor-video-kit/mcp`, refusing what they refuse in their words.
 *
 * Imported through `index.ts`, the entry point a host imports, rather than `tools.ts`, so that an
 * export dropped from the entry point fails here rather than in a host's build.
 */

const off = { editing: { zoom: false } };
const post = (): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('v', 10_000)] });
/** A draft saved where Zoom was on, as a host would have it on disk. */
const draft = (): EditManifest => applyEditOps(post(), [{ op: 'addZoom', id: 'z', startMs: 1000, endMs: 3000 }]);
const muted: EditOp[] = [{ op: 'setClipMuted', clipId: 'v', muted: true }];

/** A host's own edit tool, written the way the README's "A tool of your own" tells it to. */
function hostEdit(raw: unknown, ops: EditOp[]): EditManifest {
  const manifest = normaliseManifest(raw);
  refuseZooms(manifest);
  return applyEditOps(manifest, ops, off);
}

function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('nothing was thrown');
}

describe('refuseZooms, for a host with a tool of its own', () => {
  it('is exported from capacitor-video-kit/mcp', () => {
    expect(typeof entry.refuseZooms).toBe('function');
    expect(entry.refuseZooms).toBe(refuseZooms);
  });

  /* Why a host needs it at all: the ops' setting alone lets a draft's zoom through. */
  it('is needed: applyEditOps with Zoom off carries a zoom it is handed straight through', () => {
    expect(applyEditOps(draft(), muted, off).zooms.map((zoom) => zoom.id)).toEqual(['z']);
    expect(() => hostEdit(draft(), muted)).toThrow(ToolError);
  });

  it('refuses what the server’s tools refuse, with the same error in the same words', () => {
    const edit = createTools(off).find((tool) => tool.name === 'manifest_edit')!;
    const two = applyEditOps(draft(), [{ op: 'addZoom', id: 'y', startMs: 5000, endMs: 7000 }]);
    const shapes: [string, unknown][] = [
      ['a draft with one zoom', draft()],
      ['a draft with two', two],
      ['a zoom with only its window, no id', { ...post(), zooms: [{ startMs: 1000, endMs: 3000 }] }],
      ['a zoom among junk the normaliser drops', { ...post(), zooms: [null, 'z', { id: 'z', startMs: 1000, endMs: 3000 }] }],
      ['an old version', { ...post(), version: 1, zooms: [{ id: 'z', startMs: 1000, endMs: 3000 }] }],
    ];
    for (const [label, manifest] of shapes) {
      const server = thrown(() => edit.run({ manifest, ops: muted }));
      const host = thrown(() => hostEdit(manifest, muted));
      expect(host, label).toBeInstanceOf(ToolError);
      expect(host.message, label).toBe(server.message);
      expect(host.message, label).toMatch(/^Zoom is turned off for this app, and this manifest holds/);
    }
  });

  it('lets through what the tools let through, however "zooms" is spelled', () => {
    const { zooms: _dropped, ...noField } = post();
    for (const manifest of [
      noField,
      { ...post(), zooms: [] },
      { ...post(), zooms: null },
      { ...post(), zooms: {} },
      { ...post(), zooms: [null, 7, {}, { id: 'a', startMs: 1000, endMs: 1000 + MIN_STORED_ZOOM_MS - 1 }] },
    ]) {
      expect(hostEdit(manifest, muted).clips[0]?.muted).toBe(true);
    }
  });

  /*
   * Handed a manifest that was never normalised it can refuse more than the tools would, never
   * less: whatever the normaliser would keep as a zoom is in a non-empty list, and that is refused.
   */
  it('errs toward refusing a manifest that was never normalised, and never crashes on one', () => {
    const junk = { ...post(), zooms: [{ startMs: 'x' }, null] } as unknown as EditManifest;
    expect(normaliseManifest(junk).zooms).toEqual([]);
    expect(() => refuseZooms(junk)).toThrow(/holds 2 zooms \(one with no id, one with no id\)/);

    for (const zooms of [undefined, null, {}, 'z', 7, []]) {
      const raw = { ...post(), zooms } as unknown as EditManifest;
      expect(normaliseManifest(raw).zooms).toEqual([]);
      expect(() => refuseZooms(raw), String(zooms)).not.toThrow();
    }
    for (const nothing of [undefined, null]) expect(() => refuseZooms(nothing as unknown as EditManifest)).not.toThrow();
  });
});
