import { BufferTarget, CanvasSource, Output, Quality, WebMOutputFormat } from 'mediabunny';
import { afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { userEvent } from 'vitest/browser';

import { defaultClipEdit, emptyManifest, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorStore, type PreviewVideoLayer } from '../../state/editor-store';
import { ClipMedia } from './clip-media';
import { FollowerVideo } from './follower-video';

/**
 * A layer's element with its sound on an element of its own - what the preview does where only one
 * `<video>` with sound may play at a time (iOS, where a layer started with its sound on paused the
 * base clip, and a post with a layer's sound on would not play at all).
 *
 * Pinned, against real elements in a real browser: the layer's picture plays silent, its sound plays
 * the same file on the `<audio>` in step with it, nothing is loaded for a layer nobody hears, and the
 * two stop together. Without a sound element the layer is heard on its own video, as everywhere but
 * iOS.
 *
 * The fixture is WebM/VP8, which every Chromium decodes. The `<audio>` is muted by the test itself,
 * so the headless machine makes no sound; muting it changes nothing the follower decides.
 */

const W = 64;
const H = 64;

async function fixture(seconds: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'vp8', quality: new Quality({ bitrate: 300_000 }) });
  output.addVideoTrack(source);
  await output.start();
  const fps = 10;
  for (let i = 0; i < seconds * fps; i++) {
    ctx.fillStyle = `rgb(${(i * 7) % 255}, 80, 160)`;
    ctx.fillRect(0, 0, W, H);
    await source.add(i / fps, 1 / fps);
  }
  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('no fixture');
  return URL.createObjectURL(new Blob([buffer], { type: 'video/webm' }));
}

function canPlayVp8(): boolean {
  return document.createElement('video').canPlayType('video/webm; codecs="vp8"') !== '';
}

const cleanups: (() => void)[] = [];

// A tap first, as the editor's Play is one: a headless browser will not start an `<audio>` for a page
// nobody has touched, muted or not. The WebView the sound element is made for starts media freely.
beforeAll(async () => {
  const button = document.createElement('button');
  button.textContent = 'tap';
  document.body.appendChild(button);
  await userEvent.click(button);
  button.remove();
});

afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

interface Rig {
  store: EditorStore;
  follower: FollowerVideo;
  video: HTMLVideoElement;
  sound: HTMLAudioElement | null;
  url: string;
  layer: () => PreviewVideoLayer;
}

async function rig(withSound: boolean, edit: (m: EditManifest) => EditManifest = m => m): Promise<Rig> {
  const url = await fixture(4);
  const store = new EditorStore(resolveEditorHost({}));
  const manifest: EditManifest = {
    ...emptyManifest(),
    clips: [defaultClipEdit('clip-a', 4000, 'seg-a')],
    videoTracks: [{ id: 'track-1', clips: [defaultClipEdit('clip-b', 4000, 'seg-b')], startMs: 0, z: 1, opacity: 1 }],
  };
  store.load(
    [
      { key: 'clip-a', fileName: 'a.webm', playbackUrl: url },
      { key: 'clip-b', fileName: 'b.webm', playbackUrl: url },
    ],
    new Map([
      ['clip-a', 4000],
      ['clip-b', 4000],
    ]),
    edit(manifest),
  );
  const video = document.createElement('video');
  video.playsInline = true;
  document.body.appendChild(video);
  const sound = withSound ? document.createElement('audio') : null;
  if (sound) sound.muted = true;
  const follower = new FollowerVideo(store, { video: new ClipMedia(video), sound });
  cleanups.push(() => {
    follower.destroy();
    video.remove();
    URL.revokeObjectURL(url);
  });
  const layer = () => {
    const found = store.previewLayers.value.find(each => each.trackId === 'track-1');
    if (!found) throw new Error('no layer under the playhead');
    return found;
  };
  return { store, follower, video, sound, url, layer };
}

async function until(what: string, ready: () => boolean, ms = 5000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** Plays the rig's post for `ms`, handing the follower the layer under a playhead that moves with the wall clock. */
async function play(r: Rig, ms: number): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < ms) {
    r.store.playheadMs.value = Math.min(3500, performance.now() - started);
    r.follower.sync(r.layer(), true);
    await new Promise(resolve => setTimeout(resolve, 33));
  }
}

describe('a layer whose sound has an element of its own', () => {
  it('plays its picture silent and its sound on that element, from the same file and in step', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const r = await rig(true);
    // Synced as the player syncs it, on every playhead write.
    await play(r, 600);
    expect(r.video.paused).toBe(false);
    expect(r.sound!.paused).toBe(false);
    // Muted by the follower: the picture must never be the second `<video>` with sound.
    expect(r.video.muted).toBe(true);
    expect(r.sound!.src).toBe(r.url);
    await play(r, 1200);
    expect(Math.abs(r.sound!.currentTime - r.video.currentTime)).toBeLessThan(0.35);
  }, 30_000);

  it('stops its sound when the layer stops, and when the layer leaves the frame', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const r = await rig(true);
    r.follower.sync(r.layer(), true);
    await until('the sound to start', () => !r.sound!.paused);
    r.follower.sync(r.layer(), false);
    expect(r.sound!.paused).toBe(true);
    expect(r.video.paused).toBe(true);
    r.follower.sync(r.layer(), true);
    await until('the sound to start again', () => !r.sound!.paused);
    r.follower.sync(null, true);
    expect(r.sound!.paused).toBe(true);
    r.follower.sync(r.layer(), true);
    await until('the sound to start once more', () => !r.sound!.paused);
    r.follower.pause();
    expect(r.sound!.paused).toBe(true);
  }, 30_000);

  it('loads nothing and plays nothing for a layer nobody hears', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const muted = await rig(true, m => ({ ...m, videoTracks: m.videoTracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, muted: true })) })) }));
    muted.follower.sync(muted.layer(), true);
    await until('the picture to start', () => !muted.video.paused);
    expect(muted.sound!.getAttribute('src')).toBeNull();
    expect(muted.sound!.paused).toBe(true);

    // The post's own sound turned off silences every layer too.
    const silenced = await rig(true, m => ({ ...m, originalMuted: true }));
    silenced.follower.sync(silenced.layer(), true);
    await until('the picture to start', () => !silenced.video.paused);
    expect(silenced.sound!.paused).toBe(true);
  }, 30_000);
});

describe('a layer with no element of its own for its sound', () => {
  it('is heard on its own video, as everywhere but iOS', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const r = await rig(false);
    r.follower.sync(r.layer(), false);
    expect(r.video.muted).toBe(false);
  }, 30_000);
});

/*
 * A layer that opens mid-play - each half of a split sliding in - is readied before its window opens:
 * its clip loaded and the element sitting paused on the frame the layer opens on. Left until the
 * window opened, the clip was put on the element on that frame and the stage held still while it
 * loaded, so the slide's first half was never seen.
 */
describe('a layer readied before its window opens', () => {
  /** The rig's layer starting at 2 s, from 1 s into its file. */
  const later = (m: EditManifest): EditManifest => ({
    ...m,
    videoTracks: m.videoTracks.map(track => ({ ...track, startMs: 2000, clips: track.clips.map(clip => ({ ...clip, inMs: 1000 })) })),
  });

  it('waits paused on its opening frame, then starts there with no load and no seek', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const r = await rig(false, later);
    r.store.playheadMs.value = 1000;
    r.follower.sync(null, true);
    const [next] = r.store.upcomingLayers(1500);
    expect(next).toMatchObject({ trackId: 'track-1', sourceMs: 1000 });

    r.follower.preload(next);
    await until('the opening frame', () => r.video.readyState >= 2 && !r.video.seeking && Math.abs(r.video.currentTime - 1) < 0.01);
    expect(r.video.paused).toBe(true);

    let loads = 0;
    let seeks = 0;
    r.video.addEventListener('loadstart', () => (loads += 1));
    r.video.addEventListener('seeking', () => (seeks += 1));
    // The window opens a frame late, as it does on a phone: the playhead is past the frame waited on.
    r.store.playheadMs.value = 2016;
    r.follower.sync(r.layer(), true);
    await until('the layer to play', () => !r.video.paused);
    expect([loads, seeks]).toEqual([0, 0]);
  }, 30_000);

  it('is left alone while a layer is on screen', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const r = await rig(false);
    r.follower.sync(r.layer(), false);
    await until('the layer to load', () => r.video.readyState >= 2);
    const src = r.video.currentSrc;
    const at = r.video.currentTime;

    r.follower.preload({ ...r.layer(), clipId: 'clip-a', clipKey: 'clip-a', sourceMs: 3000 });
    expect(r.video.currentSrc).toBe(src);
    expect(r.video.currentTime).toBe(at);
  }, 30_000);
});
