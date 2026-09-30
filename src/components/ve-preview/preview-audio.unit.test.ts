import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyManifest, type EditClip, type EditMusic, type EditVoiceover } from '../../editor';
import type { EditorSource } from '../../host/host.types';
import type { EditorStore } from '../../state/editor-store';
import type { ClipMedia } from './clip-media';
import type { PreviewPlayer } from './preview-player';

/*
 * The preview's music at the seams of a track that repeats, and the music and a voiceover take at the
 * end of a sound that stops, played by the real player from a real store over stand-ins for its
 * elements, on a clock this file turns by hand. Nothing here decodes or reaches a speaker; what is
 * pinned is where the player PUTS the audio elements and when it starts and stops them.
 *
 * The elements are made to end their files the way each engine does. Chromium stops it at the end
 * with `paused` and `ended` together. WebKit's clock reaches the end first, and its media process's
 * notice that the file has played out comes afterwards and takes wherever the element is THEN as
 * the file's length - which is how, measured on the iOS 26.5 simulator, a 12-second track became
 * 0.121 s long at a loop's seam and the preview put it back on every frame from then on.
 */

/**
 * The platform's own `Event`; the mock DOM's is refused by the platform `EventTarget` every stand-in
 * below extends. An aborted signal fires the platform's, which is where it is taken from.
 */
const PLATFORM_EVENT = ((): typeof Event => {
  const controller = new AbortController();
  let made: typeof Event | null = null;
  controller.signal.addEventListener('abort', event => {
    made = event.constructor as typeof Event;
  });
  controller.abort();
  if (!made) throw new Error('no platform Event');
  return made;
})();

type Engine = 'webkit' | 'chromium';

/** WebKit's notice that a file has played out, after its clock got to the end: 22 ms measured. */
const NOTICE_MS = 22;

interface Put {
  /** Where the element was, and where it was put, in seconds. */
  fromS: number;
  toS: number;
  /** It was playing when it was put. */
  playing: boolean;
  /** The post's playhead when it was, in ms. */
  playheadMs: number;
}

/**
 * A stretch of the wall clock in which an element's clock stands still after a start or a seek:
 * `afterMs` after it, for `forMs`.
 */
interface Still {
  afterMs: number;
  forMs: number;
}

/**
 * How a ROUTED element's clock stands still after a start or a seek - one played through the preview's
 * mixer, which is every new sound on iOS (see [PreviewMixer]). Measured in the app's WebView on the
 * iOS 26.5 simulator (2026-09-29, ios-probe r3): a seek or a start costs a routed `<audio>` about
 * 440 ms of its clock over the next second - it moves at first, then stands still for a couple of
 * hundred milliseconds at a time - where an element that is not routed loses about 45 ms. Left alone
 * afterwards it runs at 1.00x. Modelled as the clock running on for `afterMs` and then standing still
 * for `forMs`: the loss comes AFTER the first moments, which is what a check made a few hundred
 * milliseconds after a put reads as an element that has settled, when it has not.
 */
type RoutedStall = Still;

const ROUTED_STALL: RoutedStall = { afterMs: 300, forMs: 440 };

/**
 * Each put's stall, taken a put at a time from `starts` for a `play()` and from `seeks` for a seek of
 * an element that is playing. A paused element that is put and then played - every start the player
 * makes - is one start: its clock stands still from the `play()`, as WebKit's does, and the seek
 * before it takes nothing.
 */
interface UnevenStalls {
  starts: readonly (readonly Still[])[];
  seeks: readonly (readonly Still[])[];
}

/**
 * How the music element's clock stands still after a start or a seek in WebKit on a Mac, which can set
 * `volume` and so routes nothing - measured in the web editor on Playwright's build of Safari's engine
 * (2026-09-29, verify-web runs), the same shape as a routed iPhone's and about as long. A seek costs
 * 390-475 ms of the clock over the next 0.8 s: about 150 ms of it at once, then a stretch of running,
 * then the rest. A start costs less, 285-334 ms. No two puts cost the same. Read a few hundred
 * milliseconds in, the element looks settled with the first 150 ms or so lost, and 0.7 s after the put
 * it is the rest of the stall behind: the web editor's music was seeked again that often, up to 30
 * times in a 24 s play.
 *
 * Modelled as a turn of four starts and a turn of five seeks, each lost at once, then run on, then lost
 * again: starts of 310, 330, 300 and 320 ms in all, and seeks of 440, 400, 460, 390 and 420, the first
 * part 120-190 ms of each. The running in between is long enough for a check made once the clock is
 * 300 ms past where it was put to fall inside it, as the measurements say it did.
 */
const MAC_STALLS: UnevenStalls = {
  starts: [
    [
      { afterMs: 0, forMs: 150 },
      { afterMs: 150 + 320, forMs: 160 },
    ],
    [
      { afterMs: 0, forMs: 130 },
      { afterMs: 130 + 330, forMs: 200 },
    ],
    [
      { afterMs: 0, forMs: 170 },
      { afterMs: 170 + 310, forMs: 130 },
    ],
    [
      { afterMs: 0, forMs: 140 },
      { afterMs: 140 + 320, forMs: 180 },
    ],
  ],
  seeks: [
    [
      { afterMs: 0, forMs: 150 },
      { afterMs: 150 + 330, forMs: 290 },
    ],
    [
      { afterMs: 0, forMs: 120 },
      { afterMs: 120 + 350, forMs: 280 },
    ],
    [
      { afterMs: 0, forMs: 190 },
      { afterMs: 190 + 330, forMs: 270 },
    ],
    [
      { afterMs: 0, forMs: 130 },
      { afterMs: 130 + 340, forMs: 260 },
    ],
    [
      { afterMs: 0, forMs: 160 },
      { afterMs: 160 + 330, forMs: 260 },
    ],
  ],
};

/**
 * A media element with nothing to decode, whose clock runs off the (faked) wall clock while it plays,
 * standing still for `stallMs` after every start and every seek, as a phone's audio output does - or,
 * once it is routed through the mixer's graph, as [RoutedStall] says, or as [unevenStalls] says where
 * a test hands it some.
 */
class FakeMedia extends EventTarget {
  src = '';
  muted = false;
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  duration = Number.NaN;
  error = null;
  playbackRate = 1;
  preservesPitch = true;
  volume = 1;
  preload = 'auto';
  seeking = false;
  paused = true;
  readonly puts: Put[] = [];
  /** Wall times of every `pause` event, and every `play()` asked of it. */
  readonly pauses: number[] = [];
  readonly plays: number[] = [];
  loads = 0;
  /** Read by [Put.playheadMs]; set by the rig. */
  playhead: () => number = () => Number.NaN;
  /**
   * WebKit only: how long after its clock reaches the end the media process says so. Infinity: it
   * never does, and the element sits at the end of its file reported playing.
   */
  noticeMs = NOTICE_MS;
  /** Handed to the mixer's graph (see [route]); its stall is then [routedStall]. */
  routed = false;
  routedStall: RoutedStall = ROUTED_STALL;
  /**
   * Not routed, and stalling as WebKit's element does on a Mac ([MAC_STALLS]): each start and each seek
   * costs the next of its kind in turn, in place of `stallMs`.
   */
  unevenStalls: UnevenStalls | null = null;
  private readonly handedOut = { starts: 0, seeks: 0 };

  /**
   * Where the clock was put last, the wall time it was put there, and the stretches of wall time after
   * that in which it stands still: straight after the put, a little after it - routed - or both.
   */
  private at = 0;
  private since = 0;
  private stills: Array<[fromMs: number, toMs: number]> = [];
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly lengthS: number,
    private readonly engine: Engine,
    private readonly stallMs = 0,
  ) {
    super();
  }

  get ended(): boolean {
    return Number.isFinite(this.duration) && this.position() >= this.duration;
  }

  get currentTime(): number {
    return this.position();
  }

  set currentTime(seconds: number) {
    this.puts.push({ fromS: this.position(), toS: seconds, playing: !this.paused, playheadMs: this.playhead() });
    this.moveTo(seconds);
    // A paused element's clock stands still from its `play()`: put and then played, it is one start.
    if (!this.paused) this.stall('seeks');
    // A seek before the clock gets to the end means it never did; a notice already on its way is
    // not called back by anything - which is the whole of WebKit's trouble.
    this.planEnd();
    this.seeking = true;
    setTimeout(() => {
      this.seeking = false;
      this.fire('seeked');
    }, 0);
  }

  load(): void {
    this.loads += 1;
    this.clearTimers();
    this.paused = true;
    this.at = 0;
    this.readyState = 0;
    this.duration = Number.NaN;
    if (!this.src) return;
    setTimeout(() => {
      this.readyState = 4;
      this.videoWidth = 16;
      this.videoHeight = 16;
      this.duration = this.lengthS;
      this.fire('loadedmetadata');
      this.planEnd();
    }, 0);
  }

  play(): Promise<void> {
    this.plays.push(performance.now());
    // An element that has ended plays from the start of its file.
    if (this.ended) this.at = 0;
    if (this.paused) {
      this.paused = false;
      this.stall('starts');
      this.planEnd();
      this.fire('play');
    }
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.at = this.position();
    this.paused = true;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    this.pauses.push(performance.now());
    this.fire('pause');
  }

  setAttribute(): void {
    /* `poster`, which nothing here draws. */
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  /** Moves the clock without anybody asking it to: an element running ahead of where it was put. */
  jumpTo(seconds: number): void {
    this.moveTo(seconds);
    this.since = performance.now();
    this.stills = [];
    this.planEnd();
  }

  /**
   * Handed to the mixer's graph, which is for good. A playing element is modelled as losing a routed
   * stall from here, as WebKit rebuilds the way its sound comes out.
   */
  route(): void {
    this.routed = true;
    if (this.paused) return;
    this.at = this.position();
    this.stall('seeks');
    this.planEnd();
  }

  /** WebKit's length taken from where the element has been put: what the probe saw at a seam. */
  collapseAt(seconds: number): void {
    this.clearTimers();
    this.at = seconds;
    this.duration = seconds;
    this.paused = true;
    this.pauses.push(performance.now());
    this.fire('durationchange');
    this.fire('pause');
    this.fire('ended');
  }

  private position(): number {
    const end = Number.isFinite(this.duration) ? this.duration : Infinity;
    if (this.paused) return Math.min(this.at, end);
    return Math.min(this.at + this.runMs(performance.now()) / 1000, end);
  }

  /** Starts the stall a start or a seek costs, from now. */
  private stall(kind: keyof UnevenStalls): void {
    const now = performance.now();
    this.since = now;
    let pattern: readonly Still[] = [{ afterMs: 0, forMs: this.stallMs }];
    if (this.routed) pattern = [this.routedStall];
    else if (this.unevenStalls) {
      const turn = this.unevenStalls[kind];
      pattern = turn[this.handedOut[kind]++ % turn.length];
    }
    this.stills = pattern.map(({ afterMs, forMs }) => [now + afterMs, now + afterMs + forMs]);
  }

  /** How long the clock has actually run since it was put, at wall time `now`. */
  private runMs(now: number): number {
    let still = 0;
    for (const [from, to] of this.stills) still += Math.max(0, Math.min(now, to) - Math.max(this.since, from));
    return Math.max(0, now - this.since) - still;
  }

  /** The wall time from `now` until the clock has run `ms` more. */
  private wallFor(ms: number, now: number): number {
    let at = now;
    let left = ms;
    for (const [from, to] of this.stills) {
      if (to <= at) continue;
      if (from > at) {
        if (left <= from - at) return at + left - now;
        left -= from - at;
      }
      at = to;
    }
    return at + left - now;
  }

  private moveTo(seconds: number): void {
    const end = Number.isFinite(this.duration) ? this.duration : Infinity;
    this.at = Math.min(Math.max(0, seconds), end);
  }

  /** When the clock, running, will get to the end of the file. */
  private planEnd(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    if (this.paused || !Number.isFinite(this.duration)) return;
    const now = performance.now();
    const inMs = this.wallFor(Math.max(0, (this.duration - this.at) * 1000 - this.runMs(now)), now);
    this.endTimer = setTimeout(() => this.reachEnd(), Math.max(0, inMs));
  }

  private reachEnd(): void {
    this.endTimer = null;
    if (this.engine === 'chromium') {
      this.at = this.duration;
      this.paused = true;
      this.pauses.push(performance.now());
      this.fire('pause');
      this.fire('ended');
      return;
    }
    if (Number.isFinite(this.noticeMs)) this.noticeTimer = setTimeout(() => this.notice(), this.noticeMs);
  }

  /** `MediaPlayerPrivateAVFoundation::didEnd`: wherever the player is now is the file's length. */
  private notice(): void {
    this.noticeTimer = null;
    const now = this.position();
    if (now > 0) this.duration = now;
    this.at = now;
    const wasPlaying = !this.paused;
    this.paused = true;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    this.fire('durationchange');
    if (wasPlaying) {
      this.pauses.push(performance.now());
      this.fire('pause');
    }
    this.fire('ended');
  }

  private clearTimers(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.endTimer = null;
    this.noticeTimer = null;
  }

  private fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

/** WebKit reads the 12 s test tone as 11.975 s, and so does the post that picked it. */
const TRACK_S = 11.975;
const SECTION_MS = 11_975;

/** The tone looped whole from the top of the post, heard at full level with no fades. */
const LOOPED: EditMusic = {
  uri: 'blob:capacitor://localhost/track',
  fileName: 'track.m4a',
  sourceDurationMs: SECTION_MS,
  inMs: 0,
  outMs: 0,
  startMs: 0,
  endMs: 0,
  volume: 1,
  loop: true,
  fadeOutMs: 0,
};

/** The one clip under it: half a minute. */
const CLIP_MS = 30_000;
const SOURCES: EditorSource[] = [{ key: 'a', fileName: 'a.mp4', playbackUrl: 'blob:capacitor://localhost/a' }];

function clip(): EditClip {
  return { id: 'a', clipKey: 'a', inMs: 0, outMs: CLIP_MS, speed: 1, volume: 1, muted: false };
}

interface Rig {
  store: EditorStore;
  player: PreviewPlayer;
  music: FakeMedia;
  voice: FakeMedia;
}

const players: PreviewPlayer[] = [];

/** A voiceover take on the post, and how long its file really is. */
interface Take {
  take: EditVoiceover;
  fileS: number;
}

/**
 * The page's `AudioContext` as WebKit gives one: suspended until resumed, and resumed and suspended a
 * task later. What the mixer asks of it is all that is here; an element handed to it is routed for
 * good, which is what makes its stall a routed one (see [RoutedStall]).
 */
class FakeContext {
  state: AudioContextState = 'suspended';
  readonly destination = {};

  resume(): Promise<void> {
    return new Promise(resolve =>
      setTimeout(() => {
        this.state = 'running';
        resolve();
      }, 0),
    );
  }

  suspend(): Promise<void> {
    return new Promise(resolve =>
      setTimeout(() => {
        this.state = 'suspended';
        resolve();
      }, 0),
    );
  }

  createGain(): object {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
  }

  createMediaElementSource(element: FakeMedia): object {
    element.route();
    return { connect: () => undefined };
  }
}

interface RigOptions {
  take?: Take;
  stallMs?: number;
  /**
   * An iPhone whose WebView gives the page an audio session and a context, and so plays a post's music
   * through the mixer whenever the post has a level for it (see [levelsInUse]). WebKit without it is an
   * iPhone's WebView all the same - a touch screen, and a `volume` the page cannot set - but one with no
   * audio session, where nothing is ever routed.
   */
  iphone?: boolean;
  /**
   * WebKit on a Mac: no touch screen, a `volume` the page can set, and so nothing ever routed, whose
   * elements are slow to seek on their own (see [MAC_STALLS]) and start from leads of their own.
   */
  mac?: boolean;
}

/**
 * A player over a half-minute clip, `music` and `take`, with its elements ending their files as
 * `engine`'s do. The start and seek stall of the music and the voiceover is 100 ms on WebKit, which is
 * what the iOS simulator measured, and 30 ms on Chromium, unless `stallMs` says otherwise. WebKit is an
 * iPhone's unless `mac` says otherwise: the WebKit every measurement behind these tests was made on,
 * the Mac's aside.
 */
async function rig(engine: Engine, music: EditMusic | null, { take, stallMs, iphone = false, mac = false }: RigOptions = {}): Promise<Rig> {
  vi.resetModules();
  Object.defineProperty(navigator, 'vendor', { value: engine === 'webkit' ? 'Apple Computer, Inc.' : 'Google Inc.', configurable: true });
  if (engine === 'webkit' && !mac) Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
  if (iphone) {
    Object.defineProperty(navigator, 'audioSession', { value: { type: 'auto' }, configurable: true });
    vi.stubGlobal('AudioContext', FakeContext);
    // The page as the app on iOS serves it, which is what "this page's own file" is measured against.
    vi.stubGlobal('location', new URL('capacitor://localhost/'));
  }

  const { EditorStore } = await import('../../state/editor-store');
  const { resolveEditorHost } = await import('../../host/defaults');
  const { ClipMedia } = await import('./clip-media');
  const { PreviewPlayer } = await import('./preview-player');

  const store = new EditorStore(resolveEditorHost({}));
  store.load(SOURCES, new Map([['a', CLIP_MS]]), { ...emptyManifest(), clips: [clip()], music, voiceovers: take ? [take.take] : [] });
  const deck = (): ClipMedia => new ClipMedia(new FakeMedia(CLIP_MS / 1000, engine) as unknown as HTMLVideoElement);
  const stall = stallMs ?? (engine === 'webkit' ? 100 : 30);
  const musicEl = new FakeMedia(TRACK_S, engine, stall);
  musicEl.playhead = () => store.playheadMs.value;
  const voiceEl = new FakeMedia(take?.fileS ?? 1, engine, stall);
  voiceEl.playhead = () => store.playheadMs.value;
  const player = new PreviewPlayer(store, {
    video: deck(),
    partner: deck(),
    music: musicEl as unknown as HTMLAudioElement,
    voice: voiceEl as unknown as HTMLAudioElement,
    extraLayers: () => [],
  });
  players.push(player);
  player.start();
  await run(0);
  return { store, player, music: musicEl, voice: voiceEl };
}

/** Turns the clock `ms` on, a display frame at a time, with everything that falls due on the way. */
async function run(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Plays from `ms`, as a tap on Play there does. */
async function playFrom(r: Rig, ms: number): Promise<void> {
  r.player.seek(ms);
  await run(0);
  r.player.play();
  await run(0);
}

/** Runs until the playhead has got to `ms`, a frame at a time, calling `each` after every frame. */
async function playTo(r: Rig, ms: number, each?: () => void): Promise<void> {
  for (let i = 0; i < 10_000 && r.store.playheadMs.value < ms; i++) {
    await run(16);
    each?.();
  }
  expect(r.store.playheadMs.value).toBeGreaterThanOrEqual(ms);
}

/** The puts made while the playhead was between `fromMs` and `toMs`. */
function putsBetween(el: FakeMedia, fromMs: number, toMs: number): Put[] {
  return el.puts.filter(put => put.playheadMs >= fromMs && put.playheadMs < toMs);
}

/** The last put made of an element. */
function lastPut(el: FakeMedia): Put {
  const put = el.puts.at(-1);
  if (!put) throw new Error('never put');
  return put;
}

/** How far the element is from where the playhead has it, round the loop. */
function driftMs(r: Rig): number {
  const want = r.store.playheadMs.value % SECTION_MS;
  let off = r.music.currentTime * 1000 - want;
  if (off > SECTION_MS / 2) off -= SECTION_MS;
  if (off < -SECTION_MS / 2) off += SECTION_MS;
  return off;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.stubGlobal('Event', PLATFORM_EVENT);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
});

afterEach(() => {
  for (const player of players.splice(0)) player.destroy();
  Reflect.deleteProperty(navigator, 'vendor');
  Reflect.deleteProperty(navigator, 'maxTouchPoints');
  Reflect.deleteProperty(navigator, 'audioSession');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the stand-in for a WebKit audio element', () => {
  it('loses its length to a seek that lands between the end of the file and the notice of it', async () => {
    // What the preview used to do at a seam, and what the probe caught WebKit doing with it.
    const el = new FakeMedia(TRACK_S, 'webkit', 100);
    el.src = 'blob:track';
    el.load();
    await run(0);
    el.currentTime = 11.9;
    await el.play();
    // Its start stall, then the last 75 ms of the file.
    await run(100 + 75 + 5);
    expect(el.currentTime).toBeCloseTo(TRACK_S, 6);
    expect(el.ended).toBe(true);
    expect(el.paused).toBe(false);
    el.currentTime = 0.121;
    await run(40);
    expect(el.duration).toBeCloseTo(0.121, 6);
    expect(el.paused).toBe(true);
  });
});

describe('a repeating track at its seams, on WebKit', () => {
  it('is sent round a stall ahead of the seam, never touched at the end of its file, and plays straight through', async () => {
    const r = await rig('webkit', LOOPED);
    await playFrom(r, 11_000);
    const pausesBefore = r.music.pauses.length;
    await playTo(r, 12_700);

    // One put at the seam, onto the first moment of the next pass, made while the element was still
    // clear of the end of its file.
    const seam = putsBetween(r.music, 11_300, 12_700);
    expect(seam).toHaveLength(1);
    expect(seam[0].playing).toBe(true);
    expect(seam[0].toS).toBeLessThan(0.15);
    expect(TRACK_S - seam[0].fromS).toBeGreaterThanOrEqual(0.05);
    // Not stopped at the seam, not cut short, and in step on the other side of it.
    expect(r.music.pauses.length).toBe(pausesBefore);
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
    expect(r.music.paused).toBe(false);
    expect(Math.abs(driftMs(r))).toBeLessThan(200);
  });

  it('goes round every seam of a long play, and is never put back across one', async () => {
    const r = await rig('webkit', LOOPED);
    await playFrom(r, 0);
    await playTo(r, 29_000);
    // Two seams, one put each; the play's own put at the start is the third.
    expect(r.music.puts.filter(put => put.playing)).toHaveLength(2);
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
    expect(Math.abs(driftMs(r))).toBeLessThan(200);
  });

  it('leaves an element at the end of its file alone until WebKit has said so, and then goes round', async () => {
    const r = await rig('webkit', LOOPED);
    // The notice takes long enough here for the frame loop to look at the element several times in
    // between, which is the moment a seek used to cost the file its length.
    r.music.noticeMs = 150;
    await playFrom(r, 11_000);
    await playTo(r, 11_750);
    // The element runs ahead, into the last 30 ms of its file, where nothing may move it.
    r.music.jumpTo(TRACK_S - 0.03);
    const puts = r.music.puts.length;
    const endedAtMs = performance.now() + 30;
    await run(30 + 150 - 10);
    expect(r.music.ended).toBe(true);
    expect(r.music.puts.length).toBe(puts);

    await playTo(r, 12_600);
    // Put once WebKit had said it had ended: on the next pass, at its true length, and playing.
    const after = r.music.puts.slice(puts);
    expect(after).toHaveLength(1);
    expect(after[0].playing).toBe(false);
    expect(after[0].toS).toBeLessThan(0.3);
    expect(r.music.plays.at(-1)).toBeGreaterThan(endedAtMs + 150);
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
    expect(r.music.paused).toBe(false);
    expect(Math.abs(driftMs(r))).toBeLessThan(200);
  });

  it('loads a file WebKit has cut short again, instead of seeking it on every frame', async () => {
    const r = await rig('webkit', LOOPED);
    // Just past the second seam, where the probe's was put.
    await playFrom(r, 24_100);
    await playTo(r, 24_150);
    // What the probe saw: the length taken from where the element had just been put, to the
    // millisecond, and the element ended there.
    r.music.collapseAt(lastPut(r.music).toS);
    const loads = r.music.loads;
    const puts = r.music.puts.length;
    await playTo(r, 25_000);

    // Emptied and loaded again - two loads - put where the playhead is and started.
    expect(r.music.loads).toBe(loads + 2);
    expect(r.music.src).toBe('blob:capacitor://localhost/track');
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
    expect(r.music.paused).toBe(false);
    expect(r.music.puts.length - puts).toBeLessThanOrEqual(2);
    expect(Math.abs(driftMs(r))).toBeLessThan(200);
  });

  it('loads it again no more than once a second, and once more after that if it is still cut short', async () => {
    const r = await rig('webkit', LOOPED);
    // Just past the FIRST seam, so there are passes to come and the element is put again meanwhile.
    await playFrom(r, 12_100);
    await playTo(r, 12_150);
    const loads = r.music.loads;
    r.music.collapseAt(lastPut(r.music).toS);
    await playTo(r, 12_400);
    expect(r.music.loads).toBe(loads + 2);

    // Cut short again at the put made after that load, well inside the second: not loaded again yet,
    // and held where it is rather than put back to the start of the little the file now says it has
    // every few frames.
    r.music.collapseAt(lastPut(r.music).toS);
    const puts = r.music.puts.length;
    await playTo(r, 12_900);
    expect(r.music.loads).toBe(loads + 2);
    expect(r.music.puts.length).toBe(puts);
    expect(r.music.paused).toBe(true);

    // Still cut short once the second is over, so it is loaded again then, and plays on at its length.
    await playTo(r, 14_000);
    expect(r.music.loads).toBe(loads + 4);
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
    expect(r.music.paused).toBe(false);
    expect(Math.abs(driftMs(r))).toBeLessThan(200);
  });

  it('does not load a file again whose length comes down to where it really ends, far from any put', async () => {
    // WebKit's own correction of a length it had only estimated, once the element plays up to the
    // real end: nothing the preview put there. Loaded again, it would be loaded again at every seam.
    const r = await rig('webkit', LOOPED);
    await playFrom(r, 5000);
    await playTo(r, 11_000);
    const loads = r.music.loads;
    r.music.collapseAt(r.music.currentTime);
    await playTo(r, 13_000);
    expect(r.music.loads).toBe(loads);
  });

  it('pauses an element WebKit never says has ended half a second on, and then goes round', async () => {
    const r = await rig('webkit', LOOPED);
    r.music.noticeMs = Infinity;
    await playFrom(r, 11_000);
    await playTo(r, 11_750);
    // Run ahead into the last 30 ms of its file, where nothing may move it, and never told it ended.
    r.music.jumpTo(TRACK_S - 0.03);
    const puts = r.music.puts.length;
    const pauses = r.music.pauses.length;
    const jumpedAt = performance.now();
    await run(450);
    expect(r.music.ended).toBe(true);
    expect(r.music.paused).toBe(false);
    expect(r.music.puts.length).toBe(puts);

    await playTo(r, 12_800);
    // Paused once it had sat there for half a second, then put on the next pass and started.
    expect(r.music.pauses.length).toBe(pauses + 1);
    expect(r.music.pauses[pauses] - jumpedAt).toBeGreaterThanOrEqual(500);
    expect(r.music.pauses[pauses] - jumpedAt).toBeLessThan(600);
    const after = r.music.puts.slice(puts);
    expect(after).toHaveLength(1);
    expect(after[0].playing).toBe(false);
    expect(after[0].toS).toBeLessThan(1);
    expect(r.music.paused).toBe(false);
    expect(Math.abs(driftMs(r))).toBeLessThan(200);
  });

  it('starts a play that begins just short of a seam on the next pass, not on the last moment of this one', async () => {
    const r = await rig('webkit', LOOPED);
    // Somewhere else in the track first, so the put at the seam is one the element has to be moved for -
    // and for long enough for its stall to be learned: WebKit's element is judged only a second and a
    // bit after it was put (the player's SLOW_SEEK_SETTLE_MS).
    await playFrom(r, 5000);
    await playTo(r, 6500);
    r.player.pause();
    const plays = r.music.plays.length;
    // 175 ms short of the end of the file: with the 100 ms lead learned on that first play, the put
    // would land in the last 100 ms, where a playing element is sent round.
    await playFrom(r, 11_800);
    await playTo(r, 12_600);
    // Put once, onto the next pass, as soon as the start stall would carry it over the seam. Put on
    // what is left of this pass, it came out of the stall only to be sent round into another.
    const puts = r.music.puts.filter(put => put.playheadMs >= 11_800);
    expect(puts).toHaveLength(1);
    expect(puts[0].playing).toBe(false);
    expect(puts[0].toS).toBeLessThan(0.1);
    expect(r.music.plays.length).toBe(plays + 1);
    expect(r.music.paused).toBe(false);
    expect(Math.abs(driftMs(r))).toBeLessThan(200);
  });

  it('sends a section hardly longer than its stall round once at each seam, not twice', async () => {
    // 300 ms of the track, looped: which pass the playhead is on is a guess this close, and a put aimed
    // at the end of the next pass used to be sent round again 50 ms later, as it came out of its stall.
    const r = await rig('webkit', { ...LOOPED, inMs: 1000, outMs: 1300 });
    await playFrom(r, 0);
    await playTo(r, 6000);
    const puts = r.music.puts.filter(put => put.playing);
    expect(puts.length).toBeGreaterThan(10);
    // Never one put inside the stall of the one before it.
    for (let i = 1; i < puts.length; i++) expect(puts[i].playheadMs - puts[i - 1].playheadMs).toBeGreaterThan(100);
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
    expect(r.music.paused).toBe(false);
  });

  it('plays its last pass out and is not started again, where the sound stops at a seam', async () => {
    // Stopped after exactly two passes, on a video that goes on past them.
    const r = await rig('webkit', { ...LOOPED, endMs: 2 * SECTION_MS });
    await playFrom(r, 23_300);
    await playTo(r, 23_400);
    const puts = r.music.puts.length;
    const plays = r.music.plays.length;
    await playTo(r, 24_500);
    expect(r.music.puts.length).toBe(puts);
    expect(r.music.plays.length).toBe(plays);
    expect(r.music.paused).toBe(true);
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
  });
});

/*
 * The same tone with the length iOS's composer reads it as: its audio track runs to 12.000 s, which is
 * where the iOS render loops it (`CompositionBuilder.audioSource`) and what `probe` answers for a file
 * with no video, so that is the section the post plays - while WebKit's element still reads the file as
 * 11.975 s and has nothing to play for the last 25 ms of every pass.
 */
const TRACK_SECTION_MS = 12_000;
const LOOPED_TRACK: EditMusic = { ...LOOPED, sourceDurationMs: TRACK_SECTION_MS };

/** How far the element is from where the playhead has it, round a 12.000 s loop. */
function trackDriftMs(r: Rig): number {
  const want = r.store.playheadMs.value % TRACK_SECTION_MS;
  let off = r.music.currentTime * 1000 - want;
  if (off > TRACK_SECTION_MS / 2) off -= TRACK_SECTION_MS;
  if (off < -TRACK_SECTION_MS / 2) off += TRACK_SECTION_MS;
  return off;
}

describe('a repeating track whose file WebKit reads 25 ms short of its section', () => {
  it('waits, paused and not seeked, when its element ends 25 ms before the section does, and goes round with the playhead', async () => {
    const r = await rig('webkit', LOOPED_TRACK);
    // A play somewhere else first, so the element's 100 ms stall is learned and it runs in step: long
    // enough for WebKit's element to be judged, a second and a bit after it was put.
    await playFrom(r, 5000);
    await playTo(r, 6500);
    r.player.pause();
    // Started here, the frame loop looks at the element at 11.836 s, 11.884 s and 11.932 s of the post.
    // At 11.884 s it has ended its file, and a put with its stall would land 16 ms into the 25 ms the
    // file lacks: sent round then, it would start the next pass 16 ms early.
    await playFrom(r, 11_020);
    await playTo(r, 11_815);
    // It runs 112 ms ahead, into the end guard, where nothing may move it, and ends its file at 11.863 s
    // of the post - 137 ms before the end of the section: the 25 ms the element does not have, and how
    // far ahead it ran.
    r.music.jumpTo((r.store.playheadMs.value + 112) / 1000);
    const puts = r.music.puts.length;
    const loads = r.music.loads;

    let lastS = r.music.currentTime;
    let wentBack = false;
    await playTo(r, 12_600, () => {
      // Never put back over the tail it has already played.
      if (r.music.currentTime < lastS - 0.001 && r.music.currentTime > 1) wentBack = true;
      lastS = r.music.currentTime;
    });
    expect(wentBack).toBe(false);
    const after = r.music.puts.slice(puts);
    expect(after).toHaveLength(1);
    // Put paused: once WebKit had said it had ended, and never between the end of its file and then.
    expect(after[0].playing).toBe(false);
    expect(after[0].fromS).toBeCloseTo(TRACK_S, 6);
    // And only once its stall carries it past the end of the SECTION: onto the next pass where the
    // playhead will be by then, not onto the in point early by what the file lacks.
    const dueMs = after[0].playheadMs + 100 - TRACK_SECTION_MS;
    expect(dueMs).toBeGreaterThanOrEqual(0);
    expect(after[0].toS * 1000).toBeCloseTo(dueMs, 3);
    // Its length never cut short, so never loaded again, and playing in step on the next pass.
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
    expect(r.music.loads).toBe(loads);
    expect(r.music.paused).toBe(false);
    expect(Math.abs(trackDriftMs(r))).toBeLessThan(5);
  });

  it('goes round every seam without reaching the end of its file, and stays within the drift allowed', async () => {
    const r = await rig('webkit', LOOPED_TRACK);
    // A play somewhere else first, so the element's stall is learned and it starts in step: long enough
    // for WebKit's element to be judged, a second and a bit after it was put.
    await playFrom(r, 5000);
    await playTo(r, 6500);
    r.player.pause();
    await playFrom(r, 0);
    const first = r.music.puts.length;
    const pauses = r.music.pauses.length;
    const loads = r.music.loads;
    let furthestS = 0;
    let worstMs = 0;
    await playTo(r, 29_000, () => {
      furthestS = Math.max(furthestS, r.music.currentTime);
      if (r.store.playheadMs.value > 1000) worstMs = Math.max(worstMs, Math.abs(trackDriftMs(r)));
    });
    // Two seams, each a put of a playing element made clear of the end guard - and no other put, so the
    // drift check never had to step in. None lands between the end of its file and WebKit's notice of
    // it, so its length is never cut short.
    const seams = r.music.puts.slice(first);
    expect(seams).toHaveLength(2);
    for (const put of seams) {
      expect(TRACK_S - put.fromS).toBeGreaterThanOrEqual(0.05);
      expect(put.toS).toBeLessThan(0.05);
    }
    expect(furthestS).toBeLessThan(TRACK_S - 0.05);
    expect(r.music.pauses).toHaveLength(pauses);
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
    expect(r.music.loads).toBe(loads);
    // A playing element is sent round a stall before the end of its file, and has nothing to play for
    // the rest of the section, so a pass can start up to 25 ms early. In its stall it is a stall ahead
    // at most, and after it no further off than the drift allowed; the drift check would put it back.
    expect(worstMs).toBeLessThan(200 + 100);
    expect(Math.abs(trackDriftMs(r))).toBeLessThan(200);
  });
});

describe('a repeating track at its seams, on Chromium', () => {
  it('goes round without stopping at the end of the file first', async () => {
    const r = await rig('chromium', LOOPED);
    await playFrom(r, 11_000);
    const pausesBefore = r.music.pauses.length;
    await playTo(r, 12_700);
    const seam = putsBetween(r.music, 11_300, 12_700);
    expect(seam).toHaveLength(1);
    expect(seam[0].playing).toBe(true);
    expect(seam[0].toS).toBeLessThan(0.15);
    // It used to stop at the end of its file and wait there for the playhead: up to 100 ms of nothing.
    expect(r.music.pauses.length).toBe(pausesBefore);
    expect(r.music.paused).toBe(false);
  });

  it('sends a section that stops short of the end of its file round before it plays past the out point', async () => {
    // Seconds 2 to 5 of the track, from the top of the post: the seam at 3 s, 6 s, 9 s of the post.
    const r = await rig('chromium', { ...LOOPED, inMs: 2000, outMs: 5000 });
    await playFrom(r, 5200);
    let furthestS = 0;
    await playTo(r, 6800, () => {
      furthestS = Math.max(furthestS, r.music.currentTime);
    });
    expect(furthestS).toBeLessThanOrEqual(5);
    const seam = putsBetween(r.music, 5300, 6800);
    expect(seam).toHaveLength(1);
    expect(seam[0].toS).toBeGreaterThanOrEqual(2);
    expect(seam[0].toS).toBeLessThan(2.15);
    expect(r.music.paused).toBe(false);
  });

  it('puts an element found far past the out point back where the playhead is, not onto the next pass', async () => {
    // Seconds 2 to 5 again. Something else has left the element at 8 s - an edit that moved the
    // section under it, say - while the playhead is 4 s into the track: a drift, not a seam.
    const r = await rig('chromium', { ...LOOPED, inMs: 2000, outMs: 5000 });
    await playFrom(r, 1500);
    await playTo(r, 2000);
    r.music.jumpTo(8);
    const puts = r.music.puts.length;
    await playTo(r, 2600);
    const after = r.music.puts.slice(puts);
    expect(after).toHaveLength(1);
    expect(after[0].toS * 1000 - (2000 + after[0].playheadMs)).toBeGreaterThanOrEqual(0);
    expect(after[0].toS * 1000 - (2000 + after[0].playheadMs)).toBeLessThan(300);
  });
});

/*
 * A sound that stops: a section heard once, and a voiceover take. Its element runs ahead of the
 * playhead - in this rig because the lead it is started with is longer than its stall, in Chromium
 * because the element runs 60-90 ms ahead of the picture - and so gets to its end first. It used to be
 * put back where the playhead was and started again, and the last tenth of a second was heard twice.
 */

/**
 * Plays `r` on to `toMs` and says whether `el` was ever seen to go BACK in its file once the playhead
 * was past `fromMs`: put back over something it had already played.
 */
async function wentBack(r: Rig, el: FakeMedia, fromMs: number, toMs: number): Promise<boolean> {
  let lastS = el.currentTime;
  let back = false;
  await playTo(r, toMs, () => {
    if (r.store.playheadMs.value >= fromMs && el.currentTime < lastS - 0.001) back = true;
    lastS = el.currentTime;
  });
  return back;
}

describe('a section heard once, at its out point', () => {
  for (const engine of ['chromium', 'webkit'] as const) {
    it(`stops there, and is not put back to play its last moment again, on ${engine}`, async () => {
      // Seconds 2 to 5 of the track, from the top of the post. A 10 ms stall on Chromium, where the
      // element is furthest ahead.
      const r = await rig(engine, { ...LOOPED, loop: false, inMs: 2000, outMs: 5000 }, { stallMs: engine === 'chromium' ? 10 : 100 });
      await playFrom(r, 0);
      await playTo(r, 2500);
      const puts = r.music.puts.length;
      const plays = r.music.plays.length;
      expect(await wentBack(r, r.music, 2500, 3500)).toBe(false);

      expect(r.music.puts.length).toBe(puts);
      expect(r.music.plays.length).toBe(plays);
      expect(r.music.paused).toBe(true);
      // At the out point, give or take the check it was seen past it at.
      expect(r.music.currentTime).toBeGreaterThanOrEqual(5);
      expect(r.music.currentTime).toBeLessThan(5.06);
    });
  }

  it('is heard again from where the playhead is moved back to, however near the end that is', async () => {
    const r = await rig('chromium', { ...LOOPED, loop: false, inMs: 2000, outMs: 5000 }, { stallMs: 10 });
    await playFrom(r, 0);
    await playTo(r, 3200);
    expect(r.music.paused).toBe(true);
    // Back to 150 ms before the out point, which the element had played ahead of the playhead.
    await playFrom(r, 2850);
    await playTo(r, 2900);
    expect(r.music.paused).toBe(false);
    expect(r.music.currentTime).toBeLessThan(5);
  });
});

describe('a voiceover take, at its end', () => {
  for (const engine of ['chromium', 'webkit'] as const) {
    // The file as long as the take, a little longer - a take recorded on past where it was cut - and
    // 25 ms shorter: a take iOS's composer reads to its audio track's end, which WebKit reads short.
    for (const fileS of [2, 2.1, 1.975]) {
      it(`plays out once and is not started again, on ${engine}, from a ${fileS} s file`, async () => {
        const take: EditVoiceover = { id: 'v', uri: 'blob:capacitor://localhost/voice', startMs: 5000, durationMs: 2000, volume: 1 };
        const r = await rig(engine, null, { take: { take, fileS } });
        await playFrom(r, 4000);
        expect(await wentBack(r, r.voice, 5500, 9000)).toBe(false);

        // Put once, at its start, and started once: never put back to the start of its file once it
        // had ended - which is what `play()` does to an element left at the end - nor over its tail.
        expect(r.voice.puts.filter(put => put.playheadMs > 5500)).toHaveLength(0);
        expect(r.voice.plays).toHaveLength(1);
        expect(r.voice.paused).toBe(true);
        expect(r.voice.duration).toBeCloseTo(fileS, 6);
      });
    }
  }
});

/*
 * The music on an iPhone, where a post with a level for it - the 80 % and the one-second fade-out a new
 * sound comes with - plays it through the preview's mixer, and its element is then ROUTED for good (see
 * [PreviewMixer]). A routed element's clock is not slow: left alone it runs at 1.00x. What it has is a
 * long, uneven stall after every start and every seek (see [RoutedStall]), and the preview used to read
 * it as a drift: it measured the stall a few hundred milliseconds in, before most of it had happened,
 * found the element 200 ms behind the picture about 0.7 s after every put, and put it again - 86 seeks a
 * minute on the iOS 26.5 simulator, and the music at 0.6x. These pin that it is put in step and then
 * left to play.
 */

/** The looped tone at the level a new sound comes with, which is what sends it through the mixer. */
const ROUTED_TRACK: EditMusic = { ...LOOPED, volume: 0.8 };

interface Sample {
  wallMs: number;
  playheadMs: number;
  elementS: number;
  driftMs: number;
  /** How many puts the element had had by then. */
  puts: number;
}

/** Plays `r` on to `toMs`, reading the music element once a frame. */
async function sampleTo(r: Rig, toMs: number): Promise<Sample[]> {
  const samples: Sample[] = [];
  await playTo(r, toMs, () => {
    samples.push({ wallMs: performance.now(), playheadMs: r.store.playheadMs.value, elementS: r.music.currentTime, driftMs: driftMs(r), puts: r.music.puts.length });
  });
  return samples;
}

/**
 * The samples taken once `quietMs` had gone by since the element was last put: where it has settled,
 * rather than inside the stall of a put, where a slow-to-seek element is expected to be off by up to its
 * lead.
 */
function settled(samples: readonly Sample[], quietMs: number): Sample[] {
  // The first sample to see each count of puts stands for when that put was made: the checks that
  // make them run on the same frames as the samples.
  const putAt = new Map<number, number>();
  for (const sample of samples) if (!putAt.has(sample.puts)) putAt.set(sample.puts, sample.wallMs);
  return samples.filter(sample => sample.wallMs - (putAt.get(sample.puts) ?? 0) >= quietMs);
}

/** How fast the element's clock ran against the post's between two samples with no put between them. */
function rateBetween(samples: readonly Sample[], fromMs: number, toMs: number): number {
  const a = samples.find(sample => sample.playheadMs >= fromMs);
  const b = samples.find(sample => sample.playheadMs >= toMs);
  if (!a || !b) throw new Error('not sampled');
  expect(b.puts).toBe(a.puts);
  return ((b.elementS - a.elementS) * 1000) / (b.playheadMs - a.playheadMs);
}

describe('a track played through the mixer, on an iPhone', () => {
  it('is put in step once, and then left to play at its own speed: no put after put', async () => {
    const r = await rig('webkit', ROUTED_TRACK, { iphone: true });
    await playFrom(r, 0);
    const samples = await sampleTo(r, 29_000);
    expect(r.music.routed).toBe(true);

    // The play's own put to start it, and two more in 29 s, both of them the seams, each a playing
    // element sent round onto the next pass: no correction in between, where the old measure put it
    // again every 0.7 s (48 puts over the same 29 s).
    expect(r.music.puts).toHaveLength(3);
    expect(r.music.puts[0].playing).toBe(false);
    const puts = r.music.puts.filter(put => put.playing);
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put.playing).toBe(true);
      expect(put.fromS).toBeGreaterThan(11);
      expect(put.toS).toBeLessThan(0.1);
    }
    // At the post's own speed between them...
    expect(rateBetween(samples, 2000, 11_000)).toBeCloseTo(1, 2);
    expect(rateBetween(samples, 14_000, 23_000)).toBeCloseTo(1, 2);
    // ...and in step with the picture once each put's stall is over.
    const steady = settled(samples, 1300);
    expect(steady.length).toBeGreaterThan(1000);
    for (const sample of steady) expect(Math.abs(sample.driftMs)).toBeLessThan(40);
    expect(r.music.paused).toBe(false);
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
  });

  it('learns a stall longer than it expected from the first put, and is in step from the next seam, with no put in between', async () => {
    const r = await rig('webkit', ROUTED_TRACK, { iphone: true });
    r.music.routedStall = { afterMs: 300, forMs: 600 };
    await playFrom(r, 0);
    const samples = await sampleTo(r, 29_000);

    // 160 ms behind after the first put - inside what a routed element is allowed - and so left to play
    // rather than put again; the stall that put measured is what the seams are put with.
    expect(r.music.puts).toHaveLength(3);
    expect(r.music.puts.filter(put => put.playing)).toHaveLength(2);
    const steady = settled(samples, 1300);
    for (const sample of steady) expect(Math.abs(sample.driftMs)).toBeLessThan(200);
    for (const sample of steady.filter(one => one.playheadMs > 13_500)) expect(Math.abs(sample.driftMs)).toBeLessThan(40);
    expect(rateBetween(samples, 2000, 11_000)).toBeCloseTo(1, 2);
  });

  it('is put back once when it is knocked well out of step, and left alone when it is knocked a little', async () => {
    const r = await rig('webkit', ROUTED_TRACK, { iphone: true });
    await playFrom(r, 0);
    await playTo(r, 3000);
    const puts = r.music.puts.length;

    // A quarter of a second ahead: inside the drift allowed a routed element, whose every put costs it
    // a second of uneven clock. Left where it is.
    r.music.jumpTo(r.music.currentTime + 0.25);
    await playTo(r, 5000);
    expect(r.music.puts.length).toBe(puts);

    // Half a second further: put back, once, and then left to play in step.
    r.music.jumpTo(r.music.currentTime + 0.5);
    const samples = await sampleTo(r, 10_000);
    expect(r.music.puts.length).toBe(puts + 1);
    for (const sample of settled(samples, 1300)) expect(Math.abs(sample.driftMs)).toBeLessThan(40);
  });

  it("is judged as Chromium's is when it is not routed: put back as soon as it is 200 ms out", async () => {
    // The same phone and the same track at full level with no fades: nothing for the mixer to do, so
    // the element is never routed and loses only about 45 ms to a put. It is NOT slow to seek, and is
    // judged as Chromium's element is. Judged over the long second with the 300 ms a Mac's is allowed,
    // it was left about 0.3 s ahead of a phone's slow-to-start picture for a whole pass, and each seam
    // carried that on (the iOS 26.5 simulator, 2026-09-29): a knock under 300 ms is the case that
    // tells the two rules apart.
    const r = await rig('webkit', { ...ROUTED_TRACK, volume: 1 }, { iphone: true, stallMs: 45 });
    await playFrom(r, 0);
    await playTo(r, 3000);
    expect(r.music.routed).toBe(false);
    // Started with the lead every element starts from, and not a Mac's.
    expect(r.music.puts[0].toS).toBeCloseTo(0.18, 3);
    const puts = r.music.puts.length;
    // Moved to 250 ms ahead of the picture, wherever the start left it: past the 200 ms this element is
    // allowed, and inside the 300 ms a slow-to-seek one would be, which is what the phone got wrong.
    r.music.jumpTo(r.music.currentTime + (250 - driftMs(r)) / 1000);
    expect(driftMs(r)).toBeGreaterThan(230);
    expect(driftMs(r)).toBeLessThan(270);
    const jumpedAtMs = r.store.playheadMs.value;
    await playTo(r, jumpedAtMs + 100);
    expect(r.music.puts.length).toBe(puts + 1);
    // Seen at the next check the frame loop makes of it - every 33 ms, and sometimes a frame later.
    const [put] = r.music.puts.slice(puts);
    expect(put.playheadMs - jumpedAtMs).toBeLessThan(60);
    const samples = await sampleTo(r, 11_000);
    expect(r.music.puts.length).toBe(puts + 1);
    for (const sample of settled(samples, 400)) expect(Math.abs(sample.driftMs)).toBeLessThan(40);
    expect(rateBetween(samples, 4000, 11_000)).toBeCloseTo(1, 2);
  });
});

/*
 * The music in WebKit on a Mac - Safari, and the web editor's own checks in Playwright's build of it -
 * which can set `volume`, so the preview's mixer never starts and the element is never routed. Its
 * clock stalls after every put all the same, about as long and as unevenly as a routed iPhone's (see
 * [MAC_STALLS]), and the preview judged it as it judges Chromium's: a few hundred milliseconds in, with
 * the first part of the stall lost and the rest still to come. It found it more than 200 ms behind
 * 0.7 s later, put it again into another stall, and did so again: up to 30 seeks in a 24 s play, 2 or 3
 * corrections after most seams, and twice a correction that landed just before a seam waited there,
 * paused, for it. These pin that it is judged as a routed element is - once its whole stall is over -
 * and that it starts from leads close to what a Mac's start and a Mac's seek cost, a kind at a time:
 * a lead that misses by less than the 300 ms it is then allowed is not put right until the next put.
 */
describe('a track in WebKit on a Mac, which routes nothing', () => {
  it('is put once to start and once at each seam, and left to play at its own speed: no put after put', async () => {
    const r = await rig('webkit', ROUTED_TRACK, { mac: true });
    r.music.unevenStalls = MAC_STALLS;
    await playFrom(r, 0);
    const pauses = r.music.pauses.length;
    const samples = await sampleTo(r, 29_000);
    expect(r.music.routed).toBe(false);

    // The play's own put to start it, and one at each of the two seams, each a playing element sent
    // round onto the next pass: no correction in between, and none after a seam.
    expect(r.music.puts).toHaveLength(3);
    expect(r.music.puts[0].playing).toBe(false);
    const seams = r.music.puts.filter(put => put.playing);
    expect(seams).toHaveLength(2);
    for (const put of seams) {
      expect(put.fromS).toBeGreaterThan(11);
      expect(TRACK_S - put.fromS).toBeGreaterThanOrEqual(0.05);
      expect(put.toS).toBeLessThan(0.2);
    }
    // Never stopped to wait for a seam, never cut short.
    expect(r.music.pauses).toHaveLength(pauses);
    expect(r.music.paused).toBe(false);
    expect(r.music.duration).toBeCloseTo(TRACK_S, 6);
    // At the post's own speed between the seams...
    expect(rateBetween(samples, 2000, 11_000)).toBeCloseTo(1, 2);
    expect(rateBetween(samples, 14_000, 23_000)).toBeCloseTo(1, 2);
    // ...and, once each stall is over, as far out as the lead it was put with misses that put's stall
    // by, and no further - read against the playhead signal, which is written every 33 ms and so reads
    // up to that much more. It is not put right before its next put, whatever it misses by inside the
    // 300 ms it is allowed, so each pass is pinned on its own:
    const steady = settled(samples, 1300);
    expect(steady.length).toBeGreaterThan(1000);
    const pass = (puts: number): Sample[] => steady.filter(sample => sample.puts === puts);
    // the first, by what its 310 ms start misses the 280 ms a Mac's start is put with before one has
    // been measured - where the 180 ms every other element starts from had it 130 ms behind the picture
    // for the whole of the pass;
    expect(pass(1).length).toBeGreaterThan(500);
    for (const sample of pass(1)) expect(Math.abs(sample.driftMs)).toBeLessThan(30 + 40);
    // the second, by what the first seam's 440 ms misses the 420 a seek is put with before one has been
    // measured - and not the 310 the start taught it, which a seek costs 130 ms more than;
    expect(pass(2).length).toBeGreaterThan(500);
    for (const sample of pass(2)) expect(Math.abs(sample.driftMs)).toBeLessThan(20 + 40);
    // and the third by what the second seam's 400 ms misses the 440 the first one taught it.
    expect(pass(3).length).toBeGreaterThan(200);
    for (const sample of pass(3)) expect(Math.abs(sample.driftMs)).toBeLessThan(40 + 40);
  });

  it('is in step with the picture a second into the first play of the page, on a track heard once', async () => {
    // Nothing measured yet on this page, and a track that does not repeat, so the play's one put is the
    // only one there is: whatever lead it is put with, the music is that far out for the whole play.
    const r = await rig('webkit', { ...ROUTED_TRACK, loop: false }, { mac: true });
    r.music.unevenStalls = MAC_STALLS;
    await playFrom(r, 0);
    const samples = await sampleTo(r, 11_000);
    expect(r.music.puts).toHaveLength(1);
    expect(r.music.puts[0].playing).toBe(false);
    // Put with a Mac's start lead, 280 ms, where it used to be put with every engine's 180...
    expect(r.music.puts[0].toS).toBeCloseTo(0.28, 3);
    // ...so once its 310 ms start is over it is 30 ms behind, and stays there, where it was 130.
    const steady = settled(samples, 1300);
    expect(steady.length).toBeGreaterThan(500);
    for (const sample of steady) expect(Math.abs(sample.driftMs)).toBeLessThan(30 + 40);
    expect(rateBetween(samples, 2000, 10_000)).toBeCloseTo(1, 2);
  });

  it('comes out of a play started anywhere with one put, and goes round the next seam with one more', async () => {
    // Plays started one after another, as a customer scrubbing and playing does: every start is a put
    // with a stall of its own, and none of them may set off a chain of corrections.
    const r = await rig('webkit', ROUTED_TRACK, { mac: true });
    r.music.unevenStalls = MAC_STALLS;
    for (const fromMs of [2000, 5000, 8000]) {
      const puts = r.music.puts.length;
      await playFrom(r, fromMs);
      await playTo(r, fromMs + 2500);
      r.player.pause();
      // The start's put - made on the first frame the picture is seen moving - and nothing after it
      // while its stall came and went.
      expect(r.music.puts.length).toBe(puts + 1);
      expect(lastPut(r.music).playing).toBe(false);
    }
    // And through a seam: a start 1.5 s short of it, the seam's put, and nothing else.
    const puts = r.music.puts.length;
    await playFrom(r, 10_500);
    await playTo(r, 10_600);
    const pauses = r.music.pauses.length;
    await playTo(r, 14_000);
    const after = r.music.puts.slice(puts);
    expect(after).toHaveLength(2);
    expect(after[0].playing).toBe(false);
    expect(after[1].playing).toBe(true);
    expect(after[1].fromS).toBeGreaterThan(11);
    expect(after[1].toS).toBeLessThan(0.2);
    expect(r.music.pauses).toHaveLength(pauses);
    expect(r.music.paused).toBe(false);
  });
});

/*
 * Chromium's element - on a desktop, and in Android's WebView - loses a few tens of milliseconds at
 * once after a put and is then in step, which is what the player's AUDIO_SETTLED_MS was written for.
 * It is judged exactly as it always was.
 */
describe('a track on Chromium', () => {
  it("is put back as soon as it is 200 ms out, with the short stall, at a new sound's level", async () => {
    const r = await rig('chromium', ROUTED_TRACK, { stallMs: 45 });
    await playFrom(r, 0);
    await playTo(r, 3000);
    expect(r.music.routed).toBe(false);
    const puts = r.music.puts.length;
    r.music.jumpTo(r.music.currentTime + 0.25);
    const jumpedAtMs = r.store.playheadMs.value;
    await playTo(r, jumpedAtMs + 100);
    expect(r.music.puts.length).toBe(puts + 1);
    // Seen at the next check the frame loop makes of it - every 33 ms, and sometimes a frame later.
    const [put] = r.music.puts.slice(puts);
    expect(put.playheadMs - jumpedAtMs).toBeLessThan(60);
    const samples = await sampleTo(r, 11_000);
    expect(r.music.puts.length).toBe(puts + 1);
    for (const sample of settled(samples, 400)) expect(Math.abs(sample.driftMs)).toBeLessThan(40);
    expect(rateBetween(samples, 4000, 11_000)).toBeCloseTo(1, 2);
  });
});
