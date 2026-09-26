import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditManifest, type EditZoom } from '../editor/edit-manifest';
import { applyEditOps, EditOpError } from './ops';
import { createTools, ToolError, type ToolDefinition } from './tools';

/*
 * The two checks that back the Zoom-off rule up, made to fire.
 *
 * Neither can fire through the real code: the door refuses a manifest that holds a zoom, the ops
 * that make one are refused, and no other op touches `zooms` (`zoom-ops.unit.test.ts` runs every
 * one of them to show it). So this file breaks the editor underneath, the way a later change might -
 * an editor function that, told to, copies a zoom in along with its real work - and checks that the
 * break is caught and called a bug rather than handed to the agent or quietly undone.
 *
 * A file of its own because `vi.mock` replaces the module for everything the file imports, and the
 * other tests must run against the real editor.
 */

const sabotage = vi.hoisted(() => ({ on: false }));

const SNEAKED: EditZoom = { id: 'sneaked', startMs: 1000, endMs: 3000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 300, ease: 'smooth' };

vi.mock('../editor/edit-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../editor/edit-ops')>();
  const withSneaked = (manifest: EditManifest): EditManifest =>
    sabotage.on ? { ...manifest, zooms: [...manifest.zooms, SNEAKED] } : manifest;
  return {
    ...actual,
    // What `manifest_edit` reaches through the op of the same name.
    setClipSpeed: (...args: Parameters<typeof actual.setClipSpeed>) => withSneaked(actual.setClipSpeed(...args)),
    // What `manifest_create` lays its sources down with, which no op-level check stands in front of.
    insertClip: (...args: Parameters<typeof actual.insertClip>) => withSneaked(actual.insertClip(...args)),
  };
});

const off = { editing: { zoom: false } };
const post = (): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('v', 10_000)] });

function named(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

beforeEach(() => {
  sabotage.on = false;
});

describe('an op that puts a zoom in while Zoom is off', () => {
  it('fails the list as a bug, naming the op, rather than returning the zoom', () => {
    sabotage.on = true;
    const before = post();
    const snapshot = JSON.stringify(before);
    let caught: unknown;
    try {
      applyEditOps(before, [{ op: 'setClipMuted', clipId: 'v', muted: true }, { op: 'setClipSpeed', clipId: 'v', speed: 2 }], off);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EditOpError);
    expect((caught as Error).message).toMatch(
      /^op 1 \(setClipSpeed\): this op put a zoom into the post while Zoom is turned off for this app\. That is a bug/,
    );
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('is not checked with Zoom on, where a zoom is an edit like any other', () => {
    sabotage.on = true;
    const next = applyEditOps(post(), [{ op: 'setClipSpeed', clipId: 'v', speed: 2 }]);
    expect(next.zooms.map((zoom) => zoom.id)).toEqual(['sneaked']);
  });

  it('does not fire for a zoom the manifest came in with, which the op carried through untouched', () => {
    const draft = { ...post(), zooms: [SNEAKED] };
    expect(applyEditOps(draft, [{ op: 'setClipMuted', clipId: 'v', muted: true }], off).zooms).toBe(draft.zooms);
  });
});

describe('a tool answer that would hold a zoom while Zoom is off', () => {
  it('fails the call as a bug, and stores nothing', () => {
    sabotage.on = true;
    const tools = createTools(off);
    let caught: unknown;
    try {
      named(tools, 'manifest_create').run({ sources: [{ clipKey: 'v', durationMs: 10_000 }] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as Error).message).toMatch(/^internal error: this answer would hold a zoom while Zoom is turned off/);
    expect((caught as Error).message).toMatch(/bug in capacitor-video-kit.*the manifest was not stored/s);

    sabotage.on = false;
    expect(() => named(tools, 'manifest_inspect').run({ manifestId: 'm1' })).toThrow(/no manifest "m1"/);
  });

  it('refuses through manifest_edit too, where the op-level check gets there first', () => {
    const tools = createTools(off);
    const created = named(tools, 'manifest_create').run({ sources: [{ clipKey: 'v', durationMs: 10_000 }] });
    const id = (created.structuredContent as { manifestId: string }).manifestId;
    sabotage.on = true;
    expect(() => named(tools, 'manifest_edit').run({ manifestId: id, ops: [{ op: 'setClipSpeed', clipId: 'v', speed: 2 }] })).toThrow(
      /op 0 \(setClipSpeed\): this op put a zoom into the post/,
    );
    sabotage.on = false;
    const kept = named(tools, 'manifest_inspect').run({ manifestId: id });
    expect((kept.structuredContent as { manifest: EditManifest }).manifest.zooms).toEqual([]);
  });

  it('is not checked with Zoom on', () => {
    sabotage.on = true;
    const created = named(createTools(), 'manifest_create').run({ sources: [{ clipKey: 'v', durationMs: 10_000 }] });
    expect((created.structuredContent as { manifest: EditManifest }).manifest.zooms.map((zoom) => zoom.id)).toEqual(['sneaked']);
  });
});
