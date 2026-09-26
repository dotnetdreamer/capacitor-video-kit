import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { afterEach, describe, expect, it, type TestContext } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { PICTURE_SOURCE_MS, defaultClipEdit, defaultPictureEdit, emptyManifest, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because what is being pinned here is a PICTURE: the preview is
 * one canvas composited by the browser renderer's own `Painter` from hidden `<video>` elements, and
 * a mock DOM has neither a decoder nor a pixel.
 *
 * These used to measure each `<video>` element's box and assert on the hold canvases over them.
 * Neither exists now - there is one element per track, a pixel across in the corner of the frame,
 * and what the customer sees is drawn rather than laid out - so the cases are re-expressed the only
 * honest way left: real footage in, pixels off the canvas out, exactly as `web/render.cmp.test.ts`
 * checks the same compositor.
 *
 * The second and third groups are the taps that used to come back to a black preview. Add video
 * opens a picker, which hides the page; WebKit purges every paused element's decoded frame while
 * the page is away and puts nothing back, and no seek brings it back - see [onPageShown]. Neither
 * is visible in Chromium, which keeps the frame, so what is asserted there is what was ASKED of the
 * elements: the source goes on again.
 */

/** What every element in the editor is handed, and what a `<video>` here is stood in for by. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

/** A paused element parked a second into its clip. */
const DURATION_S = 5;

const SOURCE_WIDTH = 160;
const SOURCE_HEIGHT = 160;
const SOURCE_FRAMES = 12;
const SOURCE_FPS = 12;

/** Decoding a real file and compositing it takes moments, not milliseconds. */
const PIXEL_TIMEOUT_MS = 20_000;

const mounted: { store: EditorStore; column: HTMLElement }[] = [];
const revoke: string[] = [];

/**
 * A short solid-colour MP4, muxed the way the renderer muxes one.
 *
 * The same fixture `web/render.cmp.test.ts` builds, and deliberately built again here rather than
 * shared: that suite renders files, this one plays them, and a helper in a third place that both
 * imported would have to be a module the package ships.
 */
async function makeSourceVideo(colour: string, seconds = SOURCE_FRAMES / SOURCE_FPS): Promise<string> {
  return encodeVideo(Math.round(seconds * SOURCE_FPS), SOURCE_FPS, ctx => {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
  });
}

/**
 * A clip whose picture CHANGES on every frame and is still one plain colour on every frame: the one
 * channel steps through eight levels, 190 to 246, and the other two stay at nothing. A spot on it
 * that stops changing is a picture that has frozen, which is what the playing cases look for - and
 * the colour it is still reads as red or blue, which is what the others do.
 */
async function makeMovingVideo(channel: 'red' | 'blue', seconds: number, fps = 30): Promise<string> {
  return encodeVideo(Math.round(seconds * fps), fps, (ctx, i) => {
    const level = 190 + (i % 8) * 8;
    ctx.fillStyle = channel === 'red' ? `rgb(${level}, 0, 0)` : `rgb(0, 0, ${level})`;
    ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
  });
}

async function encodeVideo(frameCount: number, fps: number, paint: (ctx: CanvasRenderingContext2D, frame: number) => void): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = SOURCE_WIDTH;
  canvas.height = SOURCE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality({ bitrate: 1_000_000 }) });
  output.addVideoTrack(source);
  await output.start();
  for (let i = 0; i < frameCount; i++) {
    paint(ctx, i);
    await source.add(i / fps, 1 / fps);
  }
  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('no fixture');
  const url = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
  revoke.push(url);
  return url;
}

/**
 * Whether this browser can DECODE H.264 at all - not the same question as whether it can encode it.
 * An open-source Chromium build carries an encoder and no proprietary decoder, and asserting on
 * pixels there would fail over a file that is perfectly good.
 */
function canDecodeAvc(): boolean {
  return document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '';
}

/** Marks the case skipped with its reason rather than returning a tick for work it did not do. */
function needs(ctx: TestContext, able: boolean, why: string): void {
  if (!able) ctx.skip(why);
}

function manifest(withTrack: boolean): EditManifest {
  const base = { ...emptyManifest(), clips: [defaultClipEdit('clip-a', 5000, 'seg-a')] };
  if (!withTrack) return base;
  return {
    ...base,
    videoTracks: [
      { id: 'track-1', clips: [defaultClipEdit('clip-b', 4000, 'seg-b')], startMs: 0, z: 1, opacity: 1 },
    ],
  };
}

/**
 * The editor's preview on the phone it was drawn for.
 *
 * `playable` hands each source a real file to play, for the cases that read pixels; without it the
 * elements have nothing to decode, which is all the cases about loads and seeks need.
 */
async function mount(
  withTrack = true,
  playable?: { a: string; b: string; c?: string },
): Promise<{ store: EditorStore; preview: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load(
    [
      { key: 'clip-a', fileName: 'a.mp4', playbackUrl: playable?.a },
      { key: 'clip-b', fileName: 'b.mp4', playbackUrl: playable?.b },
      { key: 'clip-c', fileName: 'c.mp4', playbackUrl: playable?.c },
    ],
    new Map([
      ['clip-a', 5000],
      ['clip-b', 4000],
      ['clip-c', 4000],
    ]),
    manifest(withTrack),
  );

  const column = document.createElement('div');
  column.style.cssText = 'width: 393px; height: 720px';
  document.body.append(column);

  const preview = document.createElement('ve-preview');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(preview, { ctx });
  column.append(preview);

  mounted.push({ store, column });
  await (preview as StencilElement).componentOnReady?.();
  return { store, preview };
}

/**
 * The hidden elements the canvas draws FROM: the base track's first element - the clock until the
 * first cut, and the only one a post with one clip ever uses - then one per extra track, in track
 * order. The base track's second element is left out: see [baseSources].
 */
function sources(preview: HTMLElement): HTMLVideoElement[] {
  const first = preview.querySelector('video[data-deck="a"]') as HTMLVideoElement | null;
  return [...(first ? [first] : []), ...trackSources(preview)];
}

/** The base track's two elements, which take turns being the clock. */
function baseSources(preview: HTMLElement): HTMLVideoElement[] {
  return [...preview.querySelectorAll('video[data-deck]')] as HTMLVideoElement[];
}

/** One element per extra video track, in track order. */
function trackSources(preview: HTMLElement): HTMLVideoElement[] {
  return [...preview.querySelectorAll('video:not([data-deck])')] as HTMLVideoElement[];
}

function composite(preview: HTMLElement): HTMLCanvasElement {
  const canvas = preview.querySelector('canvas.pv__canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('the preview drew no canvas');
  return canvas;
}

/**
 * One pixel of the composited frame, at a FRACTION of it.
 *
 * Fractions, because how many device pixels the canvas holds is the compositor's business - it is
 * sized to the stage and the screen's pixel ratio, not to the post - while where a layer lands is
 * the same fraction of it on every device.
 */
function pixelAt(preview: HTMLElement, fx: number, fy: number): [number, number, number] {
  const canvas = composite(preview);
  const read = document.createElement('canvas');
  read.width = canvas.width;
  read.height = canvas.height;
  const ctx = read.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(canvas, 0, 0);
  const x = Math.min(canvas.width - 1, Math.max(0, Math.round(fx * canvas.width)));
  const y = Math.min(canvas.height - 1, Math.max(0, Math.round(fy * canvas.height)));
  const data = ctx.getImageData(x, y, 1, 1).data;
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
}

/** Which of the fixture colours is at a spot, or 'black' for the frame showing through. */
function colourAt(preview: HTMLElement, fx: number, fy: number): 'red' | 'blue' | 'green' | 'black' | 'other' {
  const [r, g, b] = pixelAt(preview, fx, fy);
  if (r > 150 && g < 90 && b < 90) return 'red';
  if (b > 150 && r < 90 && g < 90) return 'blue';
  if (g > 150 && r < 90 && b < 90) return 'green';
  if (r < 60 && g < 60 && b < 60) return 'black';
  return 'other';
}

/** One element's stand-in state: where it is, every position written to it, every load asked of it. */
interface Stood {
  /** Where the element was last PUT. While playing, its clock runs on from here; see [standInForFiles]. */
  position: number;
  at: number[];
  loads: number[];
  paused: boolean;
  /** When playback last started, in wall time, or 0 while paused. */
  playedAt: number;
  /** What `src` was last set to. Kept here rather than on the element; see [standInForFiles]. */
  src: string;
}

/**
 * Stands in for the FILES, so the player's state machine can run to its end with nothing to decode.
 *
 * Nothing here decides anything. Every element is given the state a loaded one would have, `load()`
 * answers with the metadata event the player's whole load path hangs off, a written position
 * answers with the `seeked` the player waits on, and `play`/`pause` move `paused` and fire the two
 * events the transport is read from. Without that last part nothing could be tested with the
 * transport RUNNING: a `<video>` with no file rejects `play()`, so the player sat in a seek that
 * never landed and every test was of a preview standing still.
 *
 * Its clock RUNS: a playing element's `currentTime` is where it was put plus the wall time since,
 * at whatever `playbackRate` the player set. That is what lets a test play a post from end to end -
 * the base track reaching its own last frame is the moment half of the transport's decisions are
 * made, and without a clock nothing ever reached it.
 *
 * It patches the prototype rather than the elements because a track's `<video>` is created by a
 * render and loaded in the same tick, so there is no moment in between to reach that one in.
 *
 * `src` is kept by the stand-in too, rather than written to the element: assigning it runs the
 * element's REAL load algorithm, which answers a file that is not there with an `error` a task later
 * - and the player rightly marks a base element that reported one as unable to play its clip.
 */
function standInForFiles(): { of: (el: HTMLMediaElement) => Stood; restore: () => void } {
  const proto = HTMLMediaElement.prototype;
  const was = {
    currentTime: Object.getOwnPropertyDescriptor(proto, 'currentTime')!,
    readyState: Object.getOwnPropertyDescriptor(proto, 'readyState')!,
    duration: Object.getOwnPropertyDescriptor(proto, 'duration')!,
    paused: Object.getOwnPropertyDescriptor(proto, 'paused')!,
    src: Object.getOwnPropertyDescriptor(proto, 'src')!,
    load: proto.load,
    play: proto.play,
    pause: proto.pause,
  };
  const state = new WeakMap<HTMLMediaElement, Stood>();
  const of = (el: HTMLMediaElement): Stood => {
    const one = state.get(el) ?? { position: 0, at: [], loads: [], paused: true, playedAt: 0, src: '' };
    state.set(el, one);
    return one;
  };
  const clock = (el: HTMLMediaElement): number => {
    const one = of(el);
    if (one.paused) return one.position;
    return one.position + ((performance.now() - one.playedAt) / 1000) * (el.playbackRate || 1);
  };

  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return clock(this);
    },
    set(this: HTMLMediaElement, value: number) {
      const one = of(this);
      one.position = value;
      one.playedAt = performance.now();
      one.at.push(value);
      // The event the player's seek watchdog exists to survive the absence of. Fired, the player
      // moves on at once instead of waiting out the watchdog on every single seek.
      queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
    },
  });
  Object.defineProperty(proto, 'readyState', { configurable: true, get: () => 4 /* HAVE_ENOUGH_DATA */ });
  Object.defineProperty(proto, 'duration', { configurable: true, get: () => DURATION_S });
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return of(this).src;
    },
    set(this: HTMLMediaElement, value: string) {
      of(this).src = value;
    },
  });
  Object.defineProperty(proto, 'paused', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return of(this).paused;
    },
  });
  // The real one is not called: with no file behind the src it would only end in an error event,
  // which the player would rightly read as a clip that cannot be played.
  proto.load = function (this: HTMLMediaElement) {
    of(this).loads.push(of(this).position);
    queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
  };
  proto.play = function (this: HTMLMediaElement) {
    const one = of(this);
    if (one.paused) {
      one.position = clock(this);
      one.playedAt = performance.now();
      one.paused = false;
      queueMicrotask(() => this.dispatchEvent(new Event('play')));
    }
    return Promise.resolve();
  };
  proto.pause = function (this: HTMLMediaElement) {
    const one = of(this);
    if (!one.paused) {
      // Where it actually got to, so a pause does not rewind it to where it was started from.
      one.position = clock(this);
      one.paused = true;
      queueMicrotask(() => this.dispatchEvent(new Event('pause')));
    }
  };

  return {
    of,
    restore() {
      Object.defineProperty(proto, 'currentTime', was.currentTime);
      Object.defineProperty(proto, 'readyState', was.readyState);
      Object.defineProperty(proto, 'duration', was.duration);
      Object.defineProperty(proto, 'paused', was.paused);
      Object.defineProperty(proto, 'src', was.src);
      proto.load = was.load;
      proto.play = was.play;
      proto.pause = was.pause;
    },
  };
}

/**
 * The picker: the page goes away and comes back. What that costs is in [onPageShown], and the whole
 * of what the editor can see of it is these two events.
 */
async function pageAway(): Promise<void> {
  await pageIs('hidden');
  await pageIs('visible');
}

async function pageIs(state: DocumentVisibilityState): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
  await frames(2);
}

/** What the picker's result does to the post: the second source, on a layer of its own, at the top. */
function addSecondVideo(store: EditorStore): void {
  store.addVideoTrack(defaultClipEdit('clip-b', 4000, 'seg-b'));
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise(resolve => requestAnimationFrame(resolve));
}

const standIns: { restore: () => void }[] = [];

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.dispose();
    column.remove();
  }
  for (const stand of standIns.splice(0)) stand.restore();
  for (const url of revoke.splice(0)) URL.revokeObjectURL(url);
  // Back to the document's own, which is what deleting an own property uncovers.
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('ve-preview composites the post', () => {
  it(
    'draws every layer where its rectangle says, over the one below it',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000'), b: await makeSourceVideo('#0000ff') };
      const { store, preview } = await mount(true, files);

      // Top and bottom: the base fills the upper half, the layer the lower one. A preset writes a
      // rectangle onto every clip of both tracks without moving the playhead by a millisecond,
      // which is the edit nothing in the player can hear about.
      store.applyLayoutPreset('track-1', 'splitTopBottom', 'Top and bottom');

      await until('both layers to be composited', () => colourAt(preview, 0.5, 0.25) === 'red' && colourAt(preview, 0.5, 0.75) === 'blue', PIXEL_TIMEOUT_MS);
      // And each stops at its own rectangle rather than running on across the frame.
      expect(colourAt(preview, 0.5, 0.1)).toBe('red');
      expect(colourAt(preview, 0.5, 0.9)).toBe('blue');
    },
    PIXEL_TIMEOUT_MS,
  );

  it(
    'draws a layer that hangs off the frame, cut off at the edge',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000'), b: await makeSourceVideo('#0000ff') };
      const { store, preview } = await mount(false, files);

      // Half a frame wide, dragged so half of IT is off the left edge: a quarter of the frame is
      // covered and the rest of the video is simply not there. The free canvas, in one picture.
      store.commitClipFraming('seg-a', { rect: { x: -0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }, 'Move');

      await until('the video to be composited', () => colourAt(preview, 0.1, 0.5) === 'red', PIXEL_TIMEOUT_MS);
      // Past its right edge, a quarter of the way across: the frame's own black and nothing else.
      expect(colourAt(preview, 0.4, 0.5)).toBe('black');
      expect(colourAt(preview, 0.5, 0.1)).toBe('black');
    },
    PIXEL_TIMEOUT_MS,
  );

  /*
   * Swap is the one operation that moves a layer's clips to the OTHER layer, and the compositor
   * draws the base track first always - that is the z order, the base being 0 with nothing below
   * it, in the preview exactly as in both native renders. So a swap that carried each arrangement
   * along with the clips that were in it put the picture covering the whole frame on top: a corner
   * inset then sat behind it, drawn and invisible, and the customer watched one of their two videos
   * vanish.
   */
  it(
    'leaves the inset on top, rather than behind the layer that fills the frame',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000'), b: await makeSourceVideo('#0000ff') };
      const { store, preview } = await mount(true, files);

      store.applyLayoutPreset('track-1', 'pipBR', 'Corner bottom right');
      // Where the inset actually landed, read back rather than written out here: the corner is a
      // fraction of the frame's own shape and the frame is a choice.
      const inset = store.manifest.value.videoTracks[0].clips[0].rect!;
      const spot = { x: inset.x + inset.w / 2, y: inset.y + inset.h / 2 };

      await until('the inset to be composited over the base', () => colourAt(preview, spot.x, spot.y) === 'blue', PIXEL_TIMEOUT_MS);
      expect(colourAt(preview, 0.5, 0.2)).toBe('red');

      store.swapTrackZ('track-1');

      // The same corner, with the other source in it now - and the layer that fills the frame is
      // still underneath, or there would be nothing in the corner to see.
      await until('the swap to reach the frame', () => colourAt(preview, spot.x, spot.y) === 'red', PIXEL_TIMEOUT_MS);
      expect(colourAt(preview, 0.5, 0.2)).toBe('blue');
    },
    PIXEL_TIMEOUT_MS,
  );

  it(
    'holds the last picture when a layer loses its frame, rather than going black',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000'), b: await makeSourceVideo('#0000ff') };
      const { preview } = await mount(false, files);
      await until('the video to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);

      // What a `<video>` reports for the whole of a source change: no frame, no size. The elements
      // are sources now, so this is the ONLY thing the compositor can see of a clip change - and
      // painting the post without them is the black flash the hold canvases used to cover.
      const video = sources(preview)[0];
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => 0 });
      Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 0 });

      /*
       * Repaints, asked for the way playback asks for them.
       *
       * It is the frame loop this needs and a test runner is not granted autoplay, so the redraws
       * are asked for directly - one per event, which is what the loop does with an element in this
       * state. Paused and undisturbed the canvas keeps its last frame whatever the elements do, so a
       * test that did not repaint would pass over the bug.
       */
      const repaint = setInterval(() => video.dispatchEvent(new Event('seeked')), 60);
      try {
        await frames(6);
        // Still red. A canvas keeps whatever was last drawn into it, and that is the whole reason
        // the per-element hold canvases could go.
        expect(colourAt(preview, 0.5, 0.5)).toBe('red');

        // And STILL held well past the bound the other layers are held back by: that bound is for a
        // frame with a hole in it, never for a frame with nothing in it. Waiting past it is the
        // whole point - the black arrived about two seconds in, which reads as the preview playing
        // and then dying rather than as a load taking its time.
        await new Promise((resolve) => setTimeout(resolve, 2600));
        expect(colourAt(preview, 0.5, 0.5)).toBe('red');
      } finally {
        clearInterval(repaint);
      }
    },
    PIXEL_TIMEOUT_MS,
  );

  it(
    'colours the picture and leaves the letterbox bars BLACK, as the export does',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000'), b: await makeSourceVideo('#0000ff') };
      const { store, preview } = await mount(false, files);

      // A square source in a 9:16 frame, drawn `contain`: black top and bottom. A post FILLS its
      // frame now, so the bars are what a tap on Fit puts back - which is the customer's own route
      // to the thing being tested, and the reason the tap is here rather than a manifest written by
      // hand. The colour work is the compositor's, and the same call the export makes.
      store.select(null);
      store.toggleFit();
      expect(store.manifest.value.fit).toBe('contain');
      await until('the video to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);
      const wasRed = pixelAt(preview, 0.5, 0.5);

      // A filter with a TINT in it, which is exactly the op CSS has no filter function for and the
      // one the old preview painted as a translucent div over the picture's box.
      store.setFilter('cool');
      await until(
        'the filter to reach the frame',
        () => Math.abs(pixelAt(preview, 0.5, 0.5)[2] - wasRed[2]) > 8,
        PIXEL_TIMEOUT_MS,
      );

      // The bar is a piece of the output standing for no piece of the source: it is the cleared
      // background, and a tint applied to the finished frame instead would turn every bar blue.
      const bar = pixelAt(preview, 0.5, 0.02);
      expect(Math.max(...bar)).toBeLessThan(12);
    },
    PIXEL_TIMEOUT_MS,
  );
});

describe('ve-preview adding a second video while paused', () => {
  it('points the base element at its source again once the picker has given the page back', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { store, preview } = await mount(false);
    const baseEl = sources(preview)[0];
    await until('the base to load its clip', () => files.of(baseEl).loads.length > 0);
    await until('that load to end on a frame', () => files.of(baseEl).at.length > 0);
    const settled = { loads: files.of(baseEl).loads.length, at: files.of(baseEl).at.length };

    // The tap: a picker, which hides the page, and the source it comes back with.
    await pageAway();
    addSecondVideo(store);

    // A load, because a seek cannot cure what the page being hidden did to this element, and the
    // player cannot tell the two apart from in here: whatever it was showing, it is showing it
    // again only once the source has been put back on.
    await until('the base to be pointed at its source again', () => files.of(baseEl).loads.length > settled.loads);
    await until('the base to be asked for a frame', () => files.of(baseEl).at.length > settled.at);
    expect(files.of(baseEl).at.at(-1)).toBe(0);
    // The element that was reloaded is the one the first render made. The second layer arriving
    // beside it must not have made the vdom hand the player a different one.
    expect(sources(preview)[0]).toBe(baseEl);
  });

  it('asks the second layer for a frame as its source lands, at a playhead it is already on', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { store, preview } = await mount(false);
    const baseEl = sources(preview)[0];
    await until('the base to settle on its clip', () => files.of(baseEl).at.length > 0);

    addSecondVideo(store);

    await until('the second element to be written out', () => sources(preview).length > 1);
    const extraEl = sources(preview)[1];
    await until('the second layer to be asked for a frame', () => files.of(extraEl).at.length > 0);
    // Nothing had moved it: a new layer starts at 0 with the playhead on 0, so the only seek that
    // can have made this element present anything is the one a fresh source always gets.
    expect(store.playheadMs.value).toBe(0);
    expect(files.of(extraEl).at[0]).toBe(0);
  });
});

describe('ve-preview playing the tail past the base track', () => {
  /*
   * A customer put a second video on a layer of its own, pulled the end of the post out past the
   * base track's last frame, and pressed Play. The base ran to its end and everything stopped
   * there: the second layer's last seconds never played, in a post whose own timeline was plainly
   * still showing them.
   *
   * The base element is the clock, and in the tail it has nothing to play - so `advance` treated
   * the end of the base as the end of the post, paused, and threw the playhead to the end. What
   * runs the tail now is a wall clock; see [PreviewPlayer.tail].
   */
  it('keeps playing past the base track, to the end of the post', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { store, preview } = await mount();
    await until('the base to settle on its clip', () => files.of(sources(preview)[0]).at.length > 0);
    await frames(3);

    // The customer's own post: the base's footage is 5s, the end is pulled out to 8, and a layer
    // is still on the frame after the base has run out.
    store.setPostDuration(8000);
    expect(store.baseMs.value).toBe(5000);
    expect(store.totalMs.value).toBe(8000);

    // Playing INTO the tail rather than starting in it, which is how it is met.
    store.seek(4500);
    store.play();
    await until('playback to start', () => store.playing.value, 3000);
    await until('the base track to run out', () => store.playheadMs.value >= 5000, 5000);

    // THROUGH the tail and not to the end of it. Stopping looked exactly like this used to: the
    // playhead was thrown to `totalMs` the instant the base ran out, so a test that only asked
    // whether it had moved past the base would have passed over the bug.
    await until('the tail to keep running', () => store.playheadMs.value > 5300, 3000);
    expect(store.playheadMs.value).toBeLessThan(7500);
    expect(store.playing.value).toBe(true);

    await until('the post to reach its own end', () => store.playheadMs.value >= 8000, 8000);
    await until('the transport to stop there', () => !store.playing.value, 2000);
    expect(store.playheadMs.value).toBe(8000);
  }, 25_000);

  it('stops at the end of the base when the post is NOT stretched', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { store, preview } = await mount();
    await until('the base to settle on its clip', () => files.of(sources(preview)[0]).at.length > 0);
    await frames(3);

    // No tail: the end of the base IS the end of the post, and nothing may invent a clock for it.
    expect(store.totalMs.value).toBe(store.baseMs.value);
    store.seek(4500);
    store.play();

    // Playing is asserted BEFORE stopping is: `playing` follows the element's own `play` event, so
    // asking whether it has stopped before it has started is answered yes by a race.
    await until('playback to start', () => store.playing.value, 3000);
    await until('playback to stop at the end of the post', () => !store.playing.value, 5000);
    expect(store.playheadMs.value).toBe(5000);
  }, 15_000);
});

describe('ve-preview after the page has been away', () => {
  /*
   * The tests above go through Add video, which is how the bug was found: the picker's page-away
   * and an edit arriving on the same tap. These two take the edit away. The page goes and comes
   * back, nothing about the post has changed, and the only thing in the package that can ask either
   * element for anything at that moment is [onPageShown] and the revive behind it.
   */
  it('points the base element at its source again, with no edit to prompt it', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { preview } = await mount(false);
    const baseEl = sources(preview)[0];
    await until('the base to load its clip', () => files.of(baseEl).loads.length > 0);
    await until('that load to end on a frame', () => files.of(baseEl).at.length > 0);
    await frames(3);
    const settled = files.of(baseEl).loads.length;

    await pageAway();

    // A load and not a seek: WebKit throws a hidden page's paused element's decoded frame away and
    // answers every seek afterwards by presenting nothing, so the source has to go on again.
    await until('the base to be pointed at its source again', () => files.of(baseEl).loads.length > settled);
  });

  it('points the second layer at its source again too', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { preview } = await mount();
    const extraEl = sources(preview)[1];
    await until('the second layer to load its clip', () => files.of(extraEl).loads.length > 0);
    await frames(3);
    const settled = files.of(extraEl).loads.length;

    await pageAway();

    await until('the second layer to be pointed at its source again', () => files.of(extraEl).loads.length > settled);
  });
});

describe('ve-preview with several layers', () => {
  /*
   * There is no cap on how many videos are drawn.
   *
   * There used to be: two elements, the base and the FRONT-MOST layer, so a post with three showed
   * the first and the third and nothing said where the second had gone. Somebody who split a clip
   * and pushed half of it onto a layer of its own watched it disappear from the preview while the
   * timeline went on showing it and the export went on including it.
   */
  it('keeps one source element per track, however many there are', async () => {
    const { store, preview } = await mount(false);
    store.addVideoTrack(defaultClipEdit('clip-b', 4000, 'seg-b'));
    store.addVideoTrack(defaultClipEdit('clip-b', 4000, 'seg-c'));
    await frames(4);

    // Both layers, not only the front-most one - and the base track's own two, which take turns
    // being the clock so a cut is never a load and a transition has both of its clips.
    expect(trackSources(preview).length).toBe(2);
    expect(baseSources(preview).length).toBe(2);
    expect(preview.querySelectorAll('video').length).toBe(4);
    expect(store.videoTrackRows.value.length).toBe(2);
  });

  it(
    'composites all of them, not just the top one',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = {
        a: await makeSourceVideo('#ff0000'),
        b: await makeSourceVideo('#0000ff'),
        c: await makeSourceVideo('#00ff00'),
      };
      const { store, preview } = await mount(true, files);
      // A third video, on a layer of its own over the other two. Three sources and three colours,
      // because two layers of the same file cannot say which of them is missing.
      store.addVideoTrack(defaultClipEdit('clip-c', 4000, 'seg-c'));
      await frames(2);

      // Each in a band of its own, over the base. The ids are read back rather than written out:
      // what a segment is called once it is on a track is the store's business.
      const [lower, upper] = store.videoTrackRows.value;
      store.commitClipFraming(lower.clips[0].id, { rect: { x: 0, y: 0.4, w: 1, h: 0.2 }, fit: 'cover' }, 'Move');
      store.commitClipFraming(upper.clips[0].id, { rect: { x: 0, y: 0.1, w: 1, h: 0.2 }, fit: 'cover' }, 'Move');

      await until(
        'all three layers to be composited',
        () =>
          colourAt(preview, 0.5, 0.2) === 'green' &&
          colourAt(preview, 0.5, 0.5) === 'blue' &&
          // Inside the base's own picture and below both bands - the base is a square source drawn
          // `contain` on a 9:16 frame, so the last fifth of the frame is its letterbox bar.
          colourAt(preview, 0.5, 0.7) === 'red',
        PIXEL_TIMEOUT_MS,
      );
    },
    PIXEL_TIMEOUT_MS,
  );

  it("keeps a layer's element while the playhead is outside its window", async () => {
    const { store, preview } = await mount(false);
    // A layer that starts a second in, so the playhead at 0 is in the gap before it.
    store.addVideoTrack(defaultClipEdit('clip-b', 2000, 'seg-b'));
    await frames(3);
    const before = sources(preview)[1];
    store.setTrackStart(store.videoTrackRows.value[0].id, 1000);
    await frames(4);

    // The SAME element, kept rather than torn down: a teardown costs another load every time the
    // playhead crosses the track's start. It draws nothing meanwhile - the compositor is handed the
    // layers under the playhead and this track has none - but it keeps its source and its decoder.
    expect(sources(preview)[1]).toBe(before);
    expect(store.previewLayers.value.some((layer) => layer.trackId !== null)).toBe(false);
  });
});

/**
 * Counts the preview's renders, from the hook every one of them ends in.
 *
 * Through Stencil's own host ref, because in the lazy build the element and the component are two
 * objects and nothing else hands the component out. Stencil looks `componentDidRender` up by name
 * on the instance at the end of every render, so a wrapper put on the instance is the one it calls.
 * A render that changes nothing on the page is exactly what is being counted, and no DOM observer
 * can see one of those.
 *
 * Not by the host ref's `$lazyInstance$`: `npm test` builds with `--prod`, which renames every
 * `$...$` field of Stencil's to a letter, so that name is only there in a dev build. What survives
 * the minifier is the method both ends are given: the instance is the one object on the host ref,
 * other than the element itself, whose own `__stencil__getHostRef` hands back that same host ref.
 */
function countRenders(preview: HTMLElement): () => number {
  type WithHostRef = { __stencil__getHostRef?: () => object };
  type Instance = WithHostRef & { componentDidRender?: () => void };
  const hostRef = (preview as HTMLElement & WithHostRef).__stencil__getHostRef?.();
  const instance =
    hostRef &&
    Object.values(hostRef).find(
      (v): v is Instance => typeof v === 'object' && v !== null && v !== preview && (v as WithHostRef).__stencil__getHostRef?.() === hostRef,
    );
  const original = instance?.componentDidRender;
  if (!instance || !original) throw new Error('no component instance to count the renders of');
  let count = 0;
  instance.componentDidRender = function (this: Instance) {
    count += 1;
    original.call(this);
  };
  return () => count;
}

describe('ve-preview while only the playhead moves', () => {
  /*
   * The store rebuilds its list of the layers on screen on every playhead write - thirty a second
   * while playing, one per step of a scrub - because where each layer has got to in its file moves
   * with it. The selection box asks that list whether the selected video is on screen, and it used
   * to be handed a new copy of it on every one of those writes: with a video on a layer selected,
   * the whole preview was rebuilt and diffed thirty times a second with nothing on it having moved.
   */
  it('does not re-render the preview around a selected layer', async () => {
    const { store, preview } = await mount(true);
    const layer = store.videoTrackRows.value[0].clips[0].id;
    store.select({ kind: 'clip', id: layer });
    await frames(5);
    expect(preview.querySelector('.pv__select')).not.toBeNull();

    const renders = countRenders(preview);
    // Inside the layer's four seconds, where the box is drawn with its handles.
    for (let i = 1; i <= 10; i += 1) {
      store.playheadMs.value = i * 300;
      await frames(1);
    }
    await frames(2);
    expect(renders()).toBe(0);

    // Past the layer's end and over the base alone, where the box is ghosted: the list of layers
    // on screen is an EMPTY one there, and was a new empty one on every write.
    store.playheadMs.value = 4100;
    await until('the box to be ghosted', () => preview.querySelector('.pv__select--ghost') !== null);
    await frames(2);
    const settled = renders();
    for (let i = 1; i <= 8; i += 1) {
      store.playheadMs.value = 4100 + i * 100;
      await frames(1);
    }
    await frames(2);
    expect(renders()).toBe(settled);

    // And it still repaints when something the box is drawn from does change.
    store.commitClipFraming(layer, { rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }, 'Move');
    await until('the moved box to be drawn', () => renders() > settled);
  });
});

describe('ve-preview cropping one side at a time', () => {
  /*
   * A crop used to be a pan and a pinch and nothing else: the window kept whatever shape the ratio
   * chips gave it, so the only way to take a strip off the top of a shot was to pick a ratio that
   * happened to do it and then pan. Every edge of the window is draggable now, and each one moves
   * its own side of the crop with the other three left exactly where they are.
   */

  /** One finger, pressed on the frame, dragged, and lifted - past the slop that makes it a drag. */
  async function dragBy(preview: HTMLElement, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
    const stage = preview.querySelector('.pv__stage') as HTMLElement;
    const at = (x: number, y: number, type: string) =>
      stage.dispatchEvent(
        new PointerEvent(type, { pointerId: 1, isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }),
      );
    at(from.x, from.y, 'pointerdown');
    await frames(1);
    // In two steps, so the gesture passes the tap slop and is promoted to a drag before it lands.
    at(from.x + dx / 2, from.y + dy / 2, 'pointermove');
    await frames(1);
    at(from.x + dx, from.y + dy, 'pointermove');
    await frames(2);
    at(from.x + dx, from.y + dy, 'pointerup');
    await frames(2);
  }

  /** Where the crop window is on screen, which is what the fingers aim at. */
  function windowBox(preview: HTMLElement): DOMRect {
    const el = preview.querySelector('.pv__crop') as HTMLElement | null;
    if (!el) throw new Error('the crop window is not on screen');
    return el.getBoundingClientRect();
  }

  async function openCrop(files: { a: string; b: string }): Promise<{ store: EditorStore; preview: HTMLElement }> {
    const { store, preview } = await mount(false, files);
    await until('the video to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);
    // The source's shape has to have arrived: a crop is a fraction of the source, and the window is
    // not drawn at all until the preview knows what shape that is.
    await until('the source shape to arrive', () => store.sourceAspect.value > 0, 5000);
    store.select({ kind: 'clip', id: 'seg-a' });
    store.openPanel('crop');
    await until('the crop window to be drawn', () => !!preview.querySelector('.pv__crop'), 3000);
    return { store, preview };
  }

  it(
    'takes a strip off the TOP when the top edge is dragged, and leaves the other three sides alone',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000'), b: await makeSourceVideo('#0000ff') };
      const { store, preview } = await openCrop(files);

      const box = windowBox(preview);
      await dragBy(preview, { x: box.left + box.width / 2, y: box.top }, 0, 40);

      const crop = store.manifest.value.clips[0].crop;
      expect(crop, 'the drag wrote a crop').toBeDefined();
      // The top came down; the bottom and both sides are where they were. A pinch could not have
      // produced this - it keeps the shape and moves all four.
      expect(crop!.y).toBeGreaterThan(0.02);
      expect(crop!.y + crop!.h).toBeCloseTo(1, 2);
      expect(crop!.x).toBeCloseTo(0, 2);
      expect(crop!.x + crop!.w).toBeCloseTo(1, 2);
    },
    PIXEL_TIMEOUT_MS,
  );

  it(
    'takes a strip off the LEFT when the left edge is dragged',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000'), b: await makeSourceVideo('#0000ff') };
      const { store, preview } = await openCrop(files);

      const box = windowBox(preview);
      await dragBy(preview, { x: box.left, y: box.top + box.height / 2 }, 30, 0);

      const crop = store.manifest.value.clips[0].crop;
      expect(crop, 'the drag wrote a crop').toBeDefined();
      expect(crop!.x).toBeGreaterThan(0.02);
      expect(crop!.x + crop!.w).toBeCloseTo(1, 2);
      expect(crop!.y).toBeCloseTo(0, 2);
      expect(crop!.y + crop!.h).toBeCloseTo(1, 2);
    },
    PIXEL_TIMEOUT_MS,
  );

  it(
    'moves the edge WITH the finger, and leaves the other three where they are on screen',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000'), b: await makeSourceVideo('#0000ff') };
      const { preview } = await openCrop(files);

      const before = windowBox(preview);
      const by = 40;
      await dragBy(preview, { x: before.left + before.width / 2, y: before.top }, 0, by);
      const after = windowBox(preview);

      /*
       * The whole of what was wrong. The window used to be drawn where the FINISHED picture lands,
       * and the finished picture re-fits itself into the clip's rectangle every time the crop's
       * shape changes - so dragging the top edge down rescaled and recentred the lot, the edge slid
       * out from under the finger, and the window plainly did something other than what was asked.
       *
       * It is drawn over a STAGE now, which the crop cannot move, so an edge goes exactly as far as
       * the finger took it and the other three stay put.
       */
      expect(after.top - before.top).toBeCloseTo(by, 0);
      expect(after.bottom).toBeCloseTo(before.bottom, 0);
      expect(after.left).toBeCloseTo(before.left, 0);
      expect(after.right).toBeCloseTo(before.right, 0);
    },
    PIXEL_TIMEOUT_MS,
  );

  it(
    'still PANS the picture when the finger lands in the middle of the window',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000'), b: await makeSourceVideo('#0000ff') };
      const { store, preview } = await openCrop(files);
      // Something to pan: a crop of the whole frame has nowhere to go.
      store.commitClipFraming('seg-a', { crop: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } }, 'Crop');
      await frames(3);

      const box = windowBox(preview);
      const before = store.manifest.value.clips[0].crop!;
      await dragBy(preview, { x: box.left + box.width / 2, y: box.top + box.height / 2 }, 0, 30);

      const after = store.manifest.value.clips[0].crop!;
      // A pan moves the window and keeps its size, which is the half an edge drag must not become.
      expect(after.w).toBeCloseTo(before.w, 4);
      expect(after.h).toBeCloseTo(before.h, 4);
      expect(after.y).not.toBeCloseTo(before.y, 3);
    },
    PIXEL_TIMEOUT_MS,
  );
});

describe('ve-preview on a free canvas', () => {
  /*
   * A video is managed on the frame the way a sticker is, which means it has to SAY it is selected
   * and offer the same corners. The box is drawn around the clip's rectangle and not the picture
   * inside it: those differ the moment a clip is letterboxed, and a box around the picture would
   * drift away from the thing the fingers actually move. Chrome, so it is still DOM.
   */
  it('draws a box and handles around the selected clip, where its rectangle is', async () => {
    const { store, preview } = await mount(false);
    store.commitClipFraming('seg-a', { rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }, 'Move');
    store.select({ kind: 'clip', id: 'seg-a' });
    await frames(3);

    const select = preview.querySelector('.pv__select') as HTMLElement;
    expect(select).not.toBeNull();

    const stage = (preview.querySelector('.pv__frame') as HTMLElement).getBoundingClientRect();
    const box = select.getBoundingClientRect();
    // Half the frame across, centred: the rectangle the customer placed, not the whole video.
    expect(box.width).toBeCloseTo(stage.width * 0.5, 0);
    expect(box.left + box.width / 2).toBeCloseTo(stage.left + stage.width / 2, 0);

    // The corner that resizes and turns it, and the corner that puts it back over the frame. No
    // duplicate corner: copying a segment is a timeline operation, not something done to a picture.
    expect(select.querySelector('[data-handle="transform"]')).not.toBeNull();
    expect(select.querySelector('[data-handle="delete"]')?.getAttribute('aria-label')).toBe(
      'Fit the video to the frame',
    );
    expect(select.querySelector('[data-handle="edit"]')).toBeNull();
  });

  /*
   * WebKit reports a button's box as its own joined to those of its in-flow children, and puts a
   * child with a transform - every glyph here has one - up and to the left of where it is drawn. On
   * iOS that joined box is what VoiceOver and a UI test aim at, so a tap on Duplicate layer landed
   * on the picture. Out of flow the glyph adds nothing to the handle's box, which only WebKit's
   * accessibility tree could show; what Chrome can show is that nothing moved on the screen for it.
   */
  it('keeps each corner’s glyph out of the corner’s own box, still in the middle of it', async () => {
    const { store, preview } = await mount(false);
    store.commitClipFraming('seg-a', { rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5, rotationDeg: 30 } }, 'Move');
    store.select({ kind: 'clip', id: 'seg-a' });
    await frames(3);

    const handles = [...preview.querySelectorAll<HTMLElement>('.pv__handle')];
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      const glyph = handle.querySelector('ve-icon') as HTMLElement;
      expect(getComputedStyle(glyph).position).toBe('absolute');
      const box = handle.getBoundingClientRect();
      const drawn = glyph.getBoundingClientRect();
      expect(drawn.left + drawn.width / 2).toBeCloseTo(box.left + box.width / 2, 1);
      expect(drawn.top + drawn.height / 2).toBeCloseTo(box.top + box.height / 2, 1);
    }
  });

  it('puts the video back over the whole frame from that corner', async () => {
    const { store, preview } = await mount(false);
    store.commitClipFraming('seg-a', { rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }, 'Move');
    store.select({ kind: 'clip', id: 'seg-a' });
    await frames(3);

    (preview.querySelector('[data-handle="delete"]') as HTMLButtonElement).click();
    await frames(3);

    // The rectangle is GONE rather than written out as the whole frame: a clip with no framing
    // fields at all is what every engine's fast path tests for, and what posts with no re-encode.
    expect(store.manifest.value.clips[0]).not.toHaveProperty('rect');
  });

  it('cuts the frame at its own edge, over the picture', async () => {
    const { preview } = await mount(false);
    await frames(3);
    const frame = preview.querySelector('.pv__frame') as HTMLElement;
    expect(getComputedStyle(frame).overflow).toBe('hidden');
    // The edge is drawn over the canvas: on a black page against a black frame there is otherwise
    // nothing to say where the finished post ends.
    expect(getComputedStyle(frame, '::after').borderTopWidth).toBe('1px');
    // And it is a rectangle. The render has no corner radius to give, so a rounded preview would be
    // showing a shape the file does not come back as.
    expect(getComputedStyle(frame).borderTopLeftRadius).toBe('0px');
  });
});
describe('ve-preview selecting a video by touching it', () => {
  /*
   * Touching a picture picks it up. The preview used to answer a tap on the frame by playing and
   * pausing, which left the timeline as the only way to reach a segment at all - and no way at all
   * to say WHICH of two overlapping pictures was meant. So the videos under the playhead are hit
   * tested like any other layer, front to back, and the transport keeps its own button.
   */

  /** One finger, down and up in the same place, well inside the tap window. */
  async function tapAt(preview: HTMLElement, x: number, y: number): Promise<void> {
    const stage = preview.querySelector('.pv__stage') as HTMLElement;
    const at = (type: string) =>
      stage.dispatchEvent(
        new PointerEvent(type, { pointerId: 1, isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }),
      );
    at('pointerdown');
    await frames(1);
    at('pointerup');
    await frames(2);
  }

  /** The middle of a rectangle given as fractions of the frame, in client pixels. */
  function middleOf(preview: HTMLElement, rect: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
    const stage = (preview.querySelector('.pv__stage') as HTMLElement).getBoundingClientRect();
    return {
      x: stage.left + (rect.x + rect.w / 2) * stage.width,
      y: stage.top + (rect.y + rect.h / 2) * stage.height,
    };
  }

  const WHOLE_FRAME = { x: 0, y: 0, w: 1, h: 1 };

  it('selects the video under the finger rather than playing the post', async () => {
    const { store, preview } = await mount(false);
    await frames(3);

    const at = middleOf(preview, WHOLE_FRAME);
    await tapAt(preview, at.x, at.y);

    // The segment, not the transport. The base track carries no rectangle, so it answers for every
    // point on the frame - which is exactly what a post nobody has laid out should do.
    expect(store.selection.value).toEqual({ kind: 'clip', id: 'seg-a' });
    expect(store.playing.value).toBe(false);
  });

  it('selects the TOPMOST video where two of them overlap', async () => {
    const { store, preview } = await mount(true);
    // The layer takes the left half; the base keeps the whole frame underneath it.
    store.commitClipFraming('seg-b', { rect: { x: 0, y: 0.25, w: 0.5, h: 0.5 } }, 'Move');
    await frames(3);

    const onLayer = middleOf(preview, { x: 0, y: 0.25, w: 0.5, h: 0.5 });
    await tapAt(preview, onLayer.x, onLayer.y);
    // `track-1` is drawn over the base, so where the two overlap the finger gets the one on top.
    expect(store.selection.value).toEqual({ kind: 'clip', id: 'seg-b' });

    const onBase = middleOf(preview, { x: 0.5, y: 0.25, w: 0.5, h: 0.5 });
    await tapAt(preview, onBase.x, onBase.y);
    // Off the layer's rectangle the base is the only picture there, and it takes the touch.
    expect(store.selection.value).toEqual({ kind: 'clip', id: 'seg-a' });
  });

  it('leaves a second touch on the video it already selected alone', async () => {
    const { store, preview } = await mount(false);
    await frames(3);
    const at = middleOf(preview, WHOLE_FRAME);

    await tapAt(preview, at.x, at.y);
    expect(store.selection.value).toEqual({ kind: 'clip', id: 'seg-a' });

    await tapAt(preview, at.x, at.y);
    // Still held, and still paused. A finger resting on the frame in the middle of an edit must not
    // put the selection down or set the post playing.
    expect(store.selection.value).toEqual({ kind: 'clip', id: 'seg-a' });
    expect(store.playing.value).toBe(false);
  });
});

/* ============================================================================================ */
/* Transitions, and the joins between clips                                                     */
/* ============================================================================================ */

/**
 * A post of two clips, the second coming in over the last `transitionMs` of the first with `kind`,
 * or on a plain cut when `kind` is null.
 *
 * Silenced unless asked otherwise, which is also what lets a test runner play real footage at all:
 * it is never granted autoplay with sound, and a muted video may always play.
 */
async function mountPair(
  kind: string | null,
  files: { a: string; b: string },
  timing: { clipMs: number; transitionMs?: number },
  muted = true,
): Promise<{ store: EditorStore; preview: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  const incoming = defaultClipEdit('clip-b', timing.clipMs, 'seg-b');
  store.load(
    [
      { key: 'clip-a', fileName: 'a.mp4', playbackUrl: files.a },
      { key: 'clip-b', fileName: 'b.mp4', playbackUrl: files.b },
    ],
    new Map([
      ['clip-a', timing.clipMs],
      ['clip-b', timing.clipMs],
    ]),
    {
      ...emptyManifest(),
      originalMuted: muted,
      clips: [
        defaultClipEdit('clip-a', timing.clipMs, 'seg-a'),
        kind ? { ...incoming, transitionIn: { kind, durationMs: timing.transitionMs ?? 1000 } } : incoming,
      ],
    },
  );

  const column = document.createElement('div');
  column.style.cssText = 'width: 393px; height: 720px';
  document.body.append(column);
  const preview = document.createElement('ve-preview');
  Object.assign(preview, { ctx });
  column.append(preview);
  mounted.push({ store, column });
  await (preview as StencilElement).componentOnReady?.();
  return { store, preview };
}

/**
 * Every paint of the composite canvas, by wall time. The painter ends every frame it paints with one
 * `drawImage` of its GL frame onto the canvas on screen, so a frame the compositor HELD - declined to
 * paint, keeping what was there - is a gap in these. The component runs its own bundled copy of the
 * painter, which is why this listens on the canvas API rather than on the painter.
 */
function recordPaints(preview: HTMLElement): number[] {
  const canvas = composite(preview);
  const proto = CanvasRenderingContext2D.prototype;
  const original = proto.drawImage;
  const stamps: number[] = [];
  proto.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
    if (this.canvas === canvas) {
      const now = performance.now();
      // The 2D fallback draws a layer at a time; one frame is one paint however it was drawn.
      if (!stamps.length || now - stamps[stamps.length - 1] > 2) stamps.push(now);
    }
    return (original as (...a: unknown[]) => void).apply(this, args);
  } as typeof proto.drawImage;
  standIns.push({ restore: () => (proto.drawImage = original) });
  return stamps;
}

interface Sample {
  t: number;
  playheadMs: number;
  rgb: [number, number, number];
  /** Some base element has the incoming clip's file on it, with a frame to give. */
  incomingReady: boolean;
}

/** What was on screen at the middle of the frame on every animation frame, until stopped. */
function sampleFrames(preview: HTMLElement, store: EditorStore, incomingSrc: string): { samples: Sample[]; stop: () => void } {
  const samples: Sample[] = [];
  let live = true;
  const tick = () => {
    if (!live) return;
    samples.push({
      t: performance.now(),
      playheadMs: store.playheadMs.value,
      rgb: pixelAt(preview, 0.5, 0.5),
      incomingReady: baseSources(preview).some(video => video.src === incomingSrc && video.readyState >= 2),
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { samples, stop: () => (live = false) };
}

/** The wall-time stretch the playhead spent inside [fromMs, toMs]. */
function wallSpan(samples: readonly Sample[], fromMs: number, toMs: number): { t0: number; t1: number } {
  const inside = samples.filter(s => s.playheadMs >= fromMs && s.playheadMs <= toMs);
  if (!inside.length) throw new Error(`the playhead never got between ${fromMs} and ${toMs}`);
  return { t0: inside[0].t, t1: inside[inside.length - 1].t };
}

/** The longest the picture at the sampled spot stood still, in ms, while the playhead was in the range. */
function longestStill(samples: readonly Sample[], fromMs: number, toMs: number): number {
  const { t0, t1 } = wallSpan(samples, fromMs, toMs);
  const inside = samples.filter(s => s.t >= t0 && s.t <= t1);
  let longest = 0;
  let since = inside[0].t;
  for (let i = 1; i < inside.length; i++) {
    const [r, g, b] = inside[i].rgb;
    const [pr, pg, pb] = inside[i - 1].rgb;
    if (Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb) > 3) {
      longest = Math.max(longest, inside[i].t - since);
      since = inside[i].t;
    }
  }
  return Math.max(longest, t1 - since);
}

/**
 * Makes one element's seeks as slow as a phone's - 390-460 ms on the Redmi Note 7 - where a desktop's
 * land inside a frame. For `delayMs` after a position is written the element reports what a real
 * seek reports at once, HAVE_METADATA and the position it was sent to, and only then really seeks.
 * Undone by deleting the two own properties, which uncovers the prototype's again.
 */
function slowSeeks(video: HTMLVideoElement, delayMs: number): { restore: () => void } {
  const proto = HTMLMediaElement.prototype;
  const time = Object.getOwnPropertyDescriptor(proto, 'currentTime')!;
  const ready = Object.getOwnPropertyDescriptor(proto, 'readyState')!;
  let target: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => target ?? (time.get!.call(video) as number),
    set: (value: number) => {
      target = value;
      clearTimeout(timer);
      timer = setTimeout(() => {
        target = null;
        time.set!.call(video, value);
      }, delayMs);
    },
  });
  Object.defineProperty(video, 'readyState', {
    configurable: true,
    get: () => (target !== null ? 1 : (ready.get!.call(video) as number)),
  });
  return {
    restore() {
      clearTimeout(timer);
      Reflect.deleteProperty(video, 'currentTime');
      Reflect.deleteProperty(video, 'readyState');
    },
  };
}

/** The longest the compositor went without painting, in ms, while the playhead was in the range. */
function longestHold(paints: readonly number[], samples: readonly Sample[], fromMs: number, toMs: number): number {
  const { t0, t1 } = wallSpan(samples, fromMs, toMs);
  const inside = paints.filter(t => t >= t0 && t <= t1);
  let longest = inside.length ? inside[0] - t0 : t1 - t0;
  for (let i = 1; i < inside.length; i++) longest = Math.max(longest, inside[i] - inside[i - 1]);
  return inside.length ? Math.max(longest, t1 - inside[inside.length - 1]) : longest;
}

describe('ve-preview paused inside a transition', () => {
  /*
   * A transition is two clips on screen at once, so a frame inside one is only right once BOTH of
   * the base track's elements are on the frame the window has them at: the incoming clip on the one
   * that is the clock, the outgoing clip's tail on the other. The same playhead then paints the same
   * frame every time, which is what a customer parked on the middle of a transition looks at, and
   * what the Maestro screenshots of every transition are taken of.
   *
   * Two one-colour clips of two seconds each, the second coming in over the last second of the
   * first: the window runs from 1000 to 2000 and its middle is 1500.
   */
  it(
    'paints the middle of a dissolve as the two clips half and half',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000', 2), b: await makeSourceVideo('#0000ff', 2) };
      const { store, preview } = await mountPair('dissolve', files, { clipMs: 2000, transitionMs: 1000 });
      await until('the first clip to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);

      store.seek(1500);
      expect(store.previewTransition.value?.progress).toBeCloseTo(0.5, 6);
      const blended = () => {
        const [r, g, b] = pixelAt(preview, 0.5, 0.5);
        // A dissolve's alpha is 0.5 at its middle: each clip at half its level, and nothing else.
        return r > 95 && r < 165 && b > 95 && b < 165 && g < 50;
      };
      await until('the two clips to be blended', blended, PIXEL_TIMEOUT_MS);
      // And it stays blended: nothing is left settling that would move it off the frame it is on.
      await frames(10);
      expect(blended()).toBe(true);
    },
    PIXEL_TIMEOUT_MS,
  );

  it(
    'paints the middle of a slide with the incoming clip on the right and the outgoing one, darkened, on the left',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000', 2), b: await makeSourceVideo('#0000ff', 2) };
      const { store, preview } = await mountPair('slide-left', files, { clipMs: 2000, transitionMs: 1000 });
      await until('the first clip to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);
      const fullRed = pixelAt(preview, 0.25, 0.5)[0];

      store.seek(1500);
      // Halfway, the incoming frame has come in over the right half; the outgoing one has drifted a
      // sixth of the way left under it and darkened by a sixth as it is covered.
      await until(
        'the slide to be composited',
        () => colourAt(preview, 0.75, 0.5) === 'blue' && colourAt(preview, 0.25, 0.5) === 'red' && pixelAt(preview, 0.25, 0.5)[0] < fullRed - 20,
        PIXEL_TIMEOUT_MS,
      );
      expect(colourAt(preview, 0.95, 0.5)).toBe('blue');
      expect(colourAt(preview, 0.05, 0.5)).toBe('red');
    },
    PIXEL_TIMEOUT_MS,
  );

  it(
    'holds the blended frame while the incoming clip is still seeking, rather than paint the outgoing one alone',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000', 2), b: await makeSourceVideo('#0000ff', 2) };
      const { store, preview } = await mountPair('dissolve', files, { clipMs: 2000, transitionMs: 1000 });
      await until('the first clip to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);
      store.seek(1500);
      await until('the dissolve to be composited', () => colourAt(preview, 0.5, 0.5) === 'other', PIXEL_TIMEOUT_MS);

      // A phone's seek, on the element the clock is: the tail's lands long before it does.
      const incoming = baseSources(preview).find(video => video.src === files.b);
      if (!incoming) throw new Error('no element has the incoming clip on it');
      standIns.push(slowSeeks(incoming, 250));

      // Anywhere from 0.4 to 0.6 of the way through, a dissolve between these two has a good third of
      // each clip in it. The incoming side left out is the outgoing clip at its full level - the
      // picture jumping back to red - and the outgoing one left out is blue over black.
      const oneSided: string[] = [];
      for (const at of [1400, 1600, 1450, 1550]) {
        store.seek(at);
        const settled = performance.now() + 500;
        while (performance.now() < settled) {
          await frames(1);
          const [r, , b] = pixelAt(preview, 0.5, 0.5);
          if (r < 60 || b < 60) oneSided.push(`${at}: rgb(${r}, _, ${b})`);
        }
      }
      expect(oneSided).toEqual([]);
      // And the frame it held for was then painted: the last seek's, a little past the middle.
      const [r, , b] = pixelAt(preview, 0.5, 0.5);
      expect(b).toBeGreaterThan(r);
    },
    PIXEL_TIMEOUT_MS,
  );

  it(
    'draws the clip under the playhead alone while the crop sheet is open, with no transition',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000', 2), b: await makeSourceVideo('#0000ff', 2) };
      const { store, preview } = await mountPair('dissolve', files, { clipMs: 2000, transitionMs: 1000 });
      await until('the first clip to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);
      store.seek(1500);
      await until('the dissolve to be composited', () => colourAt(preview, 0.5, 0.5) === 'other', PIXEL_TIMEOUT_MS);

      // The crop tool is about ONE clip's own picture: half of somebody else's under the window it
      // draws would be a lie about what is being cropped.
      store.select({ kind: 'clip', id: 'seg-b' });
      store.openPanel('crop');
      await until('the incoming clip to be drawn on its own', () => colourAt(preview, 0.5, 0.5) === 'blue', PIXEL_TIMEOUT_MS);

      // And shut again, the transition is back.
      store.closePanel();
      await until('the dissolve to be drawn again', () => colourAt(preview, 0.5, 0.5) === 'other', PIXEL_TIMEOUT_MS);
    },
    PIXEL_TIMEOUT_MS,
  );
});

describe('ve-preview playing across the joins between clips', () => {
  /*
   * Every join between two files used to be a freeze: the one base element was pointed at the next
   * file at the join, and the picture held on the outgoing frame for a load and a seek - 150 to 450
   * ms on a phone - at every cut, which is most of what makes an editor feel cheap. The base track
   * plays on two elements now, the next clip parked on the spare and started a moment early; see
   * [PreviewPlayer].
   *
   * Real footage, playing, with a picture that changes on every frame: so a join that froze would
   * show as a spot that stopped changing, and a join the compositor held as a gap in its paints.
   * The allowances are generous for a machine running a test suite, and still well under a load.
   */
  it(
    'plays across a transition without the picture ever standing still',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeMovingVideo('red', 3), b: await makeMovingVideo('blue', 3) };
      // The window runs from 2000 to 3000.
      const { store, preview } = await mountPair('dissolve', files, { clipMs: 3000, transitionMs: 1000 });
      await until('the first clip to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);
      store.seek(200);
      await frames(10);

      const paints = recordPaints(preview);
      const watch = sampleFrames(preview, store, files.b);
      store.play();
      await until('the transition to have been played through', () => store.playheadMs.value >= 3400, 15_000);
      store.pause();
      watch.stop();
      const samples = watch.samples;

      // The incoming clip was on an element of its own, with a frame, BEFORE the window opened -
      // which is the whole difference between a transition and a stall at its start.
      const readyAt = samples.find(s => s.incomingReady)?.t ?? Infinity;
      const openAt = samples.find(s => s.playheadMs >= 2000)?.t ?? -Infinity;
      expect(readyAt).toBeLessThan(openAt);

      // Painted on every frame through the window and both sides of it, and never still.
      expect(longestHold(paints, samples, 1500, 3300)).toBeLessThan(100);
      expect(longestStill(samples, 1500, 3300)).toBeLessThan(150);

      // And through a real blend on the way: the middle of the window was neither clip alone.
      const middle = samples.filter(s => s.playheadMs > 2300 && s.playheadMs < 2700);
      expect(middle.some(s => s.rgb[0] > 60 && s.rgb[2] > 60)).toBe(true);
      // Each clip on its own side of it all the way through: mostly the outgoing clip early in the
      // window and mostly the incoming one late in it. The two elements trade places at the window's
      // first frame, and a reading that paired one's role with the other's picture would turn the
      // dissolve round - still a blend in the middle, and backwards everywhere else.
      const early = samples.filter(s => s.playheadMs > 2050 && s.playheadMs < 2250);
      const late = samples.filter(s => s.playheadMs > 2750 && s.playheadMs < 2950);
      expect(early.length).toBeGreaterThan(0);
      expect(late.length).toBeGreaterThan(0);
      expect(early.every(s => s.rgb[0] > s.rgb[2])).toBe(true);
      expect(late.every(s => s.rgb[2] > s.rgb[0])).toBe(true);
      // The transport never dropped out across the join.
      expect(store.playheadMs.value).toBeGreaterThan(3000);
    },
    40_000,
  );

  it(
    'plays across a plain cut between two files without freezing on it',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeMovingVideo('red', 3), b: await makeMovingVideo('blue', 3) };
      // The cut is at 3000.
      const { store, preview } = await mountPair(null, files, { clipMs: 3000 });
      await until('the first clip to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);
      store.seek(1200);
      await frames(10);

      const paints = recordPaints(preview);
      const watch = sampleFrames(preview, store, files.b);
      store.play();
      await until('the cut to have been played through', () => store.playheadMs.value >= 3600, 15_000);
      store.pause();
      watch.stop();
      const samples = watch.samples;

      const readyAt = samples.find(s => s.incomingReady)?.t ?? Infinity;
      const cutAt = samples.find(s => s.playheadMs >= 3000)?.t ?? -Infinity;
      expect(readyAt).toBeLessThan(cutAt);
      expect(longestHold(paints, samples, 2500, 3500)).toBeLessThan(100);
      expect(longestStill(samples, 2500, 3500)).toBeLessThan(150);
      // Straight from one to the other: red before the cut, blue after it.
      expect(samples.filter(s => s.playheadMs > 2600 && s.playheadMs < 2900).every(s => s.rgb[0] > 150 && s.rgb[2] < 90)).toBe(true);
      expect(samples.filter(s => s.playheadMs > 3150 && s.playheadMs < 3500).every(s => s.rgb[2] > 150 && s.rgb[0] < 90)).toBe(true);
    },
    40_000,
  );
});

describe('ve-preview sharing the sound across a transition', () => {
  /*
   * Across a transition both clips are heard, each at its share: the outgoing clip fading down as
   * the incoming one comes up, the two adding up to one - the ramps the export mixes them with. And
   * once the window has closed only the incoming clip is heard, at its own level: a tail left
   * running would be the outgoing clip's sound going on under the next one.
   *
   * The stand-in's clocks run, so this plays the post end to end with no file to decode, and what is
   * read is what the player asked of each element.
   */
  it('crossfades the two clips over the window, and lets the outgoing one go after it', async () => {
    const files = standInForFiles();
    standIns.push(files);
    // Heard, rather than silenced: the sound is the point.
    const { store, preview } = await mountPair('dissolve', { a: 'stand-in:a', b: 'stand-in:b' }, { clipMs: 3000, transitionMs: 1000 }, false);
    const [first, second] = baseSources(preview);
    await until('the first clip to settle', () => files.of(first).at.length > 0);

    store.seek(1200);
    await frames(3);
    // Ahead of the boundary, the incoming clip is already on the other element.
    await until('the incoming clip to be put on the spare', () => files.of(second).src === 'stand-in:b');
    const loadsBefore = files.of(second).loads.length;

    const shares: { p: number; incoming: number; outgoing: number }[] = [];
    let live = true;
    const tick = () => {
      if (!live) return;
      const at = store.playheadMs.value;
      if (at > 2100 && at < 2900) shares.push({ p: (at - 2000) / 1000, incoming: second.volume, outgoing: first.volume });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    store.play();
    await until('the window to be played through', () => store.playheadMs.value >= 3300, 8000);
    live = false;

    // No load at the boundary: the element that took over had the clip on it already.
    expect(files.of(second).loads.length).toBe(loadsBefore);
    expect(shares.length).toBeGreaterThan(10);
    for (const share of shares) {
      // Read against a playhead written every 33 ms, and set from the clock a frame at a time: a
      // couple of frames' worth of slack either way.
      expect(Math.abs(share.incoming - share.p)).toBeLessThan(0.08);
      expect(Math.abs(share.outgoing - (1 - share.p))).toBeLessThan(0.08);
    }
    // Past the window: the tail has stopped, and the incoming clip is at its own level.
    expect(files.of(first).paused).toBe(true);
    expect(second.volume).toBe(1);
    expect(second.muted).toBe(false);
    expect(store.playing.value).toBe(true);
    store.pause();
  }, 20_000);

  it('puts each clip back at its own level when a paused playhead leaves the window, either way', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { store, preview } = await mountPair('dissolve', { a: 'stand-in:a', b: 'stand-in:b' }, { clipMs: 3000, transitionMs: 1000 }, false);
    const elements = baseSources(preview);
    const holding = (src: string) => elements.find(video => files.of(video).src === src);
    await until('the first clip to settle', () => files.of(elements[0]).at.length > 0);

    // The middle of the window: both clips at half their level.
    store.seek(2500);
    await until('both clips to be put in place', () => !!holding('stand-in:a') && !!holding('stand-in:b'));
    await frames(3);
    expect(holding('stand-in:b')!.volume).toBeCloseTo(0.5, 6);
    expect(holding('stand-in:a')!.volume).toBeCloseTo(0.5, 6);

    // Out past its end: the incoming clip is the only one left, at its own level.
    store.seek(3500);
    await frames(3);
    expect(holding('stand-in:b')!.volume).toBe(1);

    // Back in, and out the other way: the outgoing clip is the clock again, at its own level - not at
    // the half it was left at as the tail - and the incoming one is silent on the spare.
    store.seek(2500);
    await frames(3);
    store.seek(1000);
    await frames(3);
    const outgoing = holding('stand-in:a')!;
    expect(outgoing.volume).toBe(1);
    expect(outgoing.muted).toBe(false);
    const incoming = holding('stand-in:b');
    expect(!incoming || incoming.muted || files.of(incoming).paused).toBe(true);
    // And playing on from there, it is heard at its own level.
    store.play();
    await until('playback to start', () => store.playing.value, 3000);
    await frames(3);
    expect(outgoing.volume).toBe(1);
    store.pause();
  }, 20_000);

  it('keeps the transport running across a cut, the element that took over never reloading', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { store, preview } = await mountPair(null, { a: 'stand-in:a', b: 'stand-in:b' }, { clipMs: 3000 }, false);
    const [first, second] = baseSources(preview);
    await until('the first clip to settle', () => files.of(first).at.length > 0);

    store.seek(2000);
    await until('the incoming clip to be put on the spare', () => files.of(second).src === 'stand-in:b');
    const loadsBefore = files.of(second).loads.length;
    let stopped = false;
    let live = true;
    const tick = () => {
      if (!live) return;
      if (store.playheadMs.value > 2100 && !store.playing.value) stopped = true;
      requestAnimationFrame(tick);
    };
    store.play();
    await until('playback to start', () => store.playing.value, 3000);
    requestAnimationFrame(tick);
    await until('the cut to be played through', () => store.playheadMs.value >= 3400, 8000);
    live = false;

    expect(stopped).toBe(false);
    expect(files.of(second).loads.length).toBe(loadsBefore);
    // The element that was the clock stops at the cut; the other one plays on as the clock.
    expect(files.of(first).paused).toBe(true);
    expect(files.of(second).paused).toBe(false);
    store.pause();
  }, 20_000);
});

describe('ve-preview paused right at a join', () => {
  /*
   * The frame loop moves the clock on to the incoming clip once a frame, so for up to a frame the
   * clock's element is already past its own out point while the player still has it as the clip
   * before the join. A pause landing there parks the playhead exactly ON the join - which inside a
   * transition is the window's first frame, a frame with both clips in it - and both of them have to
   * stay on the elements they are already on: the incoming clip, preloaded on the spare, is the one
   * the picture and the next Play need, and loading the outgoing clip over it would throw it away.
   */
  it('keeps each clip on the element it is on, and plays on from there without a load', async () => {
    const files = standInForFiles();
    standIns.push(files);
    // The window runs from 2000 to 3000.
    const { store, preview } = await mountPair('dissolve', { a: 'stand-in:a', b: 'stand-in:b' }, { clipMs: 3000, transitionMs: 1000 });
    const [first, second] = baseSources(preview);
    await until('the first clip to settle', () => files.of(first).at.length > 0);
    store.seek(1500);
    await until('the incoming clip to be put on the spare', () => files.of(second).src === 'stand-in:b');
    store.play();
    await until('playback to be under way', () => store.playheadMs.value > 1600, 3000);
    const loads = () => [files.of(first).loads.length, files.of(second).loads.length];
    const before = loads();

    // The clock a few milliseconds past its out point, and the pause in the same task, so the frame
    // loop has not had the chance to see it.
    const clock = files.of(first);
    clock.position = 2.004;
    clock.playedAt = performance.now();
    store.pause();
    await frames(5);

    expect(store.playheadMs.value).toBe(2000);
    expect(files.of(first).src).toBe('stand-in:a');
    expect(files.of(second).src).toBe('stand-in:b');
    expect(loads()).toEqual(before);

    store.play();
    await until('the window to be played through', () => store.playheadMs.value >= 3200, 8000);
    store.pause();
    expect(loads()).toEqual(before);
  }, 20_000);
});

describe('ve-preview with a picture on the timeline', () => {
  /*
   * A picture plays on the same two base elements a video does - see [ClipMedia] - so everything the
   * player does at a join has to work when one side of it is a still: the cut into it, the clock
   * running through it with no file to read the time off, and a transition with a picture on one
   * side. What is asserted is what the customer sees: pixels off the composite.
   */

  /** A solid-colour picture, as a customer's photo would arrive: a PNG behind a blob URL. */
  async function makePicture(colour: string): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 120, 160);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    const url = URL.createObjectURL(blob!);
    revoke.push(url);
    return url;
  }

  /** Three seconds of video, then two of a picture - or the picture first, with `pictureFirst`. */
  async function mountMixed(
    files: { video: string; picture: string },
    options: { pictureFirst?: boolean; transition?: string } = {},
  ): Promise<{ store: EditorStore; preview: HTMLElement }> {
    const host = resolveEditorHost({});
    const store = new EditorStore(host);
    const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
    const video = defaultClipEdit('clip-v', 3000, 'seg-v');
    const picture = defaultPictureEdit('clip-p', 'seg-p', 2000);
    const [first, second] = options.pictureFirst ? [picture, video] : [video, picture];
    store.load(
      [
        { key: 'clip-v', fileName: 'v.mp4', playbackUrl: files.video },
        { key: 'clip-p', fileName: 'p.png', playbackUrl: files.picture, kind: 'image' },
      ],
      new Map([
        ['clip-v', 3000],
        ['clip-p', PICTURE_SOURCE_MS],
      ]),
      {
        ...emptyManifest(),
        originalMuted: true,
        clips: [first, options.transition ? { ...second, transitionIn: { kind: options.transition, durationMs: 1000 } } : second],
      },
    );

    const column = document.createElement('div');
    column.style.cssText = 'width: 393px; height: 720px';
    document.body.append(column);
    const preview = document.createElement('ve-preview');
    Object.assign(preview, { ctx });
    column.append(preview);
    mounted.push({ store, column });
    await (preview as StencilElement).componentOnReady?.();
    return { store, preview };
  }

  it(
    'shows the picture wherever the playhead is parked in its segment, and the video either side',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { video: await makeSourceVideo('#ff0000', 3), picture: await makePicture('#0000ff') };
      const { store, preview } = await mountMixed(files);
      await until('the video to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);

      store.seek(4200);
      await until('the picture to be composited', () => colourAt(preview, 0.5, 0.5) === 'blue', PIXEL_TIMEOUT_MS);

      store.seek(1000);
      await until('the video to come back', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);
    },
    PIXEL_TIMEOUT_MS * 2,
  );

  it(
    'plays from the video into the picture and on through it to the end, on a clock of its own',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { video: await makeMovingVideo('red', 3), picture: await makePicture('#0000ff') };
      const { store, preview } = await mountMixed(files);
      await until('the video to be composited', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);
      store.seek(2200);
      await frames(10);

      const watch = sampleFrames(preview, store, files.picture);
      const started = performance.now();
      store.play();
      await until('the post to have played to its end', () => !store.playing.value && store.playheadMs.value >= 4990, 15_000);
      const took = performance.now() - started;
      watch.stop();
      const samples = watch.samples;

      // The picture was on screen through its segment - which runs on the picture's own clock, as
      // there is no file to read the time off - and the playhead crossed the whole of it.
      const during = samples.filter(s => s.playheadMs > 3200 && s.playheadMs < 4800);
      expect(during.length).toBeGreaterThan(10);
      expect(during.every(s => s.rgb[2] > 150 && s.rgb[0] < 90)).toBe(true);
      // Red before the cut.
      expect(samples.filter(s => s.playheadMs > 2300 && s.playheadMs < 2900).every(s => s.rgb[0] > 150)).toBe(true);
      // In real time: 2.8 s of post, so neither skipped through nor stalled on the still.
      expect(took).toBeGreaterThan(2400);
      expect(took).toBeLessThan(6000);
      expect(store.playheadMs.value).toBe(store.totalMs.value);
    },
    40_000,
  );

  it(
    'dissolves out of a picture into the video after it',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { video: await makeMovingVideo('red', 3), picture: await makePicture('#0000ff') };
      // The picture runs 0..2000, and the video comes in over its last second: the window is 1000..2000.
      const { store, preview } = await mountMixed(files, { pictureFirst: true, transition: 'dissolve' });
      await until('the picture to be composited', () => colourAt(preview, 0.5, 0.5) === 'blue', PIXEL_TIMEOUT_MS);

      store.seek(1500);
      await until('both sides of the window to be blended', () => {
        const [r, , b] = pixelAt(preview, 0.5, 0.5);
        return r > 60 && b > 60;
      }, PIXEL_TIMEOUT_MS);

      store.seek(2600);
      await until('the video alone after the window', () => colourAt(preview, 0.5, 0.5) === 'red', PIXEL_TIMEOUT_MS);
    },
    PIXEL_TIMEOUT_MS * 2,
  );
});

describe('ve-preview moving a layer', () => {
  /*
   * A layer's motion moves its `<img>` on every frame, and it does it by writing the element's style
   * rather than by rendering the preview again: a render per frame of the preview is the one thing
   * the whole component is built to avoid. What is pinned is WHERE the layer is at each playhead - the
   * numbers the render draws, through the same sampler - and that getting there cost no render.
   */
  it('moves the layer with the playhead, straight from the compiled motion, and without a render', async () => {
    const { store, preview } = await mount(false);
    const id = store.addSticker({ emoji: '⭐' })!;
    // At 0, whatever the playhead: a slide in from the right and a pulse, over the whole post.
    store.commitOverlay(id, { startMs: 0, animation: { in: { id: 'slide-left', durationMs: 1000 }, loop: { id: 'pulse', periodMs: 1000 } } }, 'Animate');
    store.bitmaps.value = new Map([[id, { png: TRANSPARENT_PNG, wPx: 100, hPx: 100, key: 'k', scale: 1, frameW: 720, frameH: 1280 }]]);
    store.playheadMs.value = 0;
    await until('the layer to be drawn', () => layerImg(preview) !== null);
    await frames(2);

    const img = () => layerImg(preview)!;
    const leftOf = () => parseFloat(img().style.left);
    // At the start of the slide it is 12% of the frame to the right of where it was put, and clear.
    expect(leftOf()).toBeCloseTo(62, 3);
    expect(parseFloat(img().style.opacity)).toBeCloseTo(0, 6);

    // Whatever the mount still had to draw - the stage's first measurement, the selection box - is
    // drawn before the playhead starts moving, so what is counted is the move and nothing else.
    const renders = countRenders(preview);
    await frames(6);
    const settled = renders();
    store.playheadMs.value = 500;
    await frames(2);
    const halfway = store.overlayMotions.value.get(id)!;
    const x = halfway.x![halfway.atMs.findIndex(t => t >= 500)];
    expect(leftOf()).toBeGreaterThan(50);
    expect(leftOf()).toBeLessThan(62);
    expect(Math.abs(leftOf() - (50 + x * 100))).toBeLessThan(0.5);

    // A quarter of the way into the pulse: home, and bigger.
    store.playheadMs.value = 1250;
    await frames(2);
    expect(leftOf()).toBeCloseTo(50, 3);
    expect(img().style.transform).toMatch(/^translate\(-50%, -50%\) rotate\(0deg\) scale\(1\.0[34]/);
    expect(renders()).toBe(settled);

    // The motion taken away puts it back at rest, exactly as a still layer is written.
    store.commitOverlay(id, { animation: undefined }, 'Still');
    await frames(3);
    expect(leftOf()).toBeCloseTo(50, 6);
    expect(img().style.transform).toBe('translate(-50%, -50%) rotate(0deg)');
    expect(img().style.opacity).toBe('1');
  });
});

/** A 1x1 transparent PNG: the layer's picture does not matter here, only where its element is. */
const TRANSPARENT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function layerImg(preview: HTMLElement): HTMLImageElement | null {
  return preview.querySelector('img.pv__layer');
}
