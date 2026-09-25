import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyManifest, type EditClip, type EditManifest, type EditMusic, type EditVoiceover } from '../../editor';
import type { EditorSource } from '../../host/host.types';
import type { EditorStore } from '../../state/editor-store';
import type { ClipMedia } from './clip-media';
import type { PreviewPlayer } from './preview-player';
import { levelsInUse, playableHere } from './preview-mixer';

/*
 * The preview's music and voiceover on a WebView that ignores `volume`, which is iOS: played through
 * one Web Audio context with a gain each, so the levels the render mixes them at are heard - and on
 * every condition that would make that silence instead, not touched at all.
 *
 * The player is driven for real, from a real store, over stand-ins for its elements and for Web
 * Audio: nothing here can decode, and nothing needs to, because what is pinned is what is ASKED of
 * the elements and of the graph. Each case imports the player afresh, because what the WebView does
 * with a volume is asked once and remembered for the life of the page, and so is the context.
 */

/**
 * The platform's own `Event`. The mock DOM puts one of its own in the global's place, and the
 * platform's `EventTarget` - which [ClipMedia], and every stand-in below, extends - refuses to
 * dispatch it. An aborted signal fires the platform's, which is where it is taken from.
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

/**
 * A media element as the player drives one, with nothing to decode: a load answers with its
 * metadata a task later, a seek with `seeked`, and `play` and `pause` say so at once. Every volume
 * written to it is kept. `honoursVolume` false is iOS, where the write changes nothing and `volume`
 * reads back 1.
 */
class FakeMedia extends EventTarget {
  src = '';
  paused = true;
  ended = false;
  seeking = false;
  muted = false;
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  duration = Number.NaN;
  error = null;
  playbackRate = 1;
  preservesPitch = true;
  readonly volumeWrites: number[] = [];
  private level = 1;
  private time = 0;

  constructor(private readonly honoursVolume: boolean) {
    super();
  }

  get volume(): number {
    return this.honoursVolume ? this.level : 1;
  }

  set volume(volume: number) {
    this.volumeWrites.push(volume);
    if (this.honoursVolume) this.level = volume;
  }

  get currentTime(): number {
    return this.time;
  }

  set currentTime(seconds: number) {
    this.time = seconds;
    this.seeking = true;
    setTimeout(() => {
      this.seeking = false;
      this.fire('seeked');
    }, 0);
  }

  load(): void {
    this.readyState = 0;
    if (!this.src) return;
    setTimeout(() => {
      this.readyState = 4;
      this.videoWidth = 16;
      this.videoHeight = 16;
      this.duration = 60;
      this.fire('loadedmetadata');
    }, 0);
  }

  play(): Promise<void> {
    if (this.paused) {
      this.paused = false;
      this.fire('play');
    }
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.fire('pause');
  }

  /** `poster`, which nothing here draws. */
  setAttribute(): void {
    /* Nothing to set. */
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  private fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

class FakeNode {
  readonly outputs = new Set<unknown>();

  connect<T>(node: T): T {
    this.outputs.add(node);
    return node;
  }

  disconnect(): void {
    this.outputs.clear();
  }
}

class FakeGain extends FakeNode {
  readonly gain = { value: 1 };
}

class FakeSource extends FakeNode {
  constructor(readonly element: FakeMedia) {
    super();
  }
}

/**
 * An `AudioContext` that starts suspended, as WebKit's does, and runs once resumed - unless [runs]
 * says this one never will, which is a phone in a call, or a resume WebKit did not count as a tap.
 * Both a resume and a suspend land a task later, as WebKit's do, so a pause can come in between. A
 * second source for the same element throws, as it does in every browser, and so does one for
 * [refuses], which is an element tied to some other context already.
 */
class FakeContext {
  static made: FakeContext[] = [];
  static runs = true;
  static refuses: FakeMedia | null = null;

  state: AudioContextState = 'suspended';
  readonly destination = {};
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  /** Every source asked of it, refused or not. */
  asked = 0;

  constructor() {
    FakeContext.made.push(this);
  }

  resume(): Promise<void> {
    return new Promise(resolve =>
      setTimeout(() => {
        if (FakeContext.runs) this.state = 'running';
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

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createMediaElementSource(element: FakeMedia): FakeSource {
    this.asked++;
    if (element === FakeContext.refuses || this.sources.some(source => source.element === element)) {
      throw new DOMException('already routed', 'InvalidStateError');
    }
    const source = new FakeSource(element);
    this.sources.push(source);
    return source;
  }

  /** The elements handed to the graph, in the order they were. */
  routed(): FakeMedia[] {
    return this.sources.map(source => source.element);
  }

  /** The gain `element` reaches the speaker through, when it does. */
  gainOf(element: FakeMedia): FakeGain | undefined {
    const source = this.sources.find(one => one.element === element);
    return [...(source?.outputs ?? [])].find((node): node is FakeGain => node instanceof FakeGain);
  }
}

function clip(id: string, extra: Partial<EditClip> = {}): EditClip {
  return { id, clipKey: id, inMs: 0, outMs: 4000, speed: 1, volume: 1, muted: false, ...extra };
}

const SOURCES: EditorSource[] = ['a', 'b'].map(key => ({ key, fileName: `${key}.mp4`, playbackUrl: `blob:capacitor://localhost/${key}` }));

/** Faded out over the last second of the post, from 80 %. */
const MUSIC: EditMusic = {
  uri: 'capacitor://localhost/_capacitor_file_/sounds/track.m4a',
  fileName: 'track.m4a',
  sourceDurationMs: 60_000,
  inMs: 0,
  outMs: 0,
  startMs: 0,
  volume: 0.8,
  loop: false,
  fadeOutMs: 1000,
};

/** Under the playhead from 3 s to 4 s, at 30 %. */
const TAKE: EditVoiceover = { id: 'take', uri: 'capacitor://localhost/_capacitor_file_/voice/take.m4a', startMs: 3000, durationMs: 1000, volume: 0.3 };

/** One four-second clip, unless the case says otherwise. */
function post(extra: Partial<EditManifest> = {}): EditManifest {
  return { ...emptyManifest(), clips: [clip('a')], ...extra };
}

/** Enough turns of the event loop for a load, the seek it ends in and a context's resume to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** Waits, a frame at a time, for something that takes the wall clock rather than the event loop. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 16));
  expect(check()).toBe(true);
}

/**
 * The WebView's answer to a volume, as iOS gives it: the write is dropped and 1 is read back. Every
 * `<audio>` made - which here is only ever the mixer's stand-in for an element in the graph - is a
 * [FakeMedia] like the rest, and is kept in `made`.
 */
function likeIos(made: FakeMedia[]): void {
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'audio') {
      const audio = new FakeMedia(false);
      made.push(audio);
      return audio;
    }
    const element = create(tag);
    if (tag === 'video') Object.defineProperty(element, 'volume', { get: () => 1, set: () => undefined });
    return element;
  }) as typeof document.createElement);
}

/** WebKit's Audio Session API as a page finds it, on a phone that leaves the type to WebKit. */
function autoSession(): { type: string } {
  return { type: 'auto' };
}

/** The API on a WebView that keeps the type it has whatever the page writes. */
function deafSession(): { type: string } {
  return {
    get type() {
      return 'auto';
    },
    set type(_type: string) {
      /* Kept as it was. */
    },
  };
}

/** The API on a WebView that throws at the write. */
function refusingSession(): { type: string } {
  return {
    get type() {
      return 'auto';
    },
    set type(_type: string) {
      throw new DOMException('not now', 'NotAllowedError');
    },
  };
}

/** Gives the page `session` as `navigator.audioSession`; null is a WebView without the API. */
function useSession(session: { type: string } | null): void {
  if (session) Object.defineProperty(navigator, 'audioSession', { value: session, configurable: true });
}

interface Rig {
  store: EditorStore;
  player: PreviewPlayer;
  /** The base track's two elements: the first is the clock until something swaps them. */
  decks: readonly [FakeMedia, FakeMedia];
  music: FakeMedia;
  voice: FakeMedia;
  /** The stand-ins made so far; see [PreviewMixer.elementFor]. */
  standIns: FakeMedia[];
  session: { type: string } | null;
  /** A second player over the same elements, as the component builds one when it is put back. */
  rebuild(): PreviewPlayer;
}

interface RigOptions {
  /** A WebView that ignores `volume`, which is the case for everything the mixer does. */
  ios?: boolean;
  session?: { type: string } | null;
}

const players: PreviewPlayer[] = [];

async function rig(manifest: EditManifest, { ios = true, session = autoSession() }: RigOptions = {}): Promise<Rig> {
  vi.resetModules();
  const standIns: FakeMedia[] = [];
  if (ios) likeIos(standIns);
  useSession(session);

  const { EditorStore } = await import('../../state/editor-store');
  const { resolveEditorHost } = await import('../../host/defaults');
  const { ClipMedia } = await import('./clip-media');
  const { PreviewPlayer } = await import('./preview-player');

  const store = new EditorStore(resolveEditorHost({}));
  store.load(SOURCES, new Map(SOURCES.map(source => [source.key, 4000])), manifest);
  const decks = [new FakeMedia(!ios), new FakeMedia(!ios)] as const;
  const music = new FakeMedia(!ios);
  const voice = new FakeMedia(!ios);
  const slot = (element: FakeMedia): ClipMedia => new ClipMedia(element as unknown as HTMLVideoElement);
  const build = (): PreviewPlayer => {
    const player = new PreviewPlayer(store, {
      video: slot(decks[0]),
      partner: slot(decks[1]),
      music: music as unknown as HTMLAudioElement,
      voice: voice as unknown as HTMLAudioElement,
      extraLayers: () => [],
    });
    players.push(player);
    player.start();
    return player;
  };
  const player = build();
  await settle();
  return { store, player, decks, music, voice, standIns, session, rebuild: build };
}

/** Puts the playhead at `ms` and plays from there, as a tap on Play does. */
async function playFrom(r: Rig, ms: number): Promise<void> {
  r.player.seek(ms);
  await settle();
  r.player.play();
  await settle();
}

beforeEach(() => {
  FakeContext.made = [];
  FakeContext.runs = true;
  FakeContext.refuses = null;
  vi.stubGlobal('Event', PLATFORM_EVENT);
  // A display's frame. The mock DOM's is a zero-delay timer, which runs a playing player's frame
  // loop as fast as the event loop turns - and that is CPU taken from the browser suite beside this
  // one, whose cases time real frames.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  vi.stubGlobal('AudioContext', FakeContext);
  // The page as the app on iOS serves it, which is what "this page's own file" is measured against.
  vi.stubGlobal('location', new URL('capacitor://localhost/'));
});

afterEach(() => {
  for (const player of players.splice(0)) player.destroy();
  Reflect.deleteProperty(navigator, 'audioSession');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the preview on a WebView that ignores volume', () => {
  it('plays the music and a take through the mixer, at the levels the render mixes them at', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    await playFrom(r, 3500);

    expect(FakeContext.made).toHaveLength(1);
    const [context] = FakeContext.made;
    expect(context.state).toBe('running');
    // Or the ringer switch would silence it: Web Audio is ambient sound unless the page asks.
    expect(r.session?.type).toBe('playback');
    expect(context.routed()).toEqual([r.music, r.voice]);
    // 80 % with half of the one-second fade left, at 3.5 s of a 4 s post.
    expect(context.gainOf(r.music)?.gain.value).toBeCloseTo(0.4, 6);
    expect(context.gainOf(r.voice)?.gain.value).toBeCloseTo(0.3, 6);
    expect([...(context.gainOf(r.music)?.outputs ?? [])]).toEqual([context.destination]);

    // The fade goes on as the playhead does, on the gain and no longer on the element.
    r.player.seek(3750);
    await settle();
    expect(context.gainOf(r.music)?.gain.value).toBeCloseTo(0.2, 6);
    expect(r.music.volumeWrites).not.toContain(0.2);
  });

  it('suspends the context and gives the audio session back on a pause, and routes nothing twice', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    await playFrom(r, 3500);
    const [context] = FakeContext.made;

    r.player.pause();
    await settle();
    // What the voiceover sheet relies on: it pauses, and then opens the microphone.
    expect(context.state).toBe('suspended');
    expect(r.session?.type).toBe('auto');

    r.player.play();
    await settle();
    expect(FakeContext.made).toHaveLength(1);
    expect(context.state).toBe('running');
    expect(r.session?.type).toBe('playback');
    // One source for each, ever: the second play connects them again and asks for none.
    expect(context.asked).toBe(2);
    expect(context.routed()).toEqual([r.music, r.voice]);
  });

  it('lets nothing into the graph when the pause lands before the context has come back', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    r.player.seek(3500);
    await settle();
    // The pause lands while the context is still coming back from the tap that played.
    r.player.play();
    r.player.pause();
    await settle();

    const [context] = FakeContext.made;
    expect(context.asked).toBe(0);
    expect(context.state).toBe('suspended');
    expect(r.session?.type).toBe('auto');
  });

  it('lets go of the context and the session when the post plays to its end, and takes them again on Play', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    await playFrom(r, 3500);
    const [context] = FakeContext.made;

    // The last clip's end, as its element reports it.
    const clock = r.decks[0];
    clock.paused = true;
    clock.ended = true;
    clock.dispatchEvent(new Event('ended'));
    await settle();
    expect(r.store.playing.value).toBe(false);
    expect(context.state).toBe('suspended');
    expect(r.session?.type).toBe('auto');

    clock.ended = false;
    r.player.play();
    await settle();
    expect(context.state).toBe('running');
    expect(r.session?.type).toBe('playback');
    expect(context.asked).toBe(2);
  });

  it('lets go of them as well when the end of the post is in its tail, past the last clip', async () => {
    const r = await rig(post({ music: MUSIC, durationMs: 4300 }));
    await playFrom(r, 4100);
    const [context] = FakeContext.made;
    expect(context.state).toBe('running');

    await until(() => !r.store.playing.value);
    await settle();
    expect(context.state).toBe('suspended');
    expect(r.session?.type).toBe('auto');
  });

  it("leaves a clip's own sound on its element, with no crossfade, as it always was", async () => {
    // A second clip coming in over the last second of the first, at 60 %.
    const clips = [clip('a'), clip('b', { volume: 0.6, transitionIn: { kind: 'dissolve', durationMs: 1000 } })];
    const r = await rig(post({ clips, music: MUSIC }));
    // Halfway through the transition: the first element plays the incoming clip, the second the tail.
    await playFrom(r, 3500);

    const [context] = FakeContext.made;
    expect(context.routed()).toEqual([r.music, r.voice]);
    expect(r.decks[0].volumeWrites).toContain(0.6);
    // The tail silent rather than faded, which is what iOS has always had.
    expect(r.decks[1].muted).toBe(true);
  });

  it('keeps playing an element it has routed through the context, whatever the post asks of it later', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    await playFrom(r, 3500);
    r.player.pause();
    await settle();

    // Nothing below full level any more. The elements are routed for good, and the context is now
    // the only way they are heard at all.
    r.store.manifest.value = post({ voiceovers: [{ ...TAKE, volume: 1 }] });
    r.player.play();
    await settle();
    expect(FakeContext.made[0].state).toBe('running');
    expect(FakeContext.made[0].gainOf(r.voice)?.gain.value).toBe(1);
  });

  it("plays another origin's file on a stand-in once the element is in the graph, and never through it", async () => {
    const REMOTE = 'https://cdn.example.com/track.m4a';
    const r = await rig(post({ music: MUSIC }));
    await playFrom(r, 3500);
    const [context] = FakeContext.made;
    expect(context.routed()).toEqual([r.music, r.voice]);
    r.player.pause();
    await settle();

    // The music changed to a file the graph would hear as silence - a pick, an undo.
    r.store.manifest.value = post({ music: { ...MUSIC, uri: REMOTE } });
    r.player.play();
    await settle();
    expect(r.standIns).toHaveLength(1);
    const [standIn] = r.standIns;
    expect(standIn.src).toBe(REMOTE);
    expect(standIn.paused).toBe(false);
    expect(context.routed()).not.toContain(standIn);
    expect(r.music.src).toBe('');
    expect(r.music.paused).toBe(true);

    // And back on the page's own file, back on the element in the graph, at its level.
    r.player.pause();
    await settle();
    r.store.manifest.value = post({ music: MUSIC });
    r.player.seek(3500);
    await settle();
    r.player.play();
    await settle();
    expect(r.music.src).toBe(MUSIC.uri);
    expect(r.music.paused).toBe(false);
    expect(context.gainOf(r.music)?.gain.value).toBeCloseTo(0.4, 6);
    expect(standIn.src).toBe('');
    expect(standIn.paused).toBe(true);
    expect(r.standIns).toHaveLength(1);
  });

  it("leaves out of the graph an element still holding another origin's file", async () => {
    const remoteTake: EditVoiceover = { ...TAKE, uri: 'https://cdn.example.com/take.m4a' };
    const r = await rig(post({ voiceovers: [remoteTake] }));
    await playFrom(r, 3500);
    r.player.pause();
    await settle();

    // The take gone and the music in, all of it the page's own: the take's file is still on its
    // element, which is not played until a take is under the playhead again.
    r.store.manifest.value = post({ music: MUSIC });
    await playFrom(r, 3500);
    const [context] = FakeContext.made;
    expect(context.routed()).toEqual([r.music]);
    r.player.pause();
    await settle();

    // Undone: the same file, so the element is not even pointed at it again, and plays it as it did.
    r.store.manifest.value = post({ music: MUSIC, voiceovers: [remoteTake] });
    await playFrom(r, 3500);
    expect(r.voice.src).toBe(remoteTake.uri);
    expect(r.voice.paused).toBe(false);
    expect(context.routed()).toEqual([r.music]);
  });

  it('leaves an element the graph will not take on the speaker, and its gain out of the graph', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    FakeContext.refuses = r.music;
    await playFrom(r, 3500);

    const [context] = FakeContext.made;
    expect(context.routed()).toEqual([r.voice]);
    // The music's gain was made and connected first; with no source for it, it is taken out again.
    expect(context.gains[0].outputs.size).toBe(0);
    expect(r.music.volumeWrites.at(-1)).toBeCloseTo(0.4, 6);
    expect(r.music.paused).toBe(false);
  });

  it('connects the same elements again for a player built over them again, rather than routing them twice', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    await playFrom(r, 3500);
    const [context] = FakeContext.made;

    r.player.destroy();
    expect(context.gainOf(r.music)?.outputs.size).toBe(0);

    const again = r.rebuild();
    await settle();
    again.seek(3500);
    await settle();
    again.play();
    await settle();
    expect(context.routed()).toEqual([r.music, r.voice]);
    expect([...(context.gainOf(r.music)?.outputs ?? [])]).toEqual([context.destination]);
    expect(context.gainOf(r.music)?.gain.value).toBeCloseTo(0.4, 6);
  });

  it('routes nothing without the Audio Session API, and writes the levels where it always did', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }), { session: null });
    await playFrom(r, 3500);

    expect(FakeContext.made).toHaveLength(0);
    expect(r.music.volumeWrites.at(-1)).toBeCloseTo(0.4, 6);
    expect(r.voice.volumeWrites.at(-1)).toBeCloseTo(0.3, 6);
    expect(r.music.paused).toBe(false);
  });

  it('routes nothing, and makes no context, where the playback session is not taken', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }), { session: deafSession() });
    await playFrom(r, 3500);

    expect(FakeContext.made).toHaveLength(0);
    expect(r.music.volumeWrites.at(-1)).toBeCloseTo(0.4, 6);
    expect(r.voice.volumeWrites.at(-1)).toBeCloseTo(0.3, 6);
    expect(r.music.paused).toBe(false);
  });

  it('routes nothing, and makes no context, where asking for the playback session throws', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }), { session: refusingSession() });
    await playFrom(r, 3500);

    expect(FakeContext.made).toHaveLength(0);
    expect(r.music.volumeWrites.at(-1)).toBeCloseTo(0.4, 6);
    expect(r.music.paused).toBe(false);
  });

  it('hands the session straight back where there is no Web Audio to play through', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    await playFrom(r, 3500);

    expect(r.session?.type).toBe('auto');
    expect(r.music.volumeWrites.at(-1)).toBeCloseTo(0.4, 6);
    expect(r.music.paused).toBe(false);
  });

  it('keeps a session type the page chose for itself, and routes nothing under one it cannot play through', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }), { session: { type: 'ambient' } });
    await playFrom(r, 3500);

    expect(FakeContext.made).toHaveLength(0);
    expect(r.session?.type).toBe('ambient');
    expect(r.music.volumeWrites.at(-1)).toBeCloseTo(0.4, 6);
  });

  it("plays through a playback session the page chose for itself, and leaves it the page's on a pause", async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }), { session: { type: 'playback' } });
    await playFrom(r, 3500);
    expect(FakeContext.made[0].routed()).toEqual([r.music, r.voice]);

    r.player.pause();
    await settle();
    expect(FakeContext.made[0].state).toBe('suspended');
    expect(r.session?.type).toBe('playback');
  });

  it('leaves a session type the page changed while it played alone on the pause', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    await playFrom(r, 3500);
    expect(r.session?.type).toBe('playback');

    if (r.session) r.session.type = 'play-and-record';
    r.player.pause();
    await settle();
    expect(r.session?.type).toBe('play-and-record');
  });

  it('routes nothing while the context will not run, and gives the session straight back', async () => {
    FakeContext.runs = false;
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    await playFrom(r, 3500);

    expect(FakeContext.made[0].routed()).toEqual([]);
    expect(FakeContext.made[0].state).toBe('suspended');
    expect(r.session?.type).toBe('auto');
    expect(r.music.volumeWrites.at(-1)).toBeCloseTo(0.4, 6);
    expect(r.music.paused).toBe(false);
  });

  it('starts nothing during a voiceover take', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }));
    r.player.seek(3500);
    await settle();
    r.store.recordingFromMs.value = 3500;
    r.player.play();
    await settle();

    expect(FakeContext.made).toHaveLength(0);
    expect(r.session?.type).toBe('auto');
  });

  it("leaves a post alone whose music is another origin's", async () => {
    const r = await rig(post({ music: { ...MUSIC, uri: 'https://cdn.example.com/track.m4a' }, voiceovers: [TAKE] }));
    await playFrom(r, 3500);

    expect(FakeContext.made).toHaveLength(0);
    expect(r.session?.type).toBe('auto');
  });

  it('leaves a post alone that has nothing below full level', async () => {
    const r = await rig(post({ voiceovers: [{ ...TAKE, volume: 1 }] }));
    await playFrom(r, 3500);

    expect(FakeContext.made).toHaveLength(0);
    expect(r.session?.type).toBe('auto');
  });
});

describe('PreviewMixer', () => {
  it('keeps the context running and the session taken for one player while another pauses', async () => {
    vi.resetModules();
    const session = autoSession();
    useSession(session);
    const { PreviewMixer } = await import('./preview-mixer');
    const first = new FakeMedia(false);
    const second = new FakeMedia(false);
    const one = new PreviewMixer([first as unknown as HTMLAudioElement]);
    const other = new PreviewMixer([second as unknown as HTMLAudioElement]);

    one.start(true);
    other.start(true);
    await settle();
    const [context] = FakeContext.made;
    expect(context.routed()).toEqual([first, second]);

    one.stop();
    await settle();
    expect(context.state).toBe('running');
    expect(session.type).toBe('playback');

    other.stop();
    await settle();
    expect(context.state).toBe('suspended');
    expect(session.type).toBe('auto');
    one.release();
    other.release();
  });
});

describe('the preview on a WebView that honours volume', () => {
  it('never makes an audio context, and sets every level on its element', async () => {
    const r = await rig(post({ music: MUSIC, voiceovers: [TAKE] }), { ios: false });
    await playFrom(r, 3500);

    expect(FakeContext.made).toHaveLength(0);
    expect(r.session?.type).toBe('auto');
    expect(r.music.volume).toBeCloseTo(0.4, 6);
    expect(r.voice.volume).toBeCloseTo(0.3, 6);
  });
});

describe('playableHere', () => {
  it("takes the page's own files, its blobs and a relative path as its own", () => {
    expect(playableHere('capacitor://localhost/_capacitor_file_/sounds/track.m4a')).toBe(true);
    expect(playableHere('blob:capacitor://localhost/6f1c')).toBe(true);
    expect(playableHere('sounds/track.m4a')).toBe(true);
  });

  it('refuses another host, another scheme, and a data URL', () => {
    expect(playableHere('https://cdn.example.com/track.m4a')).toBe(false);
    expect(playableHere('capacitor://elsewhere/track.m4a')).toBe(false);
    expect(playableHere('blob:https://cdn.example.com/6f1c')).toBe(false);
    expect(playableHere('data:audio/wav;base64,UklGRg==')).toBe(false);
  });
});

describe('levelsInUse', () => {
  it('is a music volume or fade-out, or a take below full', () => {
    expect(levelsInUse(post())).toBe(false);
    expect(levelsInUse(post({ music: { ...MUSIC, volume: 1, fadeOutMs: 0 } }))).toBe(false);
    expect(levelsInUse(post({ music: { ...MUSIC, volume: 1 } }))).toBe(true);
    expect(levelsInUse(post({ music: { ...MUSIC, fadeOutMs: 0 } }))).toBe(true);
    expect(levelsInUse(post({ voiceovers: [{ ...TAKE, volume: 1 }] }))).toBe(false);
    expect(levelsInUse(post({ voiceovers: [TAKE] }))).toBe(true);
  });
});
