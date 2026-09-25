import { clamp, type EditManifest } from '../../editor';
import { debugWarn } from '../../host/debug';

/**
 * The music and the voiceover at the levels the post asks for, on a WebView that will not let a
 * page set a media element's `volume` - which is iOS; see [volumeIsWritable].
 *
 * There, every level the editor offers for those two was written to an element that read it back as
 * 1 and played on at full volume: the music's volume, its fade-out at the end and a take's level did
 * nothing at all in the preview, while the render on the same phone mixes every one of them into
 * the file through its audio mix, exactly as Android's preview and the web render do. What the
 * customer heard was not what they were about to post.
 *
 * So on such a WebView the two elements are played THROUGH Web Audio instead: each one handed to
 * the page's one `AudioContext` with `createMediaElementSource`, and on to the speaker through a
 * `GainNode` of its own, which is where the level is written. Everything else about the elements -
 * where they are put, when they start and stop, the leads [PreviewPlayer] measures on them - is
 * exactly as it was. Only the way their sound reaches the speaker changes.
 *
 * WHY ONLY THOSE TWO. A clip's volume and a transition's crossfade would need the same done to the
 * clips' own elements, and those are deliberately left out. WebKit feeds a routed element into the
 * graph through an audio tap on its player item, and nothing on that path follows `playbackRate`:
 * the tap is read back at the context's own real-time rate, whatever rate the element is playing
 * at. A clip plays at anything from a quarter to four times its speed, and a transition's tail is
 * eased up to a quarter off its own rate whenever it drifts (see [catchUpRate]), so a clip's sound
 * put through the graph could not be trusted to come out whole - and an element, once routed, can
 * never be given back. The music and the takes only ever play at their own speed. A clip's own
 * sound on iOS keeps what it had: its mute, and a cut rather than a fade across a transition.
 *
 * NOTHING IS ROUTED unless all of these hold, because each one that did not would be silence where
 * the preview plays today:
 *  - The page can ask for the `playback` audio session, through WebKit's Audio Session API. Web
 *    Audio is otherwise ambient sound, which the ringer switch silences, and a media element is not.
 *    It is asked for only while the page has left the choice to WebKit, which is `auto`, and handed
 *    back as `auto`: a page that has chosen a type of its own has chosen how all of its sound is
 *    heard, and keeps it.
 *  - The context is RUNNING. WebKit starts one only from the customer's own tap, so it is made and
 *    resumed from `play()` alone, and the elements are handed over only once it has said it is
 *    running: handed to a context that is not, an element plays in silence, and that is for good.
 *    A context that does not come to run hands the session back with it.
 *  - Every file the two are going to play is this page's own. The graph hears a file from another
 *    origin, served without CORS, as silence - and the elements are not given `crossOrigin` to get
 *    round that, which would change how every one of their files is fetched. Nor can an element be
 *    taken out of the graph again, so one that is in it and is then asked to play such a file - the
 *    post's music changed, an undo - hands that file to a stand-in; see [elementFor].
 *  - The post has a level for them other than full. A post with none plays exactly as it did.
 *
 * ONE CONTEXT FOR THE LIFE OF THE PAGE, and one gain per element for the life of the element,
 * because `createMediaElementSource` can be asked of an element once, ever: a second source for it,
 * in this context or any other, throws, and the element stays tied to the first. A player built
 * again over the same elements - the preview taken out of the document and put back - finds them
 * already routed and connects them again.
 *
 * AND ONLY WHILE PLAYING. On every pause, and when the post has played to its end, the context is
 * suspended and the audio session handed back, and neither is taken during a voiceover take,
 * because WebKit works the app's audio session out again from what the page has running every time
 * the page's media changes state. A running context or a `playback` session left behind would take
 * the session away from the microphone, which the voiceover sheet opens straight after its pause, in
 * the middle of the take. It is a pause or the end of the post that lets go, and not every stop of
 * the transport: a stop on the way to playing on - a clip still loading, a seek landing - is
 * followed by playing again without a tap, and a routed element would come back silent. The cost is
 * the moment a suspended context takes to come back at the start of every play, which the elements'
 * own start stall already covers.
 */

/** WebKit's Audio Session API, which the DOM library does not declare yet. */
interface AudioSessionLike {
  type: string;
}

/** The context every routed element plays through. Made on the first play that needs it; never closed. */
let context: AudioContext | null = null;
/** Each routed element's gain, from the moment it was routed for as long as the element exists. */
const routes = new WeakMap<HTMLMediaElement, GainNode>();
/** Each routed element's stand-in, made the first time it had a file the graph cannot play. */
const standIns = new WeakMap<HTMLMediaElement, HTMLAudioElement>();
/** The level last asked of each element, which is what its gain starts at when it is routed. */
const levels = new WeakMap<HTMLMediaElement, number>();
/** The mixers playing through the context now. It runs while there is one and is suspended when there is none. */
const holders = new Set<PreviewMixer>();
/** Whether the page's `playback` session is one a mixer asked for, and so a mixer's to hand back. */
let tookSession = false;

/**
 * Whether the post has a level for its music or a voiceover other than full: a volume under 1, or
 * the music's fade-out, which a track has unless somebody took it off.
 */
export function levelsInUse(manifest: EditManifest): boolean {
  const music = manifest.music;
  if (music && (music.volume < 1 || music.fadeOutMs > 0)) return true;
  return manifest.voiceovers.some(take => take.volume < 1);
}

/**
 * Whether `url` is this page's own: the same scheme, host and port as the page, the page's own
 * `blob:` URLs included, and a relative URL, which is the page's by definition.
 *
 * Compared by hand rather than by `origin`, because the URL parser calls the origin of every scheme
 * it does not know "null" - and `capacitor://localhost`, which is where the app is served from on
 * iOS, is one of those.
 */
export function playableHere(url: string): boolean {
  try {
    const parsed = new URL(url, location.href);
    const file = parsed.protocol === 'blob:' ? new URL(parsed.pathname) : parsed;
    return file.protocol === location.protocol && file.host === location.host;
  } catch {
    return false;
  }
}

/**
 * One player's music and voiceover elements, played through the page's context while that player
 * is playing. The top of this file is when that is, and why only then.
 */
export class PreviewMixer {
  /** Started by a play and not stopped since, which is what [holders] counts. */
  private holding = false;

  constructor(private readonly elements: readonly HTMLAudioElement[]) {}

  /** Whether any of this player's elements is in the graph, and so heard through nothing else. */
  private get routed(): boolean {
    return this.elements.some(element => routes.has(element));
  }

  /**
   * Called from `play()`, which is the customer's tap. `needed` is whether the post has a level for
   * these elements to be heard at and every file they will play is this page's own. An element that
   * is routed already is played through the context whatever `needed` says, because that is now the
   * only way it is heard at all.
   */
  start(needed: boolean): void {
    const routed = this.routed;
    if (!needed && !routed) return;
    // The session before the context, so that where WebKit will not give the session no context is
    // made at all.
    if (!takePlayback(audioSession()) && !routed) return;
    const shared = sharedContext();
    if (!shared) {
      if (!holders.size) givePlaybackBack();
      return;
    }
    if (!this.holding) {
      this.holding = true;
      holders.add(this);
    }
    if (shared.state === 'running') {
      this.route(shared);
      return;
    }
    void shared.resume().then(
      () => {
        // A pause while it was coming back has already let go of it, and suspended it again.
        if (!this.holding) return;
        if (shared.state === 'running') {
          this.route(shared);
        } else if (!routed) {
          // Nothing of this player's is in the graph, so it goes back to exactly what it had.
          this.stop();
        }
      },
      (error: unknown) => {
        debugWarn('[ve-preview] the sound mixer could not be started', error);
        if (this.holding && !routed) this.stop();
      },
    );
  }

  /** From every pause, the end of the post, and on the way out; the top of this file is why. */
  stop(): void {
    if (!this.holding) return;
    this.holding = false;
    holders.delete(this);
    if (holders.size) return;
    void context?.suspend().catch(() => undefined);
    givePlaybackBack();
  }

  /**
   * Stops, and takes this player's elements out of the graph: the preview is going, and a source
   * left connected would keep an element nobody plays any more alive, and pulled on by the audio
   * thread, for the life of the page. Their gains are kept, so the same elements handed to a player
   * again are connected again rather than routed a second time, which would throw.
   */
  release(): void {
    this.stop();
    for (const element of this.elements) routes.get(element)?.disconnect();
  }

  /**
   * The element to play `url` on in `element`'s place: `element` itself, unless it is in the graph
   * and `url` is not this page's own. The graph would hear that file as silence, and the element can
   * never be taken out of it, so the file goes on a stand-in instead - an element of the same kind
   * that has never been near the graph, and so plays it exactly as the preview played every file
   * before there was a mixer. It is made the first time one is needed, which wherever nothing is
   * routed is never.
   */
  elementFor(element: HTMLAudioElement, url: string): HTMLAudioElement {
    if (!routes.has(element) || playableHere(url)) return element;
    let standIn = standIns.get(element);
    if (!standIn) {
      standIn = document.createElement('audio');
      standIn.preload = element.preload;
      standIns.set(element, standIn);
    }
    return standIn;
  }

  /**
   * The level `element` is heard at: on its gain once it is routed, and on the element itself, as it
   * always was, until then - which is the whole of it wherever the WebView honours `volume`, and on a
   * stand-in. Written only when it has moved, as every level in the preview is.
   */
  setLevel(element: HTMLMediaElement, volume: number): void {
    const level = clamp(Number.isFinite(volume) ? volume : 0, 0, 1);
    const before = levels.get(element);
    levels.set(element, level);
    const gain = routes.get(element);
    if (!gain) {
      if (element.volume !== level) element.volume = level;
    } else if (before !== level) {
      gain.gain.value = level;
    }
  }

  /**
   * Hands every element not in the graph yet to it, each through a gain of its own that starts at the
   * level last asked of it, and connects again any that a released player took out. An element still
   * holding a file from another origin - left on it from before the post was all this page's own - is
   * left out, and handed over on a later play once it has a file that is.
   *
   * The gain is made and connected BEFORE the source, because making the source is the step that
   * takes the element's sound away from the speaker: anything that failed after it would leave an
   * element playing in silence for good, so nothing is left to come after it but a connection
   * between two nodes that already exist.
   */
  private route(shared: AudioContext): void {
    for (const element of this.elements) {
      const known = routes.get(element);
      if (known) {
        known.connect(shared.destination);
        continue;
      }
      if (element.src && !playableHere(element.src)) continue;
      let gain: GainNode | null = null;
      try {
        gain = shared.createGain();
        gain.gain.value = levels.get(element) ?? 1;
        gain.connect(shared.destination);
        const source = shared.createMediaElementSource(element);
        routes.set(element, gain);
        source.connect(gain);
      } catch (error) {
        if (gain && !routes.has(element)) gain.disconnect();
        debugWarn('[ve-preview] an element could not be put through the sound mixer', error);
      }
    }
  }
}

function audioSession(): AudioSessionLike | null {
  const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
  return session && typeof session.type === 'string' ? session : null;
}

/** The page's context, made the first time one is asked for, which is from a play and so from a tap. */
function sharedContext(): AudioContext | null {
  if (context) return context;
  if (typeof AudioContext === 'undefined') return null;
  try {
    context = new AudioContext();
  } catch (error) {
    debugWarn('[ve-preview] the sound mixer has no audio context', error);
    return null;
  }
  return context;
}

/**
 * Whether the page has the `playback` session: asked for when the page has left the type to WebKit,
 * and taken as it is when it already has it, whoever chose that. False when there is no session to
 * ask, the page has chosen another type, or WebKit would not change it.
 */
function takePlayback(session: AudioSessionLike | null): boolean {
  if (!session) return false;
  if (session.type === 'playback') return true;
  if (session.type !== 'auto') return false;
  try {
    session.type = 'playback';
  } catch (error) {
    debugWarn('[ve-preview] the playback audio session was refused', error);
    return false;
  }
  if (session.type !== 'playback') return false;
  tookSession = true;
  return true;
}

/** Puts the session back to `auto` when it was a mixer that took it, unless something has changed it since. */
function givePlaybackBack(): void {
  if (!tookSession) return;
  tookSession = false;
  const session = audioSession();
  if (!session || session.type !== 'playback') return;
  try {
    session.type = 'auto';
  } catch (error) {
    debugWarn('[ve-preview] the audio session could not be put back', error);
  }
}
