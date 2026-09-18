import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { afterEach, describe, expect, it, type TestContext } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { defaultClipEdit, emptyManifest, type EditManifest } from '../../editor';
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
async function makeSourceVideo(colour: string): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = SOURCE_WIDTH;
  canvas.height = SOURCE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality({ bitrate: 1_000_000 }) });
  output.addVideoTrack(source);
  await output.start();
  for (let i = 0; i < SOURCE_FRAMES; i++) {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
    await source.add(i / SOURCE_FPS, 1 / SOURCE_FPS);
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

/** The hidden elements the canvas draws FROM: one per video track, in track order. */
function sources(preview: HTMLElement): HTMLVideoElement[] {
  return [...preview.querySelectorAll('video')];
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
  position: number;
  at: number[];
  loads: number[];
  paused: boolean;
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
 * The element's clock does not advance by itself, which is the honest limit of it: what plays here
 * is everything that is not the base track's own footage.
 *
 * It patches the prototype rather than the elements because a track's `<video>` is created by a
 * render and loaded in the same tick, so there is no moment in between to reach that one in.
 */
function standInForFiles(): { of: (el: HTMLMediaElement) => Stood; restore: () => void } {
  const proto = HTMLMediaElement.prototype;
  const was = {
    currentTime: Object.getOwnPropertyDescriptor(proto, 'currentTime')!,
    readyState: Object.getOwnPropertyDescriptor(proto, 'readyState')!,
    duration: Object.getOwnPropertyDescriptor(proto, 'duration')!,
    paused: Object.getOwnPropertyDescriptor(proto, 'paused')!,
    load: proto.load,
    play: proto.play,
    pause: proto.pause,
  };
  const state = new WeakMap<HTMLMediaElement, Stood>();
  const of = (el: HTMLMediaElement): Stood => {
    const one = state.get(el) ?? { position: 0, at: [], loads: [], paused: true };
    state.set(el, one);
    return one;
  };

  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return of(this).position;
    },
    set(this: HTMLMediaElement, value: number) {
      const one = of(this);
      one.position = value;
      one.at.push(value);
      // The event the player's seek watchdog exists to survive the absence of. Fired, the player
      // moves on at once instead of waiting out the watchdog on every single seek.
      queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
    },
  });
  Object.defineProperty(proto, 'readyState', { configurable: true, get: () => 4 /* HAVE_ENOUGH_DATA */ });
  Object.defineProperty(proto, 'duration', { configurable: true, get: () => DURATION_S });
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
      one.paused = false;
      queueMicrotask(() => this.dispatchEvent(new Event('play')));
    }
    return Promise.resolve();
  };
  proto.pause = function (this: HTMLMediaElement) {
    const one = of(this);
    if (!one.paused) {
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
    'colours the picture and leaves the letterbox bars BLACK, as the export does',
    async (ctx) => {
      needs(ctx, canDecodeAvc(), 'this browser has no H.264 decoder');
      const files = { a: await makeSourceVideo('#ff0000'), b: await makeSourceVideo('#0000ff') };
      const { store, preview } = await mount(false, files);

      // A square source in a 9:16 frame, drawn `contain` as every post is by default: black top and
      // bottom. The colour work is the compositor's now, and the same call the export makes.
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
    await until('the base to load its clip', () => files.of(sources(preview)[0]).loads.length > 0);

    // The base's footage is 5s; the post is pulled out to 8. The tail is 3s of black with the
    // layers, the music and any voiceover still on it.
    store.setPostDuration(8000);
    expect(store.baseMs.value).toBe(5000);
    expect(store.totalMs.value).toBe(8000);

    const started = performance.now();
    store.seek(5000);
    store.play();

    await until('the tail to start running', () => store.playheadMs.value > 5100, 3000);
    // THROUGH the tail and not to the end of it. Stopping looked exactly like this used to: the
    // playhead was thrown to `totalMs` the instant the base ran out, so a test that only asked
    // whether it had moved past the base would have passed over the bug.
    expect(store.playheadMs.value).toBeLessThan(7000);
    expect(store.playing.value).toBe(true);

    await until('the post to reach its own end', () => store.playheadMs.value >= 8000, 8000);
    // Real time, because it is a real clock: three seconds of tail cannot have gone by in one.
    expect(performance.now() - started).toBeGreaterThan(2500);
    await until('the transport to stop at the end', () => !store.playing.value, 2000);
    expect(store.playheadMs.value).toBe(8000);
  }, 20_000);

  it('stops at the end of the base when the post is NOT stretched', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { store, preview } = await mount();
    await until('the base to load its clip', () => files.of(sources(preview)[0]).loads.length > 0);

    // No tail: the end of the base IS the end of the post, and nothing may invent a clock for it.
    expect(store.totalMs.value).toBe(store.baseMs.value);
    store.seek(4990);
    store.play();

    await until('playback to stop at the end of the post', () => !store.playing.value, 3000);
    expect(store.playheadMs.value).toBe(5000);
  });
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

    // The base and both layers, not the base and the front-most one.
    expect(sources(preview).length).toBe(3);
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
  });
});
