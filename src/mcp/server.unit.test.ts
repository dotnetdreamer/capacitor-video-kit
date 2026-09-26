import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest } from '../editor/edit-manifest';
import { createVideoKitMcpServer, type VideoKitMcpServerOptions } from './server';
import { createTools } from './tools';

/**
 * The one thing `server.ts` adds to the tools on the way to the wire: which tools it builds. The
 * tools' behaviour is pinned in `tools.unit.test.ts` without any of this; what is here is that the
 * `editing` a host hands the server reaches them, seen from the far end of a real client over the
 * SDK's in-memory transport, which is exactly what an agent's client would see.
 */

async function connected(options: VideoKitMcpServerOptions): Promise<Client> {
  const server = createVideoKitMcpServer(options);
  const client = new Client({ name: 'server.unit.test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const post = () => ({ ...emptyManifest(), clips: [defaultClipEdit('v', 10_000)] });
const addZoom = { name: 'manifest_edit', arguments: { manifest: post(), ops: [{ op: 'addZoom', id: 'z', startMs: 1000 }] } };
/* A manifest handed in whole with a zoom already written into it, and an op that is not a zoom op. */
const zoomInJson = {
  name: 'manifest_edit',
  arguments: {
    manifest: { ...post(), zooms: [{ id: 'z', startMs: 1000, endMs: 3000 }] },
    ops: [{ op: 'setClipMuted', clipId: 'v', muted: true }],
  },
};

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((part) => part.text ?? '').join('\n');
}

describe('createVideoKitMcpServer and editing.zoom', () => {
  /*
   * Handed the editing object an app already gives its editor, written out as one would - the
   * editor's other fields beside `zoom` - which has to compile as well as work.
   */
  it('passes Zoom off through to the tools it builds', async () => {
    const client = await connected({ editing: { pictures: false, zoom: false } });

    const { tools } = await client.listTools();
    const edit = tools.find((tool) => tool.name === 'manifest_edit');
    expect(edit?.description).not.toContain('addZoom');
    expect(JSON.stringify(edit?.inputSchema)).not.toContain('duplicateZoom');

    // Answered as a tool error the agent can read, not a failed request.
    const refused = await client.callTool(addZoom);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/op 0 \(addZoom\): zoom is turned off for this app/);
  });

  it('refuses a manifest with a zoom written into it, as a tool error an agent can read', async () => {
    // The editor's object with every field it has, written out in place.
    const client = await connected({ editing: { replaceKeepsLength: true, pictures: true, zoom: false } });
    const refused = await client.callTool(zoomInJson);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Zoom is turned off for this app, and this manifest holds 1 zoom \("z"\)/);
  });

  it('adds zooms as it always has when nothing is said', async () => {
    const client = await connected({});
    const result = await client.callTool(addZoom);
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { manifest: { zooms: { id: string }[] } }).manifest.zooms.map((z) => z.id)).toEqual(['z']);

    const kept = await client.callTool(zoomInJson);
    expect(kept.isError).toBeFalsy();
    expect((kept.structuredContent as { manifest: { zooms: { id: string }[] } }).manifest.zooms.map((z) => z.id)).toEqual(['z']);
  });

  /*
   * InMemoryTransport hands the client the very objects the server answered with, so a client that
   * changes its answer changes whatever the server handed it. That has to be the client's own copy:
   * when it was the stored post, a zoom pushed into an answer with Zoom off sat in the store behind
   * the door, and the next call on that id failed as an internal error.
   */
  it('keeps what a client does to an answer away from the post stored under its id', async () => {
    for (const editing of [{}, { zoom: false }]) {
      const client = await connected({ editing });
      const created = await client.callTool({
        name: 'manifest_create',
        arguments: { sources: [{ clipKey: 'v', durationMs: 10_000 }] },
      });
      const { manifestId, manifest } = created.structuredContent as {
        manifestId: string;
        manifest: { zooms: unknown[]; clips: { speed: number }[] };
      };
      manifest.zooms.push({ id: 'sneaked', startMs: 1000, endMs: 3000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 300, ease: 'smooth' });
      manifest.clips[0]!.speed = 3;

      const later = await client.callTool({
        name: 'manifest_edit',
        arguments: { manifestId, ops: [{ op: 'setClipMuted', clipId: 'v', muted: true }] },
      });
      expect(later.isError, JSON.stringify(editing)).toBeFalsy();
      const stored = (later.structuredContent as { manifest: { zooms: unknown[]; clips: { speed: number }[] } }).manifest;
      expect(stored.zooms, JSON.stringify(editing)).toEqual([]);
      expect(stored.clips[0]?.speed, JSON.stringify(editing)).toBe(1);
    }
  });

  /*
   * Tools the host built were built without it, so taking it anyway would leave a host that believed
   * Zoom was off with agents that could add one.
   */
  it('refuses "editing" beside tools of the host’s own, rather than quietly ignoring it', () => {
    expect(() => createVideoKitMcpServer({ tools: createTools(), editing: { zoom: false } })).toThrow(/createTools\(\)/);
    expect(() => createVideoKitMcpServer({ tools: createTools({ editing: { zoom: false } }) })).not.toThrow();
  });
});
