import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComposeError, ComposeResult, ComposeSpec, EncodeSupport, StageRenderInputOptions } from './definitions';

/*
 * The platform and the plugin, stood in for, as `render-inputs.unit.test.ts` does and for its
 * reasons: one platform to answer with, and every composer call a render host makes. Listeners are
 * kept by event name, so a test can see which were on when `compose` was called and that every one
 * came off again, and can speak for the composer by emitting to them.
 */
type Listener = (event: unknown) => void;

const bridge = vi.hoisted(() => ({
  native: false,
  listeners: new Map<string, Set<(event: unknown) => void>>(),
  addListener: vi.fn<(name: string, listener: (event: unknown) => void) => Promise<{ remove(): Promise<void> }>>(),
  compose: vi.fn<(spec: ComposeSpec) => Promise<{ jobId: string }>>(),
  cancel: vi.fn<(options: { jobId: string }) => Promise<void>>(),
  capabilities: vi.fn<() => Promise<{ supported: boolean }>>(),
  encodeSupport: vi.fn<(options: { frames: { width: number; height: number; fps: number }[] }) => Promise<{ frames: EncodeSupport[] }>>(),
  cleanup: vi.fn<(options: { batchId: string }) => Promise<void>>(),
  stageRenderInput: vi.fn<(options: StageRenderInputOptions) => Promise<{ uri: string }>>(),
  releaseRenderInputs: vi.fn<(options: { uris: string[] }) => Promise<void>>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => bridge.native },
  registerPlugin: () => ({
    addListener: bridge.addListener,
    compose: bridge.compose,
    cancel: bridge.cancel,
    capabilities: bridge.capabilities,
    encodeSupport: bridge.encodeSupport,
    cleanup: bridge.cleanup,
    stageRenderInput: bridge.stageRenderInput,
    releaseRenderInputs: bridge.releaseRenderInputs,
  }),
  WebPlugin: class {},
}));

/* The real helper, watched: whether it stages is its own suite's to test, that every render goes through it is this one's. */
vi.mock('./render-inputs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./render-inputs')>();
  return { ...actual, withNativeRenderInputs: vi.fn(actual.withNativeRenderInputs) };
});

import { reconcileManifest, type EditManifest, type RasterContext } from '../editor';
import { setEditorDebug } from '../host/debug';
import { RenderFailedError, type EditorSource, type RenderRequest } from '../host/host.types';

import { composerRenderHost, containerOf, readRenderFile, type ComposerRenderHostOptions } from './render-host';
import { withNativeRenderInputs } from './render-inputs';

/** What the composer reports for a finished job, less the job id each test's job supplies. */
const RESULT: Omit<ComposeResult, 'jobId'> = {
  uri: 'file:///app/video-batches/edit-1/stitched.mp4',
  posterUri: 'file:///app/video-batches/edit-1/poster.jpg',
  durationMs: 2000,
  width: 720,
  height: 1280,
  bytes: 1_000_000,
};

function emit(name: 'progress' | 'completed' | 'failed', event: unknown): void {
  for (const listener of [...(bridge.listeners.get(name) ?? [])]) listener(event);
}

/** The composer finishing whatever job it is handed, a moment after `compose` answers. */
function finishing(result: Partial<ComposeResult> = {}): void {
  bridge.compose.mockImplementation(async (spec) => {
    queueMicrotask(() => emit('completed', { ...RESULT, ...result, jobId: spec.jobId }));
    return { jobId: spec.jobId };
  });
}

/** The composer failing whatever job it is handed, the same way. */
function failing(error: Partial<ComposeError>): void {
  bridge.compose.mockImplementation(async (spec) => {
    queueMicrotask(() => emit('failed', { code: 'unknown', message: 'it broke', ...error, jobId: spec.jobId }));
    return { jobId: spec.jobId };
  });
}

/** Every microtask and timer callback queued so far, run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A context that draws nothing: none of these manifests has a layer to draw. */
function raster(manifest: EditManifest): RasterContext {
  return {
    output: manifest.output,
    textStyle: () => {
      throw new Error('nothing here has text');
    },
    stickerUrl: (id) => id,
    fileUrl: (uri) => uri,
  };
}

const CLIP: EditorSource = { key: 'a', fileName: 'a.mp4', sourcePath: 'file:///clips/a.mp4' };

/** One render of `sources`, each two seconds long, through the host under test. */
function request(overrides: Partial<RenderRequest> = {}, sources: EditorSource[] = [CLIP]): RenderRequest {
  const manifest =
    overrides.manifest ??
    reconcileManifest(undefined, sources.map((source) => source.key), new Map(sources.map((source) => [source.key, 2000])));
  return {
    manifest,
    sources,
    onProgress: vi.fn(),
    signal: new AbortController().signal,
    raster: raster(manifest),
    ...overrides,
  };
}

/** A host whose ids are known in advance, `job-1`/`edit-1` then `job-2`/`edit-2`. */
function host(options: ComposerRenderHostOptions = {}) {
  let renders = 0;
  return composerRenderHost({
    ids: () => ({ jobId: `job-${++renders}`, batchId: `edit-${renders}` }),
    log: vi.fn(),
    ...options,
  });
}

/** The spec the composer was handed. */
const composed = (): ComposeSpec => bridge.compose.mock.calls[0]![0];

beforeEach(() => {
  bridge.native = false;
  bridge.listeners.clear();
  bridge.addListener.mockReset().mockImplementation(async (name, listener) => {
    const listeners = bridge.listeners.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    bridge.listeners.set(name, listeners);
    return { remove: async () => void listeners.delete(listener) };
  });
  bridge.compose.mockReset();
  bridge.cancel.mockReset().mockResolvedValue();
  bridge.capabilities.mockReset();
  bridge.encodeSupport.mockReset();
  bridge.cleanup.mockReset().mockResolvedValue();
  bridge.stageRenderInput.mockReset();
  bridge.releaseRenderInputs.mockReset().mockResolvedValue();
  vi.mocked(withNativeRenderInputs).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setEditorDebug(false);
});

/** Nothing left listening once a render has settled, whichever way it settled. */
function listening(): number {
  return [...bridge.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
}

describe('composerRenderHost: the job', () => {
  it('has all three listeners on before it starts the job, and takes them off after', async () => {
    let onAtCompose: string[] = [];
    bridge.compose.mockImplementation(async (spec) => {
      onAtCompose = [...bridge.listeners].filter(([, listeners]) => listeners.size > 0).map(([name]) => name);
      // Finished before `compose` has even answered, which is what a two second clip can do.
      emit('completed', { ...RESULT, jobId: spec.jobId });
      return { jobId: spec.jobId };
    });

    await expect(host().render(request())).resolves.toMatchObject({ sourcePath: RESULT.uri });
    expect(onAtCompose.sort()).toEqual(['completed', 'failed', 'progress']);
    expect(listening()).toBe(0);
  });

  it('reports its own job\'s progress and settles on its own job\'s end, ignoring another job\'s', async () => {
    bridge.compose.mockImplementation(async (spec) => {
      queueMicrotask(() => {
        emit('progress', { jobId: 'someone-else', progress: 0.9 });
        emit('progress', { jobId: spec.jobId, progress: 0.4 });
        emit('failed', { jobId: 'someone-else', code: 'encoder', message: 'not ours' });
        emit('completed', { ...RESULT, jobId: 'someone-else', uri: 'file:///not-ours.mp4' });
        emit('progress', { jobId: spec.jobId, progress: 0.8 });
        emit('completed', { ...RESULT, jobId: spec.jobId });
      });
      return { jobId: spec.jobId };
    });
    const render = request();

    await expect(host().render(render)).resolves.toMatchObject({ sourcePath: RESULT.uri });
    expect(vi.mocked(render.onProgress).mock.calls).toEqual([[0.4], [0.8]]);
  });

  it('answers the finished file as a source the editor can hand back', async () => {
    finishing();
    expect(await host().render(request())).toEqual({
      key: 'edited-job-1',
      fileName: 'edited.mp4',
      sourcePath: RESULT.uri,
      thumbnailUrl: RESULT.posterUri,
    });
  });

  it('leaves the thumbnail out when no poster could be cut', async () => {
    finishing({ posterUri: '' });
    expect(await host().render(request())).not.toHaveProperty('thumbnailUrl');
  });

  /* A browser without an MP4 encoder renders WebM, and its file is a `blob:` URL with no extension. */
  it('names the web engine\'s WebM for what it is, from the blob\'s own type', async () => {
    const fetchRender = vi.fn(async () => ({ headers: { get: () => 'video/webm' }, body: null }));
    vi.stubGlobal('fetch', fetchRender);
    finishing({ uri: 'blob:http://localhost/9b1c', posterUri: '' });

    expect(await host().render(request())).toMatchObject({ fileName: 'edited.webm', sourcePath: 'blob:http://localhost/9b1c' });
    expect(fetchRender).toHaveBeenCalledWith('blob:http://localhost/9b1c');
  });

  it('hands the result to the host\'s toSource, with the job, the folder and the manifest', async () => {
    finishing();
    const mine: EditorSource = { key: 'post', fileName: 'post.mp4', sourcePath: RESULT.uri };
    const toSource = vi.fn(async () => mine);
    const render = request();

    expect(await host({ toSource }).render(render)).toBe(mine);
    expect(toSource).toHaveBeenCalledWith(
      { ...RESULT, jobId: 'job-1' },
      { jobId: 'job-1', batchId: 'edit-1', manifest: render.manifest },
    );
  });

  it('passes the host\'s size ceiling to the spec, and writes none when there is none', async () => {
    finishing();
    await host().render(request({ maxBytes: 100_000_000 }));
    expect(composed().output.maxBytes).toBe(100_000_000);

    bridge.compose.mockClear();
    await host().render(request());
    expect(composed().output).not.toHaveProperty('maxBytes');
  });

  it('renders through withNativeRenderInputs, with the signal', async () => {
    bridge.native = true;
    finishing();
    const render = request();

    await host().render(render);
    expect(withNativeRenderInputs).toHaveBeenCalledWith(composed(), expect.any(Function), render.signal);
  });

  /* A native engine opens files; a `blob:` URL the page holds is written out as one first. */
  it('stages a clip a phone holds only as a blob, and reads it from the staged file', async () => {
    bridge.native = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['clip'], { type: 'video/mp4' }) })));
    bridge.stageRenderInput.mockResolvedValue({ uri: 'file:///tmp/videokit-render-inputs/1.mp4' });
    finishing();

    await host().render(request({}, [{ key: 'a', fileName: 'a.mp4', playbackUrl: 'blob:capacitor://localhost/42' }]));
    expect(composed().clips[0]!.uri).toBe('file:///tmp/videokit-render-inputs/1.mp4');
    expect(bridge.releaseRenderInputs).toHaveBeenCalledWith({ uris: ['file:///tmp/videokit-render-inputs/1.mp4'] });
  });

  it('reads a clip in a browser by its playback URL when it has no file', async () => {
    finishing();
    await host().render(request({}, [{ key: 'a', fileName: 'a.mp4', playbackUrl: 'blob:http://localhost/picked' }]));
    expect(composed().clips[0]!.uri).toBe('blob:http://localhost/picked');
  });

  it('reads a clip by its file wherever it has one', async () => {
    bridge.native = true;
    finishing();
    await host().render(request({}, [{ ...CLIP, playbackUrl: 'https://localhost/_capacitor_file_/clips/a.mp4' }]));
    expect(composed().clips[0]!.uri).toBe(CLIP.sourcePath);
  });
});

describe('composerRenderHost: failures', () => {
  it.each([
    ['no_space', 'no_space'],
    ['unreadable_input', 'unreadable_input'],
    ['too_large', 'too_large'],
    ['encoder', 'unknown'],
    ['muxer', 'unknown'],
    ['interrupted', 'unknown'],
    ['unsupported', 'unknown'],
    ['unknown', 'unknown'],
  ] as const)('reports the composer\'s %s as the editor\'s %s, and logs it', async (composerCode, editorCode) => {
    failing({ code: composerCode, message: `${composerCode} happened` });
    const log = vi.fn();

    const failure = await host({ log }).render(request()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RenderFailedError);
    expect(failure).toMatchObject({ code: editorCode, message: `${composerCode} happened` });
    expect(log).toHaveBeenCalledWith('[composerRenderHost] compose failed', composerCode, `${composerCode} happened`, '');
    expect(listening()).toBe(0);
  });

  it('blames the host\'s source for a segment that failed, on the base track or on a layer', async () => {
    const sources: EditorSource[] = [CLIP, { key: 'b', fileName: 'b.mp4', sourcePath: 'file:///clips/b.mp4' }];
    const base = reconcileManifest(undefined, ['a'], new Map([['a', 2000]]));
    const layer = { ...base.clips[0]!, id: 'segment-on-a-layer', clipKey: 'b' };
    const manifest: EditManifest = { ...base, videoTracks: [{ id: 'track-1', clips: [layer], startMs: 0, z: 1, opacity: 1 }] };

    failing({ code: 'unreadable_input', clipKey: base.clips[0]!.id });
    await expect(host().render(request({ manifest }, sources))).rejects.toMatchObject({ code: 'unreadable_input', sourceKey: 'a' });

    failing({ code: 'unreadable_input', clipKey: 'segment-on-a-layer' });
    await expect(host().render(request({ manifest }, sources))).rejects.toMatchObject({ sourceKey: 'b' });

    // An id that is no segment's names no source the host ever gave out.
    failing({ code: 'unreadable_input', clipKey: 'music' });
    const failure = await host().render(request({ manifest }, sources)).catch((error: unknown) => error);
    expect((failure as RenderFailedError).sourceKey).toBeUndefined();
  });

  it('refuses a clip with nothing its engine can read as unreadable_input, naming it, before any job', async () => {
    bridge.native = true;
    const log = vi.fn();
    const render = host({ log }).render(request({}, [{ key: 'a', fileName: 'a.mp4', playbackUrl: 'https://localhost/_capacitor_file_/a.mp4' }]));

    const failure = await render.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RenderFailedError);
    expect(failure).toMatchObject({ code: 'unreadable_input', sourceKey: 'a' });
    expect(log).toHaveBeenCalledWith('[composerRenderHost] toComposeSpec refused', expect.anything());
    expect(bridge.addListener).not.toHaveBeenCalled();
    expect(bridge.compose).not.toHaveBeenCalled();
  });

  it('reports a compose() that rejects as unknown, with nothing left listening', async () => {
    bridge.compose.mockRejectedValue(new Error('bridge gone'));
    await expect(host().render(request())).rejects.toMatchObject({ code: 'unknown', message: 'Error: bridge gone' });
    expect(listening()).toBe(0);
  });

  /*
   * A clip a phone holds only as a `blob:` URL is staged as a file first, and a blob that no longer
   * reads - revoked by whatever minted it - is the unreadable clip it is, named, rather than the
   * blank apology and a Try again that reads the same dead blob.
   */
  it('reports a clip it could not stage as unreadable_input, blaming the host\'s source, before any job', async () => {
    bridge.native = true;
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const log = vi.fn();
    const render = request({}, [{ key: 'a', fileName: 'a.mp4', playbackUrl: 'blob:capacitor://localhost/revoked' }]);

    const failure = await host({ log }).render(render).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RenderFailedError);
    expect(failure).toMatchObject({ code: 'unreadable_input', sourceKey: 'a' });
    expect(log).toHaveBeenCalledWith(
      '[composerRenderHost] could not stage a render input',
      'unreadable_input',
      'Could not read a render input: TypeError: Failed to fetch',
      render.manifest.clips[0]!.id,
    );
    expect(bridge.compose).not.toHaveBeenCalled();
    expect(listening()).toBe(0);
  });

  it('reports a disk too full to stage an input on as no_space', async () => {
    bridge.native = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['clip'], { type: 'video/mp4' }) })));
    bridge.stageRenderInput.mockRejectedValue(Object.assign(new Error('No space left on device'), { code: 'no_space' }));

    const failure = await host().render(request({}, [{ key: 'a', fileName: 'a.mp4', playbackUrl: 'blob:capacitor://localhost/42' }])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RenderFailedError);
    expect(failure).toMatchObject({ code: 'no_space' });
    expect((failure as RenderFailedError).sourceKey).toBeUndefined();
  });

  it('reports a toSource hook that threw as unknown and logs it, and one it worded itself as it is', async () => {
    finishing();
    const log = vi.fn();
    const broken = new Error('upload folder gone');

    const failure = await host({ log, toSource: async () => Promise.reject(broken) }).render(request()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RenderFailedError);
    expect(failure).toMatchObject({ code: 'unknown', message: 'Error: upload folder gone' });
    expect(log).toHaveBeenCalledWith('[composerRenderHost] render failed', broken);

    const worded = new RenderFailedError('no_space', 'no room to copy the render');
    await expect(host({ toSource: async () => Promise.reject(worded) }).render(request())).rejects.toBe(worded);
  });

  it('reports a listener the bridge refused as unknown, before any job, with nothing left listening', async () => {
    const attach = bridge.addListener.getMockImplementation()!;
    bridge.addListener.mockImplementation(async (name, listener) => {
      if (name === 'failed') throw new Error('bridge gone');
      return attach(name, listener);
    });
    const log = vi.fn();

    await expect(host({ log }).render(request())).rejects.toMatchObject({ code: 'unknown', message: 'Error: bridge gone' });
    expect(bridge.compose).not.toHaveBeenCalled();
    expect(listening()).toBe(0);
    expect(log).toHaveBeenCalledWith('[composerRenderHost] render failed', expect.any(Error));
  });

  it('reports a cancel nobody here asked for like any other failure', async () => {
    failing({ code: 'cancelled', message: 'cancelled' });
    const log = vi.fn();
    await expect(host({ log }).render(request())).rejects.toMatchObject({ code: 'unknown' });
    expect(log).toHaveBeenCalledWith('[composerRenderHost] compose failed', 'cancelled', 'cancelled', '');
  });

  it('reports through the package\'s debug switch when the host names no log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    failing({ code: 'encoder', message: 'no encoder' });

    await expect(composerRenderHost().render(request())).rejects.toBeInstanceOf(RenderFailedError);
    expect(error).not.toHaveBeenCalled();

    setEditorDebug(true);
    await expect(composerRenderHost().render(request())).rejects.toBeInstanceOf(RenderFailedError);
    expect(error).toHaveBeenCalledWith('[composerRenderHost] compose failed', 'encoder', 'no encoder', '');
  });
});

describe('composerRenderHost: calling it off', () => {
  it('settles the cancel it sent as the abort itself, and does not log it', async () => {
    let started!: () => void;
    const composing = new Promise<void>((resolve) => (started = resolve));
    bridge.compose.mockImplementation(async (spec) => {
      started();
      return { jobId: spec.jobId };
    });
    const controller = new AbortController();
    const log = vi.fn();

    const render = host({ log }).render(request({ signal: controller.signal }));
    await composing;
    await settled();
    controller.abort();
    expect(bridge.cancel).toHaveBeenCalledWith({ jobId: 'job-1' });

    emit('failed', { jobId: 'job-1', code: 'cancelled', message: 'cancelled' });
    await expect(render).rejects.toBe(controller.signal.reason);
    expect(log).not.toHaveBeenCalled();
    expect(listening()).toBe(0);
  });

  it('never starts a job the customer called off before the render began', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(host().render(request({ signal: controller.signal }))).rejects.toBe(controller.signal.reason);
    expect(bridge.compose).not.toHaveBeenCalled();
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it('never starts a job called off while its listeners were going on', async () => {
    const controller = new AbortController();
    const attach = bridge.addListener.getMockImplementation()!;
    bridge.addListener.mockImplementation(async (name, listener) => {
      controller.abort();
      return attach(name, listener);
    });

    // Read once the render has settled: the abort happens inside it.
    const failure = await host().render(request({ signal: controller.signal })).catch((error: unknown) => error);
    expect(failure).toBe(controller.signal.reason);
    expect(bridge.compose).not.toHaveBeenCalled();
    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(listening()).toBe(0);
  });

  /* A cancel sent before the composer has the job names an id it has never heard of, and is lost. */
  it('cancels a job called off while compose was on its way, the moment compose answers', async () => {
    const controller = new AbortController();
    bridge.compose.mockImplementation(async (spec) => {
      controller.abort();
      expect(bridge.cancel).not.toHaveBeenCalled();
      queueMicrotask(() => emit('failed', { jobId: spec.jobId, code: 'cancelled', message: 'cancelled' }));
      return { jobId: spec.jobId };
    });

    const failure = await host().render(request({ signal: controller.signal })).catch((error: unknown) => error);
    expect(failure).toBe(controller.signal.reason);
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    expect(bridge.cancel).toHaveBeenCalledWith({ jobId: 'job-1' });
  });

  /* The cancel lost the race with the last frame: the editor has let go, and nothing is made of the file. */
  it('settles a job that finished after it was called off as the abort, and makes nothing of its file', async () => {
    let started!: () => void;
    const composing = new Promise<void>((resolve) => (started = resolve));
    bridge.compose.mockImplementation(async (spec) => {
      started();
      return { jobId: spec.jobId };
    });
    const controller = new AbortController();
    const toSource = vi.fn();

    const render = host({ toSource }).render(request({ signal: controller.signal }));
    await composing;
    await settled();
    controller.abort();
    emit('completed', { ...RESULT, jobId: 'job-1' });

    await expect(render).rejects.toBe(controller.signal.reason);
    expect(bridge.cancel).toHaveBeenCalledWith({ jobId: 'job-1' });
    expect(toSource).not.toHaveBeenCalled();
    expect(listening()).toBe(0);
  });

  /*
   * The cancel is not the only way a job can end once it has been sent: an encoder can break as it
   * lands, an iOS job is `interrupted` by a customer leaving the app on their way out. The editor has
   * let go either way, and a line in the log would read as a broken render nobody had.
   */
  it.each(['encoder', 'interrupted', 'no_space', 'unknown'] as const)(
    'settles a job that failed %s after it was called off as the abort, and does not log it',
    async (code) => {
      let started!: () => void;
      const composing = new Promise<void>((resolve) => (started = resolve));
      bridge.compose.mockImplementation(async (spec) => {
        started();
        return { jobId: spec.jobId };
      });
      const controller = new AbortController();
      const log = vi.fn();

      const render = host({ log }).render(request({ signal: controller.signal }));
      await composing;
      await settled();
      controller.abort();
      emit('failed', { jobId: 'job-1', code, message: `${code} happened` });

      await expect(render).rejects.toBe(controller.signal.reason);
      expect(log).not.toHaveBeenCalled();
      expect(listening()).toBe(0);
    },
  );

  it('settles a compose() that rejects after the render was called off as the abort, and does not log it', async () => {
    const controller = new AbortController();
    bridge.compose.mockImplementation(async () => {
      controller.abort();
      throw new Error('bridge gone');
    });
    const log = vi.fn();

    // Read once the render has settled: the abort happens inside it.
    const failure = await host({ log }).render(request({ signal: controller.signal })).catch((error: unknown) => error);
    expect(failure).toBe(controller.signal.reason);
    expect(log).not.toHaveBeenCalled();
    expect(listening()).toBe(0);
  });

  it('settles a spec refused after the render was called off as the abort, and does not log it', async () => {
    bridge.native = true;
    const controller = new AbortController();
    const log = vi.fn();
    // Called off while the ids were being made; the clip then has nothing a phone can read.
    const renders = composerRenderHost({
      ids: () => {
        controller.abort();
        return { jobId: 'job-1', batchId: 'edit-1' };
      },
      log,
    });
    const unreadable = [{ key: 'a', fileName: 'a.mp4', playbackUrl: 'https://localhost/_capacitor_file_/a.mp4' }];

    const failure = await renders.render(request({ signal: controller.signal }, unreadable)).catch((error: unknown) => error);
    expect(failure).toBe(controller.signal.reason);
    expect(log).not.toHaveBeenCalled();
    expect(bridge.compose).not.toHaveBeenCalled();
  });

  it('settles a toSource hook that fails after the render was called off as the abort, even one it worded itself', async () => {
    finishing();
    const controller = new AbortController();
    const log = vi.fn();
    const toSource = async (): Promise<EditorSource> => {
      controller.abort();
      throw new RenderFailedError('no_space', 'no room to copy the render');
    };

    const failure = await host({ log, toSource }).render(request({ signal: controller.signal })).catch((error: unknown) => error);
    expect(failure).toBe(controller.signal.reason);
    expect(log).not.toHaveBeenCalled();
  });

  it('settles an input that would not stage after the render was called off as the abort, and does not log it', async () => {
    bridge.native = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['clip'], { type: 'video/mp4' }) })));
    const controller = new AbortController();
    bridge.stageRenderInput.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('No space left on device'), { code: 'no_space' });
    });
    const log = vi.fn();
    const blobClip = [{ key: 'a', fileName: 'a.mp4', playbackUrl: 'blob:capacitor://localhost/42' }];

    const failure = await host({ log }).render(request({ signal: controller.signal }, blobClip)).catch((error: unknown) => error);
    expect(failure).toBe(controller.signal.reason);
    expect(log).not.toHaveBeenCalled();
    expect(bridge.compose).not.toHaveBeenCalled();
  });

  it('sends no cancel once the job has finished, when the editor leaves and aborts', async () => {
    finishing();
    const controller = new AbortController();

    await host().render(request({ signal: controller.signal }));
    controller.abort();
    expect(bridge.cancel).not.toHaveBeenCalled();
  });
});

describe('composerRenderHost: earlier renders', () => {
  let stored: Map<string, string>;

  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
  });

  it('deletes the folders of earlier renders before the next one, keeping one whose cleanup failed', async () => {
    stored.set('app.render-folders', JSON.stringify(['edit-old', 'edit-stuck']));
    bridge.cleanup.mockImplementation(async ({ batchId }) => {
      if (batchId === 'edit-stuck') throw new Error('busy');
    });
    finishing();
    const log = vi.fn();

    await host({ log, discardPreviousRenders: { storageKey: 'app.render-folders' } }).render(request());
    expect(bridge.cleanup.mock.calls).toEqual([[{ batchId: 'edit-old' }], [{ batchId: 'edit-stuck' }]]);
    expect(bridge.cleanup.mock.invocationCallOrder.at(-1)).toBeLessThan(bridge.compose.mock.invocationCallOrder[0]!);
    expect(JSON.parse(stored.get('app.render-folders')!)).toEqual(['edit-stuck', 'edit-1']);
    expect(log).toHaveBeenCalledWith('[composerRenderHost] cleanup failed', 'edit-stuck', expect.any(Error));
  });

  it('writes a render\'s folder down before the job starts, and deletes it on discardRenders', async () => {
    let remembered: unknown;
    bridge.compose.mockImplementation(async (spec) => {
      remembered = JSON.parse(stored.get('capacitor-video-kit.render-folders') ?? '[]');
      queueMicrotask(() => emit('completed', { ...RESULT, jobId: spec.jobId }));
      return { jobId: spec.jobId };
    });
    const renders = host({ discardPreviousRenders: true });

    await renders.render(request());
    expect(remembered).toEqual(['edit-1']);

    await renders.discardRenders();
    expect(bridge.cleanup).toHaveBeenCalledWith({ batchId: 'edit-1' });
    expect(stored.has('capacitor-video-kit.render-folders')).toBe(false);
  });

  /*
   * `cleanup` forgets the jobs writing into a folder and they send no final event, so deleting the
   * folder of a render still waiting on one - an iOS job called off and still closing its file when
   * the customer taps Next again - would leave that render waiting for good.
   */
  it('leaves the folder of a render that has not settled alone, and deletes it once it has', async () => {
    let started!: () => void;
    const composing = new Promise<void>((resolve) => (started = resolve));
    bridge.compose.mockImplementation(async (spec) => {
      if (spec.jobId === 'job-1') started();
      else queueMicrotask(() => emit('completed', { ...RESULT, jobId: spec.jobId }));
      return { jobId: spec.jobId };
    });
    const renders = host({ discardPreviousRenders: true });
    const controller = new AbortController();

    const first = renders.render(request({ signal: controller.signal }));
    await composing;
    controller.abort();
    await renders.render(request());
    await renders.discardRenders();
    expect(bridge.cleanup.mock.calls).toEqual([[{ batchId: 'edit-2' }]]);
    expect(JSON.parse(stored.get('capacitor-video-kit.render-folders')!)).toEqual(['edit-1']);

    emit('failed', { jobId: 'job-1', code: 'cancelled', message: 'cancelled' });
    await expect(first).rejects.toBe(controller.signal.reason);
    await renders.discardRenders();
    expect(bridge.cleanup).toHaveBeenLastCalledWith({ batchId: 'edit-1' });
    expect(stored.has('capacitor-video-kit.render-folders')).toBe(false);
  });

  /* The key may be one a host kept its own list under, and `cleanup` of `..` deletes the folder the job folders are in. */
  it('never hands cleanup a remembered id that is not a folder of its own', async () => {
    stored.set('capacitor-video-kit.render-folders', JSON.stringify(['.', '..', '', 7, 'edit-old']));
    finishing();

    await host({ discardPreviousRenders: true }).render(request());
    expect(bridge.cleanup.mock.calls).toEqual([[{ batchId: 'edit-old' }]]);
  });

  it('builds nothing for a render called off while earlier folders were being deleted', async () => {
    stored.set('capacitor-video-kit.render-folders', JSON.stringify(['edit-old']));
    const controller = new AbortController();
    bridge.cleanup.mockImplementation(async () => controller.abort());
    const ids = vi.fn(() => ({ jobId: 'job-1', batchId: 'edit-1' }));
    const log = vi.fn();

    const failure = await composerRenderHost({ ids, log, discardPreviousRenders: true })
      .render(request({ signal: controller.signal }))
      .catch((error: unknown) => error);
    expect(failure).toBe(controller.signal.reason);
    expect(ids).not.toHaveBeenCalled();
    expect(bridge.compose).not.toHaveBeenCalled();
    expect(JSON.parse(stored.get('capacitor-video-kit.render-folders') ?? '[]')).not.toContain('edit-1');
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses a batch id from the host that is not a folder of its own, before anything starts', async () => {
    const log = vi.fn();
    const renders = composerRenderHost({ ids: () => ({ jobId: 'job', batchId: '..' }), log, discardPreviousRenders: true });

    await expect(renders.render(request())).rejects.toMatchObject({ code: 'unknown' });
    expect(bridge.compose).not.toHaveBeenCalled();
    expect(stored.has('capacitor-video-kit.render-folders')).toBe(false);
    expect(log).toHaveBeenCalledWith('[composerRenderHost] ids() answered a batch id no folder can have', '..');
  });

  it('remembers only as many folders as it is told to', async () => {
    bridge.cleanup.mockRejectedValue(new Error('busy'));
    finishing();
    const renders = host({ discardPreviousRenders: { remember: 2 } });

    for (let i = 0; i < 3; i++) await renders.render(request());
    expect(JSON.parse(stored.get('capacitor-video-kit.render-folders')!)).toEqual(['edit-2', 'edit-3']);
  });

  it('deletes and remembers nothing when it is not asked to', async () => {
    stored.set('capacitor-video-kit.render-folders', JSON.stringify(['edit-old']));
    finishing();
    const renders = host();

    await renders.render(request());
    await renders.discardRenders();
    expect(bridge.cleanup).not.toHaveBeenCalled();
    expect(JSON.parse(stored.get('capacitor-video-kit.render-folders')!)).toEqual(['edit-old']);
  });

  it('renders all the same when storage cannot be read or written', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => undefined,
    });
    finishing();

    await expect(host({ discardPreviousRenders: true }).render(request())).resolves.toMatchObject({ sourcePath: RESULT.uri });
  });
});

describe('composerRenderHost: what the device can do', () => {
  it('answers whether the composer can render, and false when it cannot be asked', async () => {
    bridge.capabilities.mockResolvedValue({ supported: true });
    expect(await host().isSupported()).toBe(true);

    bridge.capabilities.mockRejectedValue(new Error('no plugin'));
    const log = vi.fn();
    expect(await host({ log }).isSupported()).toBe(false);
    expect(log).toHaveBeenCalledWith('[composerRenderHost] capabilities() failed', expect.any(Error));
  });

  /* Called with no `!`: the type says it is always there, so a host that wraps this one writes no fallback. */
  it('answers which frames the device can encode, and nothing when it cannot be asked', async () => {
    const frames = [{ width: 720, height: 1280, fps: 30 }];
    bridge.encodeSupport.mockResolvedValue({ frames: [{ ...frames[0]!, supported: true }] });
    expect(await host().encodeSupport(frames)).toEqual([{ ...frames[0], supported: true }]);
    expect(bridge.encodeSupport).toHaveBeenCalledWith({ frames });

    bridge.encodeSupport.mockRejectedValue(new Error('no plugin'));
    expect(await host().encodeSupport(frames)).toEqual([]);
  });
});

describe('containerOf', () => {
  it('names a render WebM when its type says so, and MP4 for anything else, no type at all included', () => {
    expect(containerOf('video/webm')).toBe('webm');
    expect(containerOf('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(containerOf('VIDEO/WEBM')).toBe('webm');
    expect(containerOf('video/mp4')).toBe('mp4');
    // What Capacitor's iOS local server says about a whole file: nothing, and every native render is MP4.
    expect(containerOf('')).toBe('mp4');
    expect(containerOf('application/octet-stream')).toBe('mp4');
  });
});

describe('readRenderFile', () => {
  const RENDER = 'file:///var/mobile/Containers/Data/Application/A/Library/Application%20Support/video-batches/edit-1/stitched.mp4';
  const SERVED = RENDER.replace('file://', 'capacitor://localhost/_capacitor_file_');

  /** Capacitor's global as a native side puts it in the page: the one thing this reads of it. */
  function onDevice(): void {
    vi.stubGlobal('Capacitor', { convertFileSrc: (path: string) => path.replace('file://', 'capacitor://localhost/_capacitor_file_') });
  }

  it('reads a native render through the local server, into an MP4 File typed as one', async () => {
    onDevice();
    // What the iOS local server really answers for a whole file: no HTTP status and no type.
    const read = vi.fn(async () => ({ ok: false, status: 0, blob: async () => new Blob(['video']) }));
    vi.stubGlobal('fetch', read);

    const file = await readRenderFile(RENDER);
    expect(read).toHaveBeenCalledWith(SERVED);
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('edited.mp4');
    expect(file.type).toBe('video/mp4');
    expect(await file.text()).toBe('video');
  });

  it('reads the web engine\'s blob as it is, and names a WebM for what it is under the name it is given', async () => {
    const read = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['webm'], { type: 'video/webm' }) }));
    vi.stubGlobal('fetch', read);

    const file = await readRenderFile('blob:http://localhost/9b1c', 'edited-1700000000000');
    expect(read).toHaveBeenCalledWith('blob:http://localhost/9b1c');
    expect(file.name).toBe('edited-1700000000000.webm');
    expect(file.type).toBe('video/webm');
  });

  it('rejects rather than answering a File there is nothing in', async () => {
    onDevice();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob(['not found']) })));
    await expect(readRenderFile(RENDER)).rejects.toThrow('HTTP 404');

    // No status and no bytes: from the local server, a file of nothing.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 0, blob: async () => new Blob([]) })));
    await expect(readRenderFile(RENDER)).rejects.toThrow();

    // A good answer with no bytes is no render either.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob([], { type: 'video/mp4' }) })));
    await expect(readRenderFile(RENDER)).rejects.toThrow('it is empty');

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(readRenderFile(RENDER)).rejects.toThrow('Failed to fetch');
  });

  /* A hook that lets the rejection through fails the render as `unknown`, with the reason in the log. */
  it('fails the render it is read in as unknown, logged, when it cannot read the file', async () => {
    onDevice();
    finishing({ uri: RENDER });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob([]) })));
    const log = vi.fn();

    const toSource = async (result: ComposeResult): Promise<EditorSource> => {
      const file = await readRenderFile(result.uri);
      return { key: 'post', fileName: file.name, sourcePath: result.uri };
    };
    await expect(host({ log, toSource }).render(request())).rejects.toMatchObject({ code: 'unknown' });
    expect(log).toHaveBeenCalledWith('[composerRenderHost] render failed', expect.any(Error));
  });
});
