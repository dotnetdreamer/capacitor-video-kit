import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The page's decoders, answering whatever a test says: a `<video>` that seeks as fast or as slowly
 * as the test wants, and a picture decode. The real ones run in `labels.cmp.test.ts`.
 */
const media = vi.hoisted(() => ({ open: vi.fn(), decodePicture: vi.fn() }));
vi.mock('./media', () => ({ FrameReader: { open: media.open } }));
vi.mock('../../web-runtime/picture', async importOriginal => ({
  ...(await importOriginal<typeof import('../../web-runtime/picture')>()),
  decodePicture: media.decodePicture,
}));

/*
 * The kit's stored files, as the test says they were stored: IndexedDB is not what is under test. A
 * stored file loads as a `blob:` URL of its own, so the picture decode above is reached for one.
 */
const stored = vi.hoisted(() => ({
  readFile: vi.fn(),
  loadableUrl: async (uri: string) => (uri.startsWith('videokit-file:') ? `blob:${uri}` : uri),
}));
vi.mock('../../web-runtime/files', async importOriginal => ({
  ...(await importOriginal<typeof import('../../web-runtime/files')>()),
  readFile: stored.readFile,
  loadableUrl: stored.loadableUrl,
}));

import { AT_ONCE, LOOK_BUDGET_MS, planTimes, Turns } from './labels';

/* The phones' pace, kept in a browser: two looks at a time, 8 s on a video. */
describe('the pace of looking', () => {
  it('is the pace the phones keep: two at a time, and 8 s a video', () => {
    expect(AT_ONCE).toBe(2);
    expect(LOOK_BUDGET_MS).toBe(8_000);
  });

  it('runs two at once and starts the third only when one is done, first come first served', async () => {
    const turns = new Turns(2);
    const started: string[] = [];
    const take = (name: string) => turns.take().then(() => started.push(name));
    const first = take('a');
    const second = take('b');
    const third = take('c');
    const fourth = take('d');
    await Promise.all([first, second]);
    await Promise.resolve();
    expect(started).toEqual(['a', 'b']);

    turns.done();
    await third;
    expect(started).toEqual(['a', 'b', 'c']);

    // A call made the moment a turn is handed on waits behind the one that was already waiting.
    turns.done();
    const late = take('e');
    await fourth;
    await Promise.resolve();
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    turns.done();
    await late;
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

/* Which frames of a clip a browser looks at: the phones' plan, number for number. */
describe('planTimes', () => {
  it('spreads the frames through the clip, each at the middle of its own share', () => {
    expect(planTimes(10_000, undefined, 5)).toEqual([1000, 3000, 5000, 7000, 9000]);
    expect(planTimes(8_000, [], 1)).toEqual([4000]);
  });

  it('takes the times asked for instead, whole milliseconds, in order and each once, inside the clip', () => {
    expect(planTimes(5_000, [4200.4, 1000, 1000, -3, Number.NaN, 9000], 5)).toEqual([0, 1000, 4200, 5000]);
  });

  it('keeps the times asked for as they are when the length is unknown', () => {
    expect(planTimes(0, [2500, 500], 5)).toEqual([500, 2500]);
  });
});

/*
 * The recogniser around MediaPipe - loading it, letting it go, keeping to the budget - with a
 * MediaPipe that answers what a test says. It is imported from a URL, as the real one is, so the fake
 * is a module at a `data:` URL that hands every call to whatever the test has put on `globalThis`;
 * a module import that failed stays failed at its URL here as it does in a page, which is what the
 * retry under a URL of its own is for.
 */

const MODEL = 'https://cdn.test/labeling/efficientnet_lite0.tflite';

interface Recorded {
  options: { canvas?: unknown; runningMode?: string; maxResults?: number; baseOptions?: Record<string, unknown> };
  classifier: FakeClassifier;
  /** Whether the model had been asked for by the time MediaPipe started on its WebAssembly. */
  modelAskedFirst: boolean;
  /** The model as MediaPipe read it. */
  model: number[];
}

/** What the fake MediaPipe does, test by test. */
interface Runtime {
  imported: string[];
  importFails: boolean;
  /** Every classifier asked for, with what it was asked with. */
  created: Recorded[];
  /** Holds the next creation until released, as a slow WebAssembly download does. */
  createWaits: Promise<void> | null;
  /** A classifier made from now on throws at every picture, as one does with no WebGL. */
  noWebGl: boolean;
  FilesetResolver: { forVisionTasks(base: string): Promise<unknown> };
  ImageClassifier: { createFromOptions(fileset: unknown, options: Recorded['options']): Promise<FakeClassifier> };
}

class FakeClassifier {
  closed = false;
  broken: boolean;
  readonly classify = vi.fn(() => {
    if (this.broken) throw new TypeError("Cannot read properties of undefined (reading 'activeTexture')");
    return { classifications: [{ categories: [{ categoryName: 'seashore', score: 0.6 }, { categoryName: 'sandbar', score: 0.2 }] }] };
  });
  readonly close = vi.fn(() => {
    this.closed = true;
  });

  constructor(broken: boolean) {
    this.broken = broken;
  }
}

/**
 * A canvas that keeps what was drawn on it until it is cleared, as a real one does, and reads back
 * as empty when nothing is on it. A frame drawn while [blank] says so draws nothing, as a frame of a
 * video whose picture the browser does not decode draws nothing.
 */
class FakeCanvas {
  width = 0;
  height = 0;
  static blank = false;
  /** Every canvas made, in order. */
  static made: FakeCanvas[] = [];
  /** What `getContext` was asked for the 2D context with. */
  contextOptions: unknown;
  private painted = false;
  private readonly listeners = new Map<string, (() => void)[]>();
  readonly ctx = {
    fillStyle: '',
    fillRect: vi.fn(() => {
      this.painted = true;
    }),
    clearRect: vi.fn(() => {
      this.painted = false;
    }),
    drawImage: vi.fn(() => {
      if (!FakeCanvas.blank) this.painted = true;
    }),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(this.painted ? 255 : 0),
    })),
  };

  constructor() {
    FakeCanvas.made.push(this);
  }

  getContext(type: string, options?: unknown): unknown {
    if (type !== '2d') return null;
    this.contextOptions = options;
    return this.ctx;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** What the browser does when it takes the canvas's WebGL context back. */
  loseContext(): void {
    for (const listener of this.listeners.get('webglcontextlost') ?? []) listener();
  }
}

const runtime = (): Runtime => (globalThis as unknown as { __labelsRuntime: Runtime }).__labelsRuntime;

/** The fake MediaPipe at a URL of the test's own, so no test is handed another's module, failed or not. */
function runtimeUrl(test: string): string {
  const source = [
    'const r = () => globalThis.__labelsRuntime;',
    'r().imported.push(import.meta.url);',
    'if (r().importFails) throw new Error("404 Not Found");',
    'export const FilesetResolver = { forVisionTasks: (base) => r().FilesetResolver.forVisionTasks(base) };',
    'export const ImageClassifier = { createFromOptions: (fileset, options) => r().ImageClassifier.createFromOptions(fileset, options) };',
    // What the retry adds lands in this comment.
    `// ${test}`,
  ].join('\n');
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

/** A `<video>` as the kit's reader holds it: `seek` as the test says, a picture of `width` by `height`. */
function reader({ width = 640, height = 360, seek }: { width?: number; height?: number; seek?: (seconds: number) => Promise<boolean> } = {}) {
  const video = { duration: 10, error: null as { code: number } | null };
  return { video, width, height, seek: vi.fn(seek ?? (async () => true)), close: vi.fn() };
}

const later = (ms: number, value: boolean) => new Promise<boolean>(resolve => setTimeout(() => resolve(value), ms));

describe('the recogniser a browser is brought', () => {
  let labels: typeof import('./labels');
  let fetched: string[];
  /** The type each `blob:` URL answers with. */
  let types: Map<string, string>;

  /** A fresh module - nothing loaded, nothing remembered - with its files at this test's runtime. */
  async function fresh(test: string): Promise<void> {
    vi.resetModules();
    labels = await import('./labels');
    labels.configureWebLabeling({ runtimeUrl: runtimeUrl(test), wasmBaseUrl: 'https://cdn.test/labeling/wasm/', modelUrl: MODEL });
  }

  beforeEach(() => {
    fetched = [];
    types = new Map();
    FakeCanvas.blank = false;
    FakeCanvas.made = [];
    stored.readFile.mockReset();
    stored.readFile.mockResolvedValue(null);
    const state: Runtime = {
      imported: [],
      importFails: false,
      created: [],
      createWaits: null,
      noWebGl: false,
      FilesetResolver: { forVisionTasks: async base => ({ wasmLoaderPath: `${base}/vision_wasm_internal.js` }) },
      ImageClassifier: {
        async createFromOptions(_fileset, options) {
          const recorded: Recorded = {
            options,
            classifier: new FakeClassifier(state.noWebGl),
            modelAskedFirst: fetched.includes(MODEL),
            model: [],
          };
          state.created.push(recorded);
          await state.createWaits;
          // MediaPipe reads a model handed over as a stream once its WebAssembly is up, as here.
          const stream = options.baseOptions?.['modelAssetBuffer'] as ReadableStreamDefaultReader<Uint8Array>;
          for (let chunk = await stream.read(); !chunk.done; chunk = await stream.read()) recorded.model.push(...chunk.value);
          return recorded.classifier;
        },
      },
    };
    (globalThis as unknown as { __labelsRuntime: Runtime }).__labelsRuntime = state;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetched.push(url);
        if (url === MODEL) return new Response(new Uint8Array([1, 2, 3]));
        if (url.startsWith('blob:')) return new Response('', { headers: { 'content-type': types.get(url) ?? '' } });
        throw new TypeError('Failed to fetch');
      }),
    );
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'canvas' ? new FakeCanvas() : createElement(tag)) as typeof document.createElement);
    media.open.mockReset();
    media.decodePicture.mockReset();
    media.open.mockImplementation(async () => reader());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('loading', () => {
    it('asks for the model beside the runtime rather than after it, and hands it to MediaPipe as it arrives', async () => {
      await fresh('parallel');
      expect(await labels.prepareWebLabeling()).toBe(true);

      const [created] = runtime().created;
      expect(created!.modelAskedFirst).toBe(true);
      expect(created!.options.baseOptions).toMatchObject({ delegate: 'CPU' });
      expect(created!.options.baseOptions).not.toHaveProperty('modelAssetPath');
      expect(created!.model).toEqual([1, 2, 3]);
    });

    /* Left to choose, MediaPipe takes an OffscreenCanvas, which an iOS 16 in-app browser has with no WebGL. */
    it("hands MediaPipe a canvas of the document's to take pictures in through", async () => {
      await fresh('canvas');
      await labels.prepareWebLabeling();
      expect(runtime().created[0]!.options.canvas).toBeInstanceOf(FakeCanvas);
    });

    it('loads once for every call made while it loads, and answers true once it is ready', async () => {
      await fresh('once');
      const answers = await Promise.all([labels.prepareWebLabeling(), labels.prepareWebLabeling(), labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' })]);
      expect(answers.slice(0, 2)).toEqual([true, true]);
      expect(runtime().created).toHaveLength(1);
    });

    /* MediaPipe creates a classifier with no WebGL, and only throws when it is shown a picture. */
    it('refuses as unavailable at the load where the classifier cannot classify one pixel, and lets it go', async () => {
      await fresh('no-webgl');
      runtime().noWebGl = true;

      expect(await labels.prepareWebLabeling()).toBe(false);
      expect(runtime().created[0]!.classifier.closed).toBe(true);
      await expect(labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' })).rejects.toBeInstanceOf(labels.LabelingUnavailableError);
      expect(media.open).not.toHaveBeenCalled();
    });

    /* The warm-up as the picker opens and the first clip after it: one failure, not two downloads. */
    it('answers a failed load again for a minute rather than trying it again, then tries it under a URL of its own', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      await fresh('retry');
      runtime().importFails = true;

      expect(await labels.prepareWebLabeling()).toBe(false);
      await expect(labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' })).rejects.toThrow(/would not load: 404 Not Found/);
      expect(fetched.filter(url => url === MODEL)).toHaveLength(1);

      runtime().importFails = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await labels.prepareWebLabeling()).toBe(true);
      expect(runtime().imported).toHaveLength(2);
      expect(runtime().imported[1]).toMatch(/\?retry=1$/);
    });

    it('tries new files at once, whatever the old ones did', async () => {
      await fresh('new-files');
      runtime().importFails = true;
      expect(await labels.prepareWebLabeling()).toBe(false);

      runtime().importFails = false;
      labels.configureWebLabeling({ runtimeUrl: runtimeUrl('new-files-2') });
      expect(await labels.prepareWebLabeling()).toBe(true);
    });
  });

  describe('letting a classifier go', () => {
    it('closes the one configureWebLabeling replaces only once the look using it is done', async () => {
      await fresh('configure-in-use');
      await labels.prepareWebLabeling();
      let land: (landed: boolean) => void = () => undefined;
      media.open.mockImplementationOnce(async () => reader({ seek: () => new Promise(resolve => (land = resolve)) }));
      const looking = labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video', frames: 1 });
      await vi.waitFor(() => expect(media.open).toHaveBeenCalled());

      labels.configureWebLabeling({ modelUrl: MODEL });
      const [first] = runtime().created;
      await Promise.resolve();
      expect(first!.classifier.closed).toBe(false);

      // The next call has the new one, while the first look still has the old.
      await labels.labelMediaInBrowser({ uri: 'blob:b', kind: 'video', frames: 1 });
      expect(runtime().created).toHaveLength(2);
      expect(first!.classifier.closed).toBe(false);

      land(true);
      const result = await looking;
      expect(result.frames).toHaveLength(1);
      expect(first!.classifier.closed).toBe(true);
      expect(runtime().created[1]!.classifier.closed).toBe(false);
    });

    /* MediaPipe's loader hands its WebAssembly over through one global, which two loads would share. */
    it('starts no load while another is running', async () => {
      await fresh('serial-loads');
      let finish: () => void = () => undefined;
      runtime().createWaits = new Promise(resolve => (finish = resolve));
      const first = labels.prepareWebLabeling();
      await vi.waitFor(() => expect(runtime().created).toHaveLength(1));

      runtime().createWaits = null;
      labels.configureWebLabeling({ modelUrl: MODEL });
      const second = labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video', frames: 1 });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(runtime().created).toHaveLength(1);

      finish();
      expect(await first).toBe(true);
      expect((await second).frames).toHaveLength(1);
      expect(runtime().created).toHaveLength(2);
      // Loaded after it was replaced, so let go at once: nothing was using it.
      expect(runtime().created[0]!.classifier.closed).toBe(true);
    });

    /* A GPU reset, or a page with too many WebGL contexts: every later picture would fail the same way. */
    it('lets a classifier that throws go, refuses as unavailable, and loads another at the next call', async () => {
      await fresh('throws');
      await labels.prepareWebLabeling();
      const [first] = runtime().created;
      first!.classifier.broken = true;

      const failed = labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' });
      await expect(failed).rejects.toBeInstanceOf(labels.LabelingUnavailableError);
      await expect(failed).rejects.toThrow(/stopped working/);
      expect(first!.classifier.closed).toBe(true);

      const result = await labels.labelMediaInBrowser({ uri: 'blob:b', kind: 'video', frames: 2 });
      expect(result.frames).toHaveLength(2);
      expect(runtime().created).toHaveLength(2);
    });

    it('lets a classifier whose WebGL context was lost go, and loads another at the next call', async () => {
      await fresh('lost');
      await labels.prepareWebLabeling();
      const [first] = runtime().created;
      (first!.options.canvas as FakeCanvas).loseContext();
      expect(first!.classifier.closed).toBe(true);

      await labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video', frames: 1 });
      expect(runtime().created).toHaveLength(2);
    });
  });

  describe('the budget', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));

    /* Every seek waited on for its full 8 s, five times over, while the clips behind it waited too. */
    it('gives a video whose seeks never land its first try and no more, and refuses it as unreadable', async () => {
      await fresh('never-lands');
      await labels.prepareWebLabeling();
      const video = reader({ seek: () => later(8_000, false) });
      media.open.mockImplementationOnce(async () => video);

      const looking = labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' });
      const settled = expect(looking).rejects.toBeInstanceOf(labels.LabelingUnreadableError);
      await vi.advanceTimersByTimeAsync(8_000);
      await settled;
      expect(video.seek).toHaveBeenCalledTimes(1);
    });

    it('waits for a seek after the first no longer than the budget has left', async () => {
      await fresh('capped-seek');
      await labels.prepareWebLabeling();
      let seeks = 0;
      const video = reader({ seek: () => (++seeks === 1 ? later(1_000, true) : new Promise<boolean>(() => undefined)) });
      media.open.mockImplementationOnce(async () => video);

      let result: Awaited<ReturnType<typeof labels.labelMediaInBrowser>> | undefined;
      void labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' }).then(answer => (result = answer));
      await vi.advanceTimersByTimeAsync(7_999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result?.frames.map(frame => frame.timeMs)).toEqual([1000]);
      expect(video.close).toHaveBeenCalled();
    });

    /* After MEDIA_ERR_DECODE a `<video>` never fires `seeked` again, so each seek would wait its 8 s. */
    it('seeks a video whose decoder has failed no more', async () => {
      await fresh('decode-error');
      await labels.prepareWebLabeling();
      const video = reader();
      video.seek.mockImplementation(async () => {
        video.video.error = { code: 3 };
        return false;
      });
      media.open.mockImplementationOnce(async () => video);

      await expect(labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' })).rejects.toBeInstanceOf(labels.LabelingUnreadableError);
      expect(video.seek).toHaveBeenCalledTimes(1);
    });

    /* The first clips of a page, on a slow connection: judged on every frame, not on one each. */
    it("starts a call's budget when the recogniser is ready, not while it downloads", async () => {
      await fresh('slow-download');
      runtime().createWaits = new Promise(resolve => setTimeout(resolve, 20_000));
      const video = reader({ seek: () => later(1_000, true) });
      media.open.mockImplementationOnce(async () => video);

      let result: Awaited<ReturnType<typeof labels.labelMediaInBrowser>> | undefined;
      void labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' }).then(answer => (result = answer));
      await vi.advanceTimersByTimeAsync(25_000);
      expect(result?.frames).toHaveLength(5);
    });
  });

  describe('what it will not label', () => {
    /* HEVC where the browser has no decoder for it: the file opens on its sound alone. */
    it('refuses a video the browser decodes no picture for as unreadable, rather than labeling an empty frame', async () => {
      await fresh('no-picture');
      await labels.prepareWebLabeling();
      media.open.mockImplementationOnce(async () => reader({ width: 0, height: 0 }));
      const classifier = runtime().created[0]!.classifier;
      const looked = classifier.classify.mock.calls.length;

      await expect(labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' })).rejects.toThrow(/decodes no picture/);
      expect(classifier.classify).toHaveBeenCalledTimes(looked);
    });

    it('leaves out a frame that drew nothing, and refuses a video whose every frame did', async () => {
      await fresh('blank');
      await labels.prepareWebLabeling();
      FakeCanvas.blank = true;
      const classifier = runtime().created[0]!.classifier;
      const looked = classifier.classify.mock.calls.length;

      const failed = labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' });
      await expect(failed).rejects.toBeInstanceOf(labels.LabelingUnreadableError);
      await expect(failed).rejects.toThrow(/decodes no picture/);
      expect(classifier.classify).toHaveBeenCalledTimes(looked);
    });

    /* A decoder that gives up part way: its later frames draw nothing over the one it did draw. */
    it('leaves out a frame that drew nothing after one that drew, rather than looking at that one again', async () => {
      await fresh('blank-after');
      await labels.prepareWebLabeling();
      let seeks = 0;
      media.open.mockImplementationOnce(async () =>
        reader({
          seek: async () => {
            FakeCanvas.blank = ++seeks > 1;
            return true;
          },
        }),
      );

      const result = await labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video' });
      expect(seeks).toBe(5);
      expect(result.frames.map(frame => frame.timeMs)).toEqual([1000]);
    });
  });

  /* Each frame is read back twice, by the blank check and by MediaPipe: from memory, not the GPU. */
  it('draws the frames on a canvas kept for reading back', async () => {
    await fresh('read-back');
    await labels.prepareWebLabeling();

    await labels.labelMediaInBrowser({ uri: 'blob:a', kind: 'video', frames: 2 });
    const drawnOn = FakeCanvas.made.filter(canvas => canvas.ctx.drawImage.mock.calls.length > 0);
    expect(drawnOn).toHaveLength(1);
    expect(drawnOn[0]!.contextOptions).toEqual({ willReadFrequently: true });
  });

  /* Safari's `<img>` decodes MP4, and would hand a clip's opening frame back as a photograph. */
  describe('with no kind', () => {
    const photo = { bitmap: { close: vi.fn() }, width: 448, height: 336 };

    it('never reads a file whose type is a video as a picture', async () => {
      await fresh('typed-video');
      types.set('blob:clip', 'video/mp4');
      media.decodePicture.mockResolvedValue(photo);

      const result = await labels.labelMediaInBrowser({ uri: 'blob:clip' });
      expect(result.kind).toBe('video');
      expect(media.decodePicture).not.toHaveBeenCalled();
    });

    it('reads a file whose type is a picture as one', async () => {
      await fresh('typed-picture');
      types.set('blob:photo', 'image/jpeg');
      media.decodePicture.mockResolvedValue(photo);

      const result = await labels.labelMediaInBrowser({ uri: 'blob:photo' });
      expect(result).toMatchObject({ kind: 'image', frames: [{ timeMs: 0 }] });
      expect(media.open).not.toHaveBeenCalled();
    });

    it('goes by the name where the type would cost a download', async () => {
      await fresh('named-video');
      media.decodePicture.mockResolvedValue(photo);

      const result = await labels.labelMediaInBrowser({ uri: 'https://example.test/clips/beach.MOV?v=1' });
      expect(result.kind).toBe('video');
      expect(media.decodePicture).not.toHaveBeenCalled();
      expect(fetched).not.toContain('https://example.test/clips/beach.MOV?v=1');
    });

    /* What a file is stored as when whatever stored it did not know its type. */
    it('goes by the name where the type names neither a picture nor a video', async () => {
      await fresh('octet-stream');
      stored.readFile.mockResolvedValue(new Blob([], { type: 'application/octet-stream' }));
      media.decodePicture.mockResolvedValue(photo);

      const clip = await labels.labelMediaInBrowser({ uri: 'videokit-file:/picks/clip.mp4' });
      expect(clip.kind).toBe('video');
      expect(media.decodePicture).not.toHaveBeenCalled();

      // The same type under a picture's name is read as the picture it is.
      const still = await labels.labelMediaInBrowser({ uri: 'videokit-file:/picks/still.jpg' });
      expect(still.kind).toBe('image');
      expect(media.decodePicture).toHaveBeenCalledWith('blob:videokit-file:/picks/still.jpg', 448);
    });
  });
});
