import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComposeResult, ComposeSpec, FindSubjectsOptions, FindSubjectsResult } from './definitions';

/* The platform and the plugin, stood in for as `render-host.unit.test.ts` does, with the calls a render with a matte makes. */
const bridge = vi.hoisted(() => ({
  native: false,
  listeners: new Map<string, Set<(event: unknown) => void>>(),
  compose: vi.fn<(spec: ComposeSpec) => Promise<{ jobId: string }>>(),
  capabilities: vi.fn<() => Promise<{ supported: boolean; features?: unknown }>>(),
  findSubjects: vi.fn<(options: FindSubjectsOptions) => Promise<FindSubjectsResult>>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => bridge.native },
  registerPlugin: () => ({
    addListener: async (name: string, listener: (event: unknown) => void) => {
      const listeners = bridge.listeners.get(name) ?? new Set();
      listeners.add(listener);
      bridge.listeners.set(name, listeners);
      return { remove: async () => void listeners.delete(listener) };
    },
    compose: bridge.compose,
    cancel: async () => undefined,
    capabilities: bridge.capabilities,
    findSubjects: bridge.findSubjects,
    stageRenderInput: async ({ uri }: { uri?: string }) => ({ uri: uri ?? 'file:///tmp/videokit-render-inputs/1' }),
    releaseRenderInputs: async () => undefined,
  }),
  WebPlugin: class {},
}));

import { encodeSubjectTrack, reconcileManifest, type EditManifest, type RasterContext, type StickerOverlay } from '../editor';
import type { EditorSource, RenderRequest } from '../host/host.types';

import { composerRenderHost } from './render-host';

const RESULT: Omit<ComposeResult, 'jobId'> = { uri: 'file:///out.mp4', posterUri: 'file:///poster.jpg', durationMs: 2000, width: 720, height: 1280, bytes: 1 };

const CLIP: EditorSource = { key: 'a', fileName: 'a.mp4', sourcePath: 'file:///clips/a.mp4' };

const sticker: StickerOverlay = { id: 'k', kind: 'sticker', emoji: null, assetId: 'heart', cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 1500, behind: true };

/** Somebody in the middle of a 9:16 source, at five frames over two seconds. */
const PEOPLE = encodeSubjectTrack({
  width: 180,
  height: 320,
  times: [0, 500, 1000, 1500, 2000],
  frames: [0, 1, 2, 3, 4].map(() => {
    const cells = new Uint8Array(180 * 320);
    for (let y = 100; y < 300; y++) cells.fill(1, y * 180 + 60, y * 180 + 120);
    return cells;
  }),
  meta: { engine: 'mlkit', kind: 'video', durationMs: 2000, fps: 2, subjects: [] },
});

function found(subjects: number): FindSubjectsResult {
  return {
    engine: 'mlkit',
    uri: 'blob:app/people-a',
    cached: true,
    kind: 'video',
    width: 180,
    height: 320,
    frames: 5,
    durationMs: 2000,
    subjects: Array.from({ length: subjects }, (_, i) => ({ id: i + 1, kind: 'person' as const, startMs: 0, endMs: 2000, peakMs: 0, box: { x: 0.3, y: 0.3, w: 0.3, h: 0.6 }, area: 0.2 })),
  };
}

function request(overlays: EditManifest['overlays'] = [sticker]): RenderRequest {
  const plain = reconcileManifest(undefined, ['a'], new Map([['a', 2000]]));
  const manifest: EditManifest = { ...plain, output: { width: 720, height: 1280, fps: 30 }, overlays };
  const raster = { output: manifest.output, textStyle: () => ({}), stickerUrl: (id: string) => id, fileUrl: (u: string) => u, drawn: () => ({ png: 'data:image/png;base64,x', wPx: 100, hPx: 100 }) } as unknown as RasterContext;
  return { manifest, sources: [CLIP], onProgress: vi.fn(), signal: new AbortController().signal, raster };
}

function host(log = vi.fn()) {
  return composerRenderHost({ ids: () => ({ jobId: 'job-1', batchId: 'edit-1' }), log });
}

const composed = (): ComposeSpec => bridge.compose.mock.calls[0]![0];

let revokedAtCompose = -1;

beforeEach(() => {
  bridge.native = false;
  bridge.listeners.clear();
  bridge.capabilities.mockReset();
  bridge.findSubjects.mockReset().mockResolvedValue(found(1));
  bridge.compose.mockReset().mockImplementation(async spec => {
    revokedAtCompose = vi.mocked(URL.revokeObjectURL).mock.calls.length;
    queueMicrotask(() => {
      for (const listener of bridge.listeners.get('completed') ?? []) listener({ ...RESULT, jobId: spec.jobId });
    });
    return { jobId: spec.jobId };
  });
  vi.stubGlobal('fetch', vi.fn(async (uri: string) => (uri === 'blob:app/people-a' ? { ok: true, status: 200, blob: async () => new Blob([PEOPLE as BlobPart]) } : { ok: false, status: 404, blob: async () => new Blob() })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:app/matte');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('composerRenderHost: the people behind a layer', () => {
  it('finds the people under the layer, sends their matte as a blob, and lets go of it once the job has settled', async () => {
    await host().render(request());
    expect(bridge.findSubjects).toHaveBeenCalledWith({ uri: CLIP.sourcePath });
    const spec = composed();
    expect(spec.overlays[0]!.behind).toBe(true);
    expect(spec.matte).toEqual({ uri: 'blob:app/matte', atMs: [0], subjects: [{ id: 1, focus: [1] }] });
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('VKST');
    // The output frame's grid, not the source's.
    expect(new DataView(bytes.buffer).getUint16(6, true)).toBe(180);
    expect(revokedAtCompose).toBe(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:app/matte');
  });

  it('asks nothing and sends no matte for a post with nobody behind', async () => {
    await host().render(request([{ ...sticker, behind: undefined }]));
    expect(bridge.findSubjects).not.toHaveBeenCalled();
    expect('matte' in composed()).toBe(false);
  });

  it('sends no matte where nobody was found, or the people cannot be had, and logs why', async () => {
    bridge.findSubjects.mockResolvedValue(found(0));
    await host().render(request());
    expect('matte' in composed()).toBe(false);
    expect(composed().overlays[0]!.behind).toBe(true);

    bridge.compose.mockClear();
    const failure = new Error('no segmenter');
    bridge.findSubjects.mockRejectedValue(failure);
    const log = vi.fn();
    await host(log).render(request([{ ...sticker, id: 'k2' }]));
    expect('matte' in composed()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no people for a clip behind a layer'), failure);
  });

  it('looks for nobody on a phone whose render cannot draw a matte', async () => {
    bridge.native = true;
    bridge.capabilities.mockResolvedValue({ supported: true, features: ['overlayQuad'] });
    await host().render(request());
    expect(bridge.findSubjects).not.toHaveBeenCalled();
    expect('matte' in composed()).toBe(false);
  });
});
