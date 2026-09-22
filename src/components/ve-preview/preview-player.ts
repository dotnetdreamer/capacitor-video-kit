import {
  clamp,
  compileTransition,
  findClip,
  musicSourceMsAt,
  musicWindow,
  sourceMsAt,
  transitionWindowAt,
  type CompiledTransition,
  type EditClip,
  type TimelineSlot,
  type TransitionWindow,
} from '../../editor';
import { debugWarn } from '../../host/debug';
import type { EditorSource } from '../../host/host.types';
import type { EditorStore, PreviewVideoLayer } from '../../state/editor-store';
import type { EditorPlayer } from '../../state/editor.types';
import { FollowerVideo, type FollowerMedia } from './follower-video';
import type { BaseShot } from './preview-canvas';
import {
  BLANK_POSTER,
  SEEK_EPSILON_S,
  applyClipAudio,
  clipsSilenced,
  onPageShown,
  posterFor,
  previewSrc,
  startPlayback,
  volumeIsWritable,
} from './preview-media';
import {
  MAX_START_LEAD_MS,
  TAIL_SEEK_MS,
  boundaryKind,
  catchUpRate,
  crossfade,
  nextLeadMs,
  outputMsAt,
  preloadDue,
  prerollDue,
  slotEndSourceMs,
  slotIndexAt,
  startStallMs,
} from './preview-schedule';

export { continuesInPlace, slotIndexAt } from './preview-schedule';

/** How often the playhead signal is written while playing. The timeline scrolls from it. */
const PLAYHEAD_WRITE_MS = 33;
/**
 * A cut the spare element is NOT ready for starts this far before the segment's out point. The check
 * runs once a frame, and what happens there is a load, so the load is started a frame or two early
 * rather than a frame or two late. A cut the spare IS ready for needs none of it: the compositor
 * paints the far side from the clock's own reading, on the frame the clock crosses the cut.
 */
const CUT_EARLY_MS = 30;
/** Play from closer to the end than this and it starts again from the top. */
const RESTART_WITHIN_MS = 50;
/**
 * While playing, a seek to within this much OUTPUT time of where the element already is is skipped.
 * A timeline that scrolls to follow the playhead can hand back, a pixel's rounding off, exactly the
 * position that was just played - and seeking to it every frame would make playback stutter.
 */
const PLAYING_SEEK_TOLERANCE_MS = 80;
/** A source that has neither loaded nor failed after this long is treated as failed. */
const LOAD_WATCHDOG_MS = 8000;
/**
 * A seek that never reports `seeked` (some WebViews skip it for a seek to where they already are)
 * must not freeze scrubbing: after this long the next request goes ahead anyway.
 */
const SEEK_WATCHDOG_MS = 600;

/** The music and the voiceover are put back in step when they wander further than this. */
const AUDIO_DRIFT_MS = 200;
/**
 * An audio element's clock stands still for a while after every `play()` and every seek - the
 * phone's audio output (re)starting - while the video runs on: ~200 ms on the Redmi. Put exactly where
 * it should be, the audio therefore settled that far behind, just inside [AUDIO_DRIFT_MS], and stayed
 * there for the whole play: a voiceover audibly late on the lips. So each element is put that far
 * AHEAD, the stall eats the lead, and the stall is learned per element and per kind of put from how
 * far behind the element is once it has played this far past where it was put - comfortably after the
 * stall, which comes a few tens of ms in.
 */
const AUDIO_SETTLED_MS = 300;
/** A put whose clock has not got that far after this long is not measured at all. */
const AUDIO_SETTLE_TIMEOUT_MS = 1500;
/** An output stall longer than this is not a stall any lead can make up for. */
const MAX_AUDIO_LEAD_MS = 400;
/**
 * The lead to use before anything has been measured. The very first play after a cold launch has no
 * measurement to go on, and the phone's audio output takes ~150-200 ms to start, so music and
 * voiceovers came in that late every first time - the one play a customer is most likely to judge the
 * editor by. Starting from the middle of that range costs nothing if it is wrong: the first put is
 * measured like any other and replaces this with the real figure.
 */
const DEFAULT_AUDIO_LEAD_MS = 180;

/** A playback position this far before a segment's in point means its trim moved under us. */
const BEHIND_TRIM_MS = 100;

/**
 * A VIDEO element's clock stands still after `play()` too - the same audio output starting, on an
 * element with sound, and the decoder's own warm-up on one without - and the spare base element is
 * started that far ahead of the boundary it takes over at, so it is already moving when the boundary
 * comes; see [prerollDue]. It is measured on every start from a standing frame, the customer's own
 * first tap on Play included, so by the time playback reaches a boundary this device's figure is
 * known. This is only what is used before that: between a desktop's few milliseconds and an Android
 * WebView's 100-200, so neither is more than a frame or three out on the one start that uses it.
 */
const DEFAULT_VIDEO_LEAD_MS = 120;
/** A video start is measured once it has been running this long - well past the stall. */
const VIDEO_SETTLED_MS = 300;

/** `readyState` values the base elements are judged by. */
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;

/**
 * How an audio element was put in place: started along with the video (a play, a seek, a load),
 * started into a video already running (the playhead reaching a take), or re-seeked while both run.
 * Each stalls differently - the first is measured against a video that stalls as well.
 */
type AudioPut = 'cold' | 'warm' | 'seek';

/**
 * The last stall measured on this phone, for a put nothing has been measured for yet, starting at
 * [DEFAULT_AUDIO_LEAD_MS] until one has been. Module-wide, so the editor opened again - and the very
 * first play of a take in it - starts in step.
 */
let lastAudioLeadMs = DEFAULT_AUDIO_LEAD_MS;
/** The same for a video element's start; see [DEFAULT_VIDEO_LEAD_MS]. */
let lastVideoLeadMs = DEFAULT_VIDEO_LEAD_MS;

export interface PreviewMedia {
  /** The base track's first element. It starts as the clock. */
  video: HTMLVideoElement;
  /** The base track's second element: the spare. See [PreviewPlayer] for what the two are for. */
  partner: HTMLVideoElement;
  music: HTMLAudioElement;
  voice: HTMLAudioElement;
  /**
   * Every video layer above the base one under the playhead, bottom to top. Read from the same
   * signal the component DRAWS from, so an element and the box it is placed in can never disagree
   * about which clip they are on.
   */
  extraLayers: () => readonly PreviewVideoLayer[];
  /** The two base elements have just traded places: the base clip on screen is on the other one now. */
  onSwap?: () => void;
}

/**
 * What the spare base element is doing: nothing asked of it, holding the NEXT clip ready to take over
 * at the boundary ahead, or playing the TAIL of the clip before a transition, under the clip that is
 * coming in. The element that is the clock has no role; it is simply the clock.
 */
type DeckRole = 'idle' | 'next' | 'tail';

/** One of the base track's two elements, and what is known about what is on it. */
class BaseDeck {
  /** The host clip key the element's src points at, whether or not it has loaded. */
  key: string | null = null;
  /** The metadata for [key] has arrived, so a position can be put and read. A src change clears it. */
  hasMeta = false;
  /**
   * The src could not be loaded. The element is left pointed at it, as a layer's is: forgetting it
   * would point the element at the same unreadable file again on the very next frame.
   */
  failed = false;
  /** While it is the spare: the segment it is holding - the one it will take over, or the tail's. */
  segmentId: string | null = null;
  role: DeckRole = 'idle';
  /** While it is the spare: where in its file it is wanted, and whether it should be running there. */
  wantMs = 0;
  wantPlaying = false;
  /** A seek of the spare's own in flight, and the latest target asked for while it was. */
  putting = false;
  queuedMs: number | null = null;
  putTimer: ReturnType<typeof setTimeout> | null = null;
  posterIsBlank = true;

  constructor(readonly video: HTMLVideoElement) {}
}

/**
 * Plays the edit on TWO `<video>` elements for the base track and one per extra video LAYER, plus one
 * `<audio>` for the music and one for the voiceover take under the playhead.
 *
 * One element per layer and not one per segment, because phones run out of hardware decoders long
 * before they run out of anything else, and the feed behind this modal may still hold some. Every
 * extra layer's element is a [FollowerVideo], attached only while the post has that layer.
 *
 * The base track gets two, used turn about, because a cut on one element is a load and a seek - a
 * freeze of 150-450 ms on the outgoing frame at every join between two files, which is the thing
 * that made the editor feel cheap next to every editor a customer has used - and because a
 * TRANSITION is two clips on screen at once, which one element cannot be. So:
 *
 *  - one element is the CLOCK: it plays the clip under the playhead, fires the frame loop and says
 *    where the playhead is, exactly as the single element always did;
 *  - the other is the SPARE. A second and a half before a boundary it is pointed at the incoming
 *    clip and parked on its first frame; a start stall before the boundary it is started, so it is
 *    already moving when the boundary arrives; and at the boundary the two trade places - no load and
 *    no seek on the clip coming in, and none of the freeze;
 *  - at a transition the outgoing element simply goes on playing through its tail, which is where
 *    its footage already was, as the spare - kept in step with the new clock and crossfaded out -
 *    and is let go when the window closes.
 *
 * What the compositor draws is read off these two as ONE [BaseShot] per frame, from the clock's own
 * position rather than from the playhead signal, which is written only every 33 ms and would step.
 *
 * Everything that makes the loads that remain invisible is still here and still applies to the
 * clock:
 *  - every load is superseded by the next (a token), so a slow one never lands on top of a newer one;
 *  - while a load or a seek is in flight, further seeks only remember the latest target, so scrubbing
 *    the timeline cannot queue up a decode per frame;
 *  - two segments cut from the same source back to back (a split) play straight through on the one
 *    element with no load and no seek - unless a transition joins them, when they are two moments of
 *    one file on screen at once and take both elements.
 *
 * Every store read below happens on a media event, a frame of the loop or a deferred effect, so it
 * is outside any signal effect and therefore untracked: nothing here subscribes to the store, and
 * what it writes - the playhead, the transport - is what wakes the components that draw from it.
 */
export class PreviewPlayer implements EditorPlayer {
  private readonly decks: readonly [BaseDeck, BaseDeck];
  /** The base element that is the clock. The other is [spare]. */
  private active: BaseDeck;
  private readonly musicEl: HTMLAudioElement;
  private readonly voiceEl: HTMLAudioElement;
  private readonly onSwap: (() => void) | undefined;

  /** The segment the clock is showing, by segment id - indices move when the manifest changes. */
  private segmentId: string | null = null;

  /** Bumped by every load, so a load that has been superseded does nothing when it finishes. */
  private loadToken = 0;
  /** True from a src change until that load has been applied. */
  private pendingLoad = false;
  private cancelLoad: (() => void) | null = null;
  /** Whether the load or seek in flight should end up playing. */
  private autoplay = false;

  private seekInFlight = false;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  /** The latest seek asked for while another was still in flight. */
  private queuedMs: number | null = null;

  private rafId = 0;
  private lastWriteAt = 0;

  /**
   * The wall clock that runs the post's TAIL: the stretch a customer has pulled past the end of the
   * base track's own footage, where the base is black and the layers, the music and the voiceover
   * are still going.
   *
   * It exists because the base element is the clock, and in the tail there is nothing for it to
   * play. Every clip on it having ended used to be the end of playback outright - the transport
   * stopped and the playhead jumped to the end - so a second layer running two seconds past the
   * first one simply never played those two seconds, in a post whose own timeline plainly showed
   * them. Nothing else could notice: `follow` reads the element's `currentTime`, and an element
   * with nothing to play has no time to read.
   *
   * `performance.now()` and not a frame count, because a dropped frame must not slow the post down.
   * Null whenever the base is the clock again, which is every instant before [EditorStore.baseMs].
   */
  private tail: { fromMs: number; wallMs: number } | null = null;

  private musicUri: string | null = null;
  private voiceUri: string | null = null;
  /** Audio elements started or seeked and not yet checked: where they were put (ms), and how often. */
  private readonly settling = new Map<
    HTMLAudioElement,
    { kind: AudioPut; putAtMs: number; leadMs: number; wallMs: number }
  >();
  /** How long each element's clock stands still after a start and after a seek, as last measured. */
  private readonly audioLeadMs = new Map<HTMLAudioElement, Partial<Record<AudioPut, number>>>();
  /** Base elements started from a standing frame and not yet measured; see [DEFAULT_VIDEO_LEAD_MS]. */
  private readonly starts = new Map<HTMLVideoElement, { putAtMs: number; wallMs: number; rate: number }>();
  /** How long each base element's clock stands still after `play()`, as last measured. */
  private readonly videoLeadMs = new Map<HTMLVideoElement, number>();

  private destroyed = false;
  private readonly unlisten: Array<() => void> = [];

  private readonly extraLayers: () => readonly PreviewVideoLayer[];
  /**
   * One follower per extra video layer, by track id.
   *
   * A map and not a single element: a post may carry [MAX_VIDEO_TRACKS] layers and every one of them
   * is drawn, so every one of them needs an element of its own to be drawn FROM. What it costs is a
   * hardware decoder per layer, which is the real budget on a phone - and the answer to that is for
   * a customer not to stack eight videos, not for the editor to show them a post that is missing
   * one and say nothing.
   */
  private readonly followers = new Map<string, FollowerVideo>();

  constructor(
    private readonly store: EditorStore,
    media: PreviewMedia,
  ) {
    this.decks = [new BaseDeck(media.video), new BaseDeck(media.partner)];
    this.active = this.decks[0];
    this.extraLayers = media.extraLayers;
    this.musicEl = media.music;
    this.voiceEl = media.voice;
    this.onSwap = media.onSwap;

    for (const deck of this.decks) this.listenTo(deck);
    // A picker, a phone call or the home button takes the page away, and the paused elements'
    // pictures with it; see [onPageShown] and [revive].
    this.unlisten.push(onPageShown(() => this.revive()));
  }

  /** The clock's element, whose events are the transport's. */
  private get video(): HTMLVideoElement {
    return this.active.video;
  }

  private get spare(): BaseDeck {
    return this.decks[0] === this.active ? this.decks[1] : this.decks[0];
  }

  /**
   * The base element showing the clip under the playhead: the one whose picture's shape the crop
   * tool measures against.
   */
  get baseVideo(): HTMLVideoElement {
    return this.active.video;
  }

  /**
   * Both base elements are listened to for the whole of their lives, and each handler asks which of
   * the two it is at the moment the event arrives, rather than being moved from one to the other at
   * every swap: an event queued before a swap and delivered after it would otherwise land on
   * whichever element happened to be holding the listener by then.
   */
  private listenTo(deck: BaseDeck): void {
    const video = deck.video;
    this.listen(video, 'play', () => {
      if (deck === this.active) this.readPlayState();
    });
    // At a segment's natural end `pause` comes just before `ended`, which moves on to the next
    // segment. Reading it as a real pause would flash the transport to "play" across every cut.
    this.listen(video, 'pause', () => {
      if (deck === this.active && !video.ended) this.readPlayState();
    });
    this.listen(video, 'seeked', () => {
      if (deck === this.active) this.onSeeked();
      else this.onSpareSeeked(deck);
    });
    this.listen(video, 'ended', () => {
      if (deck === this.active) this.onEnded();
    });
    // The frame loop is what moves the playhead; this only covers a WebView that has stopped
    // running animation frames (the app in the background, a throttled tab) while the element plays.
    this.listen(video, 'timeupdate', () => {
      if (deck === this.active && !video.paused) this.follow();
    });
    this.listen(video, 'loadedmetadata', () => this.onDeckMeta(deck));
    this.listen(video, 'error', () => this.onDeckError(deck));
  }

  /* ========================================================================================= */
  /* EditorPlayer                                                                              */
  /* ========================================================================================= */

  /** Shows the frame under the store's playhead. Called once the elements exist. */
  start(): void {
    this.goTo(this.store.playheadMs.value, false);
  }

  seek(outputMs: number): void {
    const target = clamp(outputMs, 0, this.store.totalMs.value);
    // The playhead moves at once, whatever the element is still busy with: the timeline scrolls
    // from it, and a playhead that lagged behind the finger would fight the scroll.
    this.store.playheadMs.value = target;
    // Audio still settling from its last start would measure this jump as its stall.
    this.settling.clear();
    if (this.pendingLoad || this.seekInFlight) {
      this.queuedMs = target;
      return;
    }
    this.goTo(target, this.isPlaying());
  }

  play(): void {
    const total = this.store.totalMs.value;
    if (!this.store.slots.value.length || total <= 0) return;
    // Decided before the busy cases below. A scrub or fling that has just landed on the end is
    // usually still loading or seeking there, and playing on from where the element is going
    // would play nothing and stop at the end again - Play looked dead.
    const restart = this.store.playheadMs.value >= total - RESTART_WITHIN_MS;
    if (this.pendingLoad) {
      if (restart) {
        this.queuedMs = 0;
        this.store.playheadMs.value = 0;
      }
      this.autoplay = true;
      return;
    }
    if (this.seekInFlight && !restart) {
      this.startVideo(this.video);
      return;
    }
    // The seek in flight (and any queued behind it) was to the end; the top supersedes both.
    if (restart) {
      this.cancelSeek();
      this.queuedMs = null;
    }
    this.goTo(restart ? 0 : this.store.playheadMs.value, true);
  }

  pause(): void {
    this.autoplay = false;
    // The exact position first: the frame loop's last write can be a tick old, and in the tail
    // nothing else knows where the playhead had got to.
    if (this.tail) this.store.playheadMs.value = this.tailMs();
    this.stopTail();
    if (!this.video.paused) {
      this.video.pause();
      // The last frame-loop write can be up to a tick old; the paused playhead should be exact.
      // Only after real playback: a pause at the end must not pull the playhead off `totalMs`.
      this.writePlayhead(true);
    }
    this.pauseAudio();
    // A pause during a src change fires no `pause` event (the element is already paused), so
    // the state is read back here rather than left to the event.
    this.readPlayState();
    const ms = this.store.playheadMs.value;
    // The clock can be up to a frame past its own out point when the pause lands - the frame loop
    // moves it on once a frame - and the playhead is then written exactly ON the join, in the next
    // clip's slot, while the clock is still the clip before. That is the move on to the next clip,
    // made paused: `goTo` takes the incoming clip over from the spare it was preloaded on and puts
    // the outgoing one's tail where the window has it. Placing the spare as though the clock were
    // already on the incoming clip would instead load the OUTGOING clip over the incoming one - the
    // preload thrown away, and a join paused on its first frame showing only one side of it.
    const slots = this.store.slots.value;
    const under = slots[slotIndexAt(slots, ms)];
    if (under && under.clip.id !== this.segmentId && ms < this.store.baseMs.value && !this.pendingLoad && !this.seekInFlight) {
      this.goTo(ms, false);
      return;
    }
    // Paused inside a transition, the tail is put EXACTLY where this playhead has it, so the frame
    // left on screen is the one a seek to the same instant paints - the audition's parked middle, a
    // screenshot - rather than one a few frames either side of it wherever the tail happened to stop.
    this.placeSpare(ms, false);
  }

  /* ========================================================================================= */
  /* What the compositor draws                                                                 */
  /* ========================================================================================= */

  /**
   * The base track at this instant, as ONE reading; see [BaseShot] for why it has to be one.
   *
   * The instant is the CLOCK's, read off its element now - not the playhead signal, which is written
   * every 33 ms and would move a transition in visible steps. It is deliberately not held to the
   * clock's own segment: the compositor's frame callback can run before the frame loop's in the same
   * frame, and the first to see the clock cross a boundary has to paint the far side of it - which is
   * why a side is found by which element HOLDS its clip rather than by which element is the clock.
   *
   * Paused, seeking or loading, the instant is the playhead, which is exact then; that is what makes
   * the same playhead paint the same frame every time. Null past the base track's own footage.
   */
  baseShot(): BaseShot | null {
    if (this.destroyed || this.tail) return null;
    const store = this.store;
    const slots = store.slots.value;
    if (!slots.length) return null;
    const at = this.clockMs();
    // Past the base track's last frame in a post pulled out past it: black, as `previewLayers` has it.
    const baseMs = store.baseMs.value;
    if (at >= baseMs && store.totalMs.value > baseMs) return null;
    const index = slotIndexAt(slots, at);
    const slot = slots[index];
    const showing = this.deckShowing(slots, slot);
    const shot: BaseShot = {
      layer: this.baseLayer(slot.clip, sourceMsAt(slot, at)),
      video: this.presentable(showing, slot.clip.clipKey),
      lost: !!showing?.failed,
      transition: null,
    };
    const window = this.windowAt(slots, at);
    if (window && window.index === index) {
      const tail = this.deckFor(window.from.id);
      shot.transition = {
        layer: this.baseLayer(window.from, window.fromSourceMs),
        video: this.presentable(tail, window.from.clipKey),
        lost: !!tail?.failed,
        progress: window.progress,
        compiled: window.compiled,
      };
    }
    return shot;
  }

  /**
   * The output instant the clock's element is at: its own position while it is playing steadily,
   * the playhead otherwise. Not held to the clock's segment; see [baseShot].
   */
  private clockMs(): number {
    const store = this.store;
    if (this.pendingLoad || this.seekInFlight || this.video.paused) return store.playheadMs.value;
    const slot = this.currentSlot();
    if (!slot || slot.clip.clipKey !== this.active.key) return store.playheadMs.value;
    return clamp(outputMsAt(slot, this.video.currentTime * 1000), slot.startMs, store.totalMs.value);
  }

  /** A base clip as the compositor places it: exactly the base entry `previewLayers` builds. */
  private baseLayer(clip: EditClip, sourceMs: number): PreviewVideoLayer {
    return {
      trackId: null,
      clipId: clip.id,
      clipKey: clip.clipKey,
      sourceMs,
      rect: clip.rect ?? null,
      crop: clip.crop ?? null,
      fit: this.store.clipFit(clip),
      opacity: 1,
      z: 0,
    };
  }

  /** The element holding segment `segmentId`: the clock's, or the spare's while it has a job. */
  private deckFor(segmentId: string): BaseDeck | null {
    if (this.segmentId === segmentId) return this.active;
    const spare = this.spare;
    return spare.role !== 'idle' && spare.segmentId === segmentId ? spare : null;
  }

  /**
   * [deckFor], and the one segment the clock's element shows without holding it yet: the second
   * half of a split, which it plays straight on into and moves to a frame after the compositor can
   * already see the clock past the join.
   */
  private deckShowing(slots: readonly TimelineSlot[], slot: TimelineSlot): BaseDeck | null {
    const holding = this.deckFor(slot.clip.id);
    if (holding) return holding;
    const current = this.currentSlot();
    if (current && slots[current.index + 1] === slot && boundaryKind(current, slot) === 'split') return this.active;
    return null;
  }

  /** The element, when it has a frame of `clipKey` to give. */
  private presentable(deck: BaseDeck | null, clipKey: string): HTMLVideoElement | null {
    if (!deck || deck.key !== clipKey || deck.failed) return null;
    const video = deck.video;
    if (video.readyState < HAVE_CURRENT_DATA || !(video.videoWidth > 0) || !(video.videoHeight > 0)) return null;
    return video;
  }

  /** The transition on screen at `ms`, with the numbers it is drawn with, or null at a plain frame. */
  private windowAt(slots: readonly TimelineSlot[], ms: number): (TransitionWindow & { compiled: CompiledTransition }) | null {
    const window = transitionWindowAt(slots, ms);
    const kind = window?.to.transitionIn?.kind;
    const compiled = kind ? compileTransition(kind) : null;
    return window && compiled ? { ...window, compiled } : null;
  }

  /* ========================================================================================= */
  /* Reacting to the edit                                                                      */
  /* ========================================================================================= */

  /**
   * The segments changed - a trim, a split, a speed, a reorder, a delete, an undo. While paused the
   * frame under the playhead is shown again; while playing, the segment that is on screen keeps
   * playing with its new speed and sound, unless it is gone or now belongs to another source. The
   * spare catches up by itself: the frame loop checks what it holds against the boundary ahead on
   * every frame.
   */
  resync(): void {
    if (this.destroyed) return;
    const playing = this.isPlaying();
    const slot = this.currentSlot();
    if (playing && slot && !this.pendingLoad && slot.clip.clipKey === this.active.key) {
      this.video.playbackRate = slot.clip.speed || 1;
      this.applyVideoAudio(slot.clip);
      // The edit that changed may well have been the second layer's own.
      this.syncFollower(true);
      return;
    }
    this.seek(this.store.playheadMs.value);
  }

  /** Mute, volumes and the audio tracks changed. */
  refreshAudio(): void {
    if (this.destroyed) return;
    const slot = this.currentSlot();
    if (slot) this.applyVideoAudio(slot.clip);
    this.syncAudio(this.store.playheadMs.value, this.isPlaying());
    this.syncFollower(this.isPlaying());
  }

  /** A filmstrip arrived; the clip on either element may have been showing the blank poster. */
  refreshPoster(): void {
    if (this.destroyed) return;
    for (const follower of this.followers.values()) follower.refreshPoster();
    if (!this.active.posterIsBlank) return;
    const slot = this.currentSlot();
    const clip = slot ? this.store.clipByKey(slot.clip.clipKey) : undefined;
    if (!slot || !clip || clip.key !== this.active.key) return;
    this.setPoster(this.active, clip, sourceMsAt(slot, this.store.playheadMs.value));
  }

  /**
   * Puts the picture back after the page has been away; [onPageShown] is where what takes it is
   * written down.
   *
   * The source is FORGOTTEN rather than seeked, which is the whole of the fix: forgetting it is what
   * makes `goTo` load it again, and a load is one of the two things that gives a purged element a
   * picture back. The load ends in a forced seek to the playhead like every other, so what arrives is
   * the frame the customer was left looking at. Both base elements forget theirs, so a transition's
   * tail comes back as well, and a clip preloaded on the spare is not taken over black.
   *
   * An element that is playing has lost nothing - playing is the other thing that restores it, and
   * WebKit has already done it by the time this runs - so it is left alone rather than stalled by a
   * load it does not need.
   */
  private revive(): void {
    if (this.destroyed || !this.video.paused) return;
    for (const deck of this.decks) {
      deck.key = null;
      deck.hasMeta = false;
    }
    this.goTo(this.store.playheadMs.value, false);
    for (const follower of this.followers.values()) follower.revive();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopTail();
    this.stopLoop();
    this.cancelLoad?.();
    this.cancelLoad = null;
    for (const follower of this.followers.values()) follower.destroy();
    this.followers.clear();
    if (this.seekTimer) clearTimeout(this.seekTimer);
    for (const deck of this.decks) this.clearPut(deck);
    for (const off of this.unlisten) off();
    // Both base elements are stripped, the spare too: it holds a decoder whatever it is doing.
    for (const el of [...this.decks.map(deck => deck.video), this.musicEl, this.voiceEl]) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }

  /* ========================================================================================= */
  /* Loading and seeking                                                                       */
  /* ========================================================================================= */

  /** Puts the clock on the segment under `ms`, loading its source only when it is not already on. */
  private goTo(ms: number, autoplay: boolean, forceSeek = false): void {
    if (this.destroyed) return;
    // Past the base track's own footage, in a post somebody has stretched: there is no clip to put
    // on the element and no element time to read, so the tail's own clock takes over.
    const baseMs = this.store.baseMs.value;
    if (ms >= baseMs && this.store.totalMs.value > baseMs) {
      this.enterTail(ms, autoplay);
      return;
    }
    this.stopTail();
    const slots = this.store.slots.value;
    const index = slotIndexAt(slots, ms);
    if (index < 0) return;
    const slot = slots[index];
    const clip = this.store.clipByKey(slot.clip.clipKey);
    if (!clip) return;

    // The clip may already be on the SPARE element: preloaded for the boundary ahead, or the one the
    // playhead has just left, which a scrub back across the cut lands on. Taking that element over
    // costs a seek at most, where the clock's own would have to load the file from nothing.
    const spare = this.spare;
    if (this.active.key !== clip.key && spare.key === clip.key && !spare.failed) this.swap();

    this.segmentId = slot.clip.id;
    this.store.playheadMs.value = ms;

    if (this.active.key !== clip.key || !this.active.hasMeta) {
      this.load(clip, slot, ms, autoplay);
    } else {
      this.applyAt(slot, ms, autoplay, forceSeek);
    }
    this.placeSpare(ms, autoplay);
  }

  /**
   * Points the clock's element at another source. The position, speed and sound are applied once its
   * metadata is in - through `goTo` again, so a manifest that changed during the load is read as it
   * is by then, and a seek that arrived meanwhile wins over the one that started the load.
   */
  private load(clip: EditorSource, slot: TimelineSlot, ms: number, autoplay: boolean): void {
    const deck = this.active;
    const video = deck.video;
    const token = ++this.loadToken;
    this.cancelLoad?.();
    this.pendingLoad = true;
    this.autoplay = autoplay;
    this.cancelSeek();

    const finish = (ok: boolean) => {
      if (token !== this.loadToken || this.destroyed) return;
      this.cancelLoad?.();
      this.cancelLoad = null;
      this.pendingLoad = false;
      const queued = this.queuedMs;
      this.queuedMs = null;
      if (!ok) {
        debugWarn('[ve-preview] clip could not be loaded', clip.key, video.error);
        // Forgotten, so the next attempt loads it again rather than seeking a source that is not there.
        deck.key = null;
        this.readPlayState();
        // A seek that arrived during the failed load may well be for another clip that does play.
        if (queued !== null) this.goTo(queued, false);
        return;
      }
      const target = queued ?? ms;
      // A fresh source always gets a real seek: a paused WebView video otherwise sits on the poster
      // (or black) instead of the frame it is parked on.
      this.goTo(target, this.autoplay, true);
    };
    const onMeta = () => finish(true);
    const onError = () => finish(false);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onError);
    // A load that never reports either would leave every later seek queued behind it for good.
    const watchdog = setTimeout(onError, LOAD_WATCHDOG_MS);
    this.cancelLoad = () => {
      clearTimeout(watchdog);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onError);
    };

    // Already on its way: the spare had this clip put on it ahead of the boundary and was taken over
    // before its metadata landed. Waiting out that load is quicker than starting it again.
    const underway = deck.key === clip.key && !deck.failed && !deck.hasMeta;
    if (!underway) this.point(deck, clip, sourceMsAt(slot, ms));
  }

  /** Points one base element at a source, from nothing: whatever it had loaded is gone with this. */
  private point(deck: BaseDeck, source: EditorSource, sourceMs: number): void {
    this.clearPut(deck);
    this.starts.delete(deck.video);
    deck.key = source.key;
    deck.hasMeta = false;
    deck.failed = false;
    // The poster first, for where the element is going; see [FollowerVideo.load].
    this.setPoster(deck, source, sourceMs);
    deck.video.src = previewSrc(this.store, source);
    deck.video.load();
  }

  private applyAt(slot: TimelineSlot, ms: number, autoplay: boolean, forceSeek: boolean): void {
    const video = this.video;
    video.playbackRate = slot.clip.speed || 1;
    // Some WebViews reset pitch correction on every source change, so it is set each time.
    (video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
    this.applyVideoAudio(slot.clip, ms);

    const sourceSec = sourceMsAt(slot, ms) / 1000;
    const tolerance =
      autoplay && !video.paused && !forceSeek
        ? (PLAYING_SEEK_TOLERANCE_MS * (slot.clip.speed || 1)) / 1000
        : SEEK_EPSILON_S;
    if (forceSeek || Math.abs(video.currentTime - sourceSec) > tolerance) {
      this.armSeek();
      this.starts.delete(video);
      video.currentTime = sourceSec;
    }

    this.autoplay = autoplay;
    if (autoplay) {
      if (video.paused) this.startVideo(video);
    } else if (!video.paused) {
      video.pause();
    }
    this.syncAudio(ms, autoplay);
    this.syncFollower(autoplay);
    // A src change pauses the element WITHOUT firing `pause`, so the state is re-read here.
    this.readPlayState();
  }

  private armSeek(): void {
    this.seekInFlight = true;
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => this.onSeeked(), SEEK_WATCHDOG_MS);
  }

  private cancelSeek(): void {
    this.seekInFlight = false;
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = null;
  }

  private onSeeked(): void {
    if (!this.seekInFlight || this.destroyed) return;
    this.cancelSeek();
    if (this.queuedMs !== null) {
      const next = this.queuedMs;
      this.queuedMs = null;
      this.goTo(next, this.isPlaying());
      return;
    }
    if (!this.video.paused) this.syncAudio(this.store.playheadMs.value, true);
  }

  /**
   * The two base elements trade places: the spare becomes the clock and the clock the spare.
   *
   * Whatever the clock's element was busy with - a load, a seek - belongs to the element it is
   * leaving and is dropped with it; the element it is taking over may be busy too, with the seek that
   * parked it, and that becomes the clock's to wait for.
   */
  private swap(): void {
    this.cancelLoad?.();
    this.cancelLoad = null;
    this.loadToken += 1;
    this.pendingLoad = false;
    this.cancelSeek();
    const leaving = this.active;
    const taking = this.spare;
    const parking = taking.putting;
    this.clearPut(taking);
    taking.role = 'idle';
    leaving.role = 'idle';
    leaving.segmentId = this.segmentId;
    leaving.wantPlaying = false;
    this.active = taking;
    if (parking) this.armSeek();
    this.onSwap?.();
  }

  /* ========================================================================================= */
  /* The spare                                                                                 */
  /* ========================================================================================= */

  /**
   * Gives the spare whatever the playhead at `ms` needs of it: inside a transition, the outgoing
   * clip's tail, at exactly the frame the window has it on; anywhere else, nothing - it stops, and
   * keeps what it has.
   *
   * What it keeps is usually worth keeping. Close to a boundary it is handed the clip on the far side
   * straight away, paused on its first frame, so Play from here runs through the boundary with no
   * load at all - which is precisely what an audition does, from 600 ms in front of a transition.
   * Anywhere else it holds on to what it had, most often the clip the playhead has just left, which
   * a scrub back across the cut then takes over rather than loads.
   */
  private placeSpare(ms: number, playing: boolean): void {
    const spare = this.spare;
    const slots = this.store.slots.value;
    const window = this.windowAt(slots, ms);
    if (window) {
      this.hold(spare, window.from, window.fromSourceMs, 'tail', playing);
      return;
    }
    if (spare.role === 'tail') spare.role = 'idle';
    spare.wantPlaying = false;
    if (!spare.video.paused) spare.video.pause();
    const index = slotIndexAt(slots, ms);
    const slot = slots[index];
    const next = slots[index + 1];
    if (!slot || !next || !preloadDue(ms, next)) return;
    const kind = boundaryKind(slot, next);
    if (kind === 'cut' || kind === 'transition') this.primeNext(next);
  }

  /**
   * The incoming clip of the boundary ahead, on the spare, paused on its first frame - unless the
   * spare is still the tail of the transition before (two elements cannot be three clips), or is
   * already rolling towards the boundary on it.
   */
  private primeNext(next: TimelineSlot): void {
    const deck = this.spare;
    if (deck.role === 'tail') return;
    if (deck.role === 'next' && deck.segmentId === next.clip.id && deck.wantMs === next.clip.inMs && deck.wantPlaying && !deck.video.paused) return;
    this.hold(deck, next.clip, next.clip.inMs, 'next', false);
  }

  /** Whether the spare is parked on `next`'s first frame with a picture, ready to be started or taken over. */
  private spareReadyFor(next: TimelineSlot): boolean {
    const deck = this.spare;
    return (
      deck.role === 'next' &&
      deck.segmentId === next.clip.id &&
      deck.key === next.clip.clipKey &&
      deck.hasMeta &&
      !deck.failed &&
      !deck.putting &&
      deck.video.readyState >= HAVE_CURRENT_DATA
    );
  }

  /**
   * Starts the spare, parked on the incoming clip's first frame, a start stall before the boundary;
   * see [prerollDue]. Silent until it is the clock: the first moments of a clip are not heard before
   * its first frame is seen.
   */
  private preroll(deck: BaseDeck): void {
    if (!deck.video.muted) deck.video.muted = true;
    deck.wantPlaying = true;
    this.startVideo(deck.video);
  }

  /**
   * Asks the spare to hold `clip` at `sourceMs`, paused or running. Idempotent - the frame loop calls
   * it every frame - so it costs a comparison once the element is where it is wanted.
   */
  private hold(deck: BaseDeck, clip: EditClip, sourceMs: number, role: Exclude<DeckRole, 'idle'>, playing: boolean): void {
    const source = this.store.clipByKey(clip.clipKey);
    if (!source) {
      deck.role = 'idle';
      deck.wantPlaying = false;
      if (!deck.video.paused) deck.video.pause();
      return;
    }
    deck.segmentId = clip.id;
    deck.role = role;
    deck.wantMs = sourceMs;
    deck.wantPlaying = playing;
    if (deck.key !== source.key) {
      // [onDeckMeta] puts it in place once the file has said how long it is.
      this.point(deck, source, sourceMs);
      return;
    }
    if (deck.failed || !deck.hasMeta) return;
    this.applySpare(deck, false);
  }

  /**
   * Rate, sound, position and running state for the spare, from what [hold] last asked of it.
   * `fresh` is a source whose metadata has just landed, which is always seeked, for the reason the
   * clock's loader seeks one: an element never seeked keeps the show-poster flag its load set.
   */
  private applySpare(deck: BaseDeck, fresh: boolean): void {
    if (deck === this.active || deck.role === 'idle' || !deck.segmentId) return;
    const clip = findClip(this.store.manifest.value, deck.segmentId);
    if (!clip) return;
    const video = deck.video;
    const speed = clip.speed || 1;
    if (video.playbackRate !== speed) video.playbackRate = speed;
    (video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
    if (deck.role === 'next') {
      // Not heard until it is the clock; see [preroll].
      if (!video.muted) video.muted = true;
    } else {
      this.applyVideoAudio(this.currentSlot()?.clip ?? clip);
    }
    // Only a clock that is itself running carries a running spare with it. While it loads or seeks,
    // the spare waits where it is put, exactly as a layer's element does. A tail that is already
    // running is only seeked when it is hopelessly out: anything less is eased back by the frame
    // loop without a stall; see [driveTail].
    const run = deck.wantPlaying && !this.pendingLoad && !this.seekInFlight;
    const tolerance = run && !video.paused ? TAIL_SEEK_MS * speed : SEEK_EPSILON_S * 1000;
    if (fresh || Math.abs(video.currentTime * 1000 - deck.wantMs) > tolerance) this.put(deck, deck.wantMs);
    if (run) {
      if (video.paused && !video.ended) this.startVideo(video);
    } else if (!video.paused) {
      video.pause();
    }
  }

  /**
   * Seeks the spare, one seek at a time: while one is in flight, later ones only keep the latest
   * target, exactly as the clock's seeks are coalesced - a scrub across a transition would otherwise
   * queue a decode per frame on the element nobody is watching the timeline for.
   */
  private put(deck: BaseDeck, sourceMs: number): void {
    this.starts.delete(deck.video);
    if (deck.putting) {
      deck.queuedMs = sourceMs;
      return;
    }
    deck.putting = true;
    deck.queuedMs = null;
    if (deck.putTimer) clearTimeout(deck.putTimer);
    // The same watchdog as the clock's: a WebView that never reports this seek must not leave the
    // spare refusing every later one.
    deck.putTimer = setTimeout(() => this.onSpareSeeked(deck), SEEK_WATCHDOG_MS);
    deck.video.currentTime = Math.max(0, sourceMs) / 1000;
  }

  private onSpareSeeked(deck: BaseDeck): void {
    if (!deck.putting || deck === this.active || this.destroyed) return;
    this.clearPut(deck, true);
    const queued = deck.queuedMs;
    deck.queuedMs = null;
    if (queued !== null && Math.abs(deck.video.currentTime * 1000 - queued) > SEEK_EPSILON_S * 1000) this.put(deck, queued);
  }

  private clearPut(deck: BaseDeck, keepQueue = false): void {
    deck.putting = false;
    if (!keepQueue) deck.queuedMs = null;
    if (deck.putTimer) clearTimeout(deck.putTimer);
    deck.putTimer = null;
  }

  private onDeckMeta(deck: BaseDeck): void {
    deck.hasMeta = true;
    deck.failed = false;
    if (deck !== this.active && !this.destroyed) this.applySpare(deck, true);
  }

  private onDeckError(deck: BaseDeck): void {
    // The clock's own loads have a handler of their own, which also reports it.
    deck.failed = true;
    if (deck !== this.active) debugWarn('[ve-preview] the next clip could not be loaded', deck.key, deck.video.error);
  }

  /**
   * One frame of the transition the clock's clip came in with, while the clock is inside it: the
   * tail kept in step and its sound shared out, and the tail let go on the first frame past the end
   * of the window - paused, back at its own level, and free for the next boundary.
   */
  private followWindow(slots: readonly TimelineSlot[], slot: TimelineSlot, at: number): void {
    const inside = slot.transitionInMs > 0 && at < slot.startMs + slot.transitionInMs;
    const window = inside ? this.windowAt(slots, Math.max(at, slot.startMs)) : null;
    const spare = this.spare;
    if (!window || window.index !== slot.index) {
      if (spare.role === 'tail') {
        spare.role = 'idle';
        spare.wantPlaying = false;
        if (!spare.video.paused) spare.video.pause();
        // Only the incoming clip is heard from here on, at its own level: no doubled sound.
        this.applyBaseAudio(slot.clip, null);
      }
      return;
    }
    this.driveTail(window);
    this.applyBaseAudio(slot.clip, window);
  }

  /**
   * Keeps the tail where the clock says it is. Not seeked for a small drift - eased back by a rate a
   * little off its own; see [catchUpRate] - and stopped on its own out point rather than let run on
   * into footage the clip was trimmed off.
   */
  private driveTail(window: TransitionWindow): void {
    const deck = this.spare;
    const from = window.from;
    if (deck.role !== 'tail' || deck.segmentId !== from.id) {
      this.hold(deck, from, window.fromSourceMs, 'tail', true);
      return;
    }
    deck.wantMs = window.fromSourceMs;
    deck.wantPlaying = true;
    if (deck.failed || !deck.hasMeta || deck.putting) return;
    const video = deck.video;
    const speed = from.speed || 1;
    const atMs = video.currentTime * 1000;
    if (video.ended || atMs >= from.outMs - 1) {
      if (!video.paused) video.pause();
      return;
    }
    const behindMs = (window.fromSourceMs - atMs) / speed;
    if (Math.abs(behindMs) > TAIL_SEEK_MS) {
      this.put(deck, window.fromSourceMs);
      return;
    }
    const rate = speed * catchUpRate(behindMs);
    if (Math.abs(video.playbackRate - rate) > 0.001) {
      video.playbackRate = rate;
      // A start still being measured is measured at the rate it began at. Read across a change of
      // rate, the footage it covered says nothing about how long its clock stood still, and the lead
      // learned from it would start the next incoming clip early or late by the difference.
      this.starts.delete(video);
    }
    if (video.paused) this.startVideo(video);
  }

  /* ========================================================================================= */
  /* Playing                                                                                   */
  /* ========================================================================================= */

  /**
   * `playing` mirrors the element and nothing else: it is written from the element's own `play` and
   * `pause` events, and re-read after every load. Set by hand from `play()`'s promise, a promise
   * aborted by the NEXT clip's src change would resolve late and report "paused" over a video that
   * was plainly playing.
   */
  private readPlayState(): void {
    if (this.destroyed) return;
    // The tail counts: the element is paused there because it has nothing to play, and a transport
    // that read it would show Play over a post that is plainly running.
    const playing = !this.video.paused || this.tail !== null;
    if (this.store.playing.value !== playing) this.store.playing.value = playing;
    if (playing) {
      this.startLoop();
    } else {
      this.stopLoop();
      this.pauseAudio();
      for (const follower of this.followers.values()) follower.pause();
      // Nothing plays on the spare while the transport is stopped: not a tail, not an early start.
      const spare = this.spare.video;
      if (!spare.paused) spare.pause();
    }
  }

  /**
   * Starts a base element, and measures how long its clock then stands still - but only from a
   * standing start on a frame that is there: a start that still has a load or a seek to finish is
   * waiting on those, and that wait would be learned as the element's stall.
   */
  private startVideo(video: HTMLVideoElement): void {
    if (!video.paused) return;
    if (video.readyState >= HAVE_FUTURE_DATA && !video.seeking) {
      this.starts.set(video, { putAtMs: video.currentTime * 1000, wallMs: performance.now(), rate: video.playbackRate || 1 });
    } else {
      this.starts.delete(video);
    }
    startPlayback(video);
  }

  /** Reads every start that has run long enough; see [startStallMs]. */
  private learnStarts(): void {
    if (!this.starts.size) return;
    const now = performance.now();
    for (const [video, start] of this.starts) {
      if (video.paused || video.seeking) {
        this.starts.delete(video);
        continue;
      }
      const elapsed = now - start.wallMs;
      if (elapsed < VIDEO_SETTLED_MS) continue;
      this.starts.delete(video);
      const stall = startStallMs(elapsed, video.currentTime * 1000 - start.putAtMs, start.rate);
      if (stall === null) continue;
      const lead = nextLeadMs(this.videoLeadMs.get(video), stall);
      this.videoLeadMs.set(video, lead);
      lastVideoLeadMs = lead;
    }
  }

  /** How far ahead of a boundary this element has to be started to be moving at it. */
  private leadFor(video: HTMLVideoElement): number {
    return clamp(this.videoLeadMs.get(video) ?? lastVideoLeadMs, 0, MAX_START_LEAD_MS);
  }

  /** `timeupdate` fires about four times a second on Android; a timeline scrolled from it stutters. */
  private startLoop(): void {
    if (this.rafId) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.follow();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /**
   * One step of playback: the transition the clock's clip came in with, the boundary ahead - the
   * incoming clip put on the spare in good time, and started a stall before it - the move on at the
   * segment's end, and otherwise the playhead and the audio kept in step with the element. Reading
   * the trim from the manifest every time, rather than from a copy taken when the segment started,
   * means a trim changed mid-playback applies at once.
   */
  private follow(): void {
    // In the tail there is no element time to read; see [tail].
    if (this.tail) {
      this.followTail();
      return;
    }
    // While a new source is loading, the element still reports the OLD source's position. Acting on
    // it would compare the previous clip's time against the next clip's trim - and skip the next
    // clip outright whenever it is trimmed shorter.
    if (this.pendingLoad || this.seekInFlight || this.destroyed) {
      // The clock has stopped: the base is between sources, or settling on a frame it was seeked
      // to. A second layer that ran on through that would come back a load's worth ahead and be
      // yanked back into place, so it waits with the base rather than drifting past it - and so
      // does a transition's tail, for the same reason.
      for (const follower of this.followers.values()) follower.pause();
      const spare = this.spare;
      if (spare.role === 'tail' && !spare.video.paused) spare.video.pause();
      return;
    }
    this.learnStarts();
    const slots = this.store.slots.value;
    const index = slots.findIndex((slot) => slot.clip.id === this.segmentId);
    if (index < 0) {
      this.goTo(clamp(this.store.playheadMs.value, 0, this.store.totalMs.value), true);
      return;
    }
    const slot = slots[index];
    const next = slots[index + 1];
    const sourceMs = this.video.currentTime * 1000;
    const at = outputMsAt(slot, sourceMs);
    // At a clip's natural end the element sets `paused` BEFORE it fires `pause` - so `paused` alone
    // reads "was not playing" and the preview would stall at the boundary. `playing` still holds
    // what the events last reported, which is the truth: it was playing up to the end.
    const wasPlaying = () => this.store.playing.value || !this.video.paused;

    this.followWindow(slots, slot, at);

    const kind = boundaryKind(slot, next);
    if (kind === 'split') {
      if (sourceMs >= slot.clip.outMs) {
        this.advance(index, wasPlaying());
        return;
      }
    } else if (kind === 'end' || !next) {
      if (sourceMs >= slot.clip.outMs - CUT_EARLY_MS) {
        this.advance(index, wasPlaying());
        return;
      }
    } else {
      // A cut or a transition ahead: the incoming clip goes on the spare in good time...
      if (preloadDue(at, next)) this.primeNext(next);
      const ready = this.spareReadyFor(next);
      // ...and is started a start stall early, so it is moving when the boundary arrives.
      const spare = this.spare;
      if (ready && spare.video.paused && prerollDue(at, next, this.leadFor(spare.video))) this.preroll(spare);
      const endMs = slotEndSourceMs(slot) - (ready || kind === 'transition' ? 0 : CUT_EARLY_MS);
      if (sourceMs >= endMs) {
        this.advance(index, wasPlaying());
        return;
      }
    }
    if (sourceMs < slot.clip.inMs - BEHIND_TRIM_MS) {
      this.goTo(slot.startMs, true);
      return;
    }
    this.writePlayhead(false);
  }

  /**
   * Puts the playhead in the tail and, when it should be running, starts its clock.
   *
   * The element is paused rather than left where it was: the tail is BLACK - the render draws
   * nothing past the base track's last frame - and the preview agrees without being told, because
   * `previewLayers` hands the compositor no base layer here. What is left to do is the layers, the
   * music and the voiceover, which are all driven from the playhead.
   */
  private enterTail(ms: number, autoplay: boolean): void {
    const at = clamp(ms, this.store.baseMs.value, this.store.totalMs.value);
    this.cancelSeek();
    this.queuedMs = null;
    this.autoplay = autoplay;
    if (!this.video.paused) this.video.pause();
    const spare = this.spare;
    spare.role = 'idle';
    spare.wantPlaying = false;
    if (!spare.video.paused) spare.video.pause();
    this.store.playheadMs.value = at;
    this.tail = autoplay ? { fromMs: at, wallMs: performance.now() } : null;
    this.syncAudio(at, autoplay);
    this.syncFollower(autoplay);
    this.readPlayState();
  }

  /** One step of the tail, which is the frame loop's whole job once the base has nothing to play. */
  private followTail(): void {
    const total = this.store.totalMs.value;
    const at = this.tailMs();
    if (at >= total) {
      this.stopTail();
      this.store.playheadMs.value = total;
      this.pauseAudio();
      this.readPlayState();
      return;
    }
    // Throttled exactly as the base's own writes are, and for the same reason: the timeline scrolls
    // from this signal, and writing it sixty times a second is work rather than feedback. The end
    // above is checked every frame regardless, so the post still stops where it says it does.
    const now = performance.now();
    if (now - this.lastWriteAt < PLAYHEAD_WRITE_MS) return;
    this.lastWriteAt = now;
    this.store.playheadMs.value = at;
    this.syncAudio(at, true, true);
    this.syncFollower(true);
  }

  /** Where the tail's clock has got to, held inside the post. */
  private tailMs(): number {
    const tail = this.tail;
    if (!tail) return this.store.playheadMs.value;
    return clamp(tail.fromMs + (performance.now() - tail.wallMs), 0, this.store.totalMs.value);
  }

  private stopTail(): void {
    this.tail = null;
  }

  private writePlayhead(force: boolean): void {
    if (this.pendingLoad || this.seekInFlight) return;
    const now = performance.now();
    if (!force && now - this.lastWriteAt < PLAYHEAD_WRITE_MS) return;
    const slot = this.currentSlot();
    if (!slot || slot.clip.clipKey !== this.active.key) return;
    this.lastWriteAt = now;
    const into = Math.max(0, this.video.currentTime * 1000 - slot.clip.inMs) / (slot.clip.speed || 1);
    const ms = slot.startMs + Math.min(slot.durationMs, into);
    this.store.playheadMs.value = ms;
    this.syncAudio(ms, !this.video.paused, !this.video.paused);
    this.syncFollower(!this.video.paused);
  }

  /**
   * A clip left untrimmed plays to its real end and fires `ended` - and by then the element has
   * already set `paused`. Reaching the end at all means it was playing.
   */
  private onEnded(): void {
    // A load or a seek in flight re-reads the play state itself when it lands.
    if (this.pendingLoad || this.seekInFlight) return;
    const index = this.store.slots.value.findIndex((slot) => slot.clip.id === this.segmentId);
    if (index >= 0) this.advance(index, true);
    else this.readPlayState();
  }

  private advance(index: number, wasPlaying: boolean): void {
    const slots = this.store.slots.value;
    const current = slots[index];
    const next = slots[index + 1];
    if (!next) {
      // The base track has run out. If the POST has not - the customer pulled the end out past its
      // last frame - then what follows is black with the layers still on it, and playing stops at
      // the end of the post rather than at the end of the base.
      const baseMs = this.store.baseMs.value;
      if (wasPlaying && this.store.totalMs.value > baseMs) {
        this.goTo(baseMs, true);
        return;
      }
      this.video.pause();
      this.pauseAudio();
      this.store.playheadMs.value = this.store.totalMs.value;
      this.readPlayState();
      return;
    }
    const kind = current ? boundaryKind(current, next) : 'cut';
    if (kind === 'split' && next.clip.clipKey === this.active.key && !this.video.ended) {
      // Two halves of a split: the element is already exactly where the next segment begins.
      this.segmentId = next.clip.id;
      this.video.playbackRate = next.clip.speed || 1;
      this.applyVideoAudio(next.clip);
      return;
    }
    const source = this.store.clipByKey(next.clip.clipKey);
    if (source && kind !== 'split') {
      // A cut or a transition: the incoming clip starts on the spare, where it has very likely been
      // waiting for the last second and a half and running for the last few frames - so taking it
      // over is no load and no seek, which is the freeze every cut between two files used to have.
      // Put there now if it never was (a seek that landed right in front of the boundary); the clock
      // then waits for that load exactly as it waits for any other. At a transition the element
      // being left goes on playing as the tail, which `goTo` hands it on its way through.
      this.primeNext(next);
      const spare = this.spare;
      if (spare.segmentId === next.clip.id && spare.key === source.key) {
        this.swap();
        if (kind === 'transition' && current) {
          // Named the tail BEFORE the move, so the incoming clip's sound is set to its share of the
          // crossfade from its first write - not to its full level for the moment until `goTo`
          // gets round to the tail, which is a click at the start of every transition.
          const leaving = this.spare;
          leaving.role = 'tail';
          leaving.segmentId = current.clip.id;
          leaving.wantPlaying = wasPlaying;
        }
        this.goTo(this.handoverMs(next), wasPlaying);
        return;
      }
    }
    this.goToSlot(next, wasPlaying);
  }

  /**
   * Where the playhead goes as the clock passes to the element that has just taken over: wherever
   * that element has already got to.
   *
   * It was started a start stall early, so it is usually a frame or two into the clip by now, and
   * sometimes a frame or two short of it. Taking its word for where it is keeps the picture exactly
   * as it runs - the playhead moves by those few frames instead - where putting it back on the
   * boundary would be a seek on the element that has to be moving, which is the very stall the
   * early start was there to take away.
   */
  private handoverMs(next: TimelineSlot): number {
    const video = this.video;
    if (video.paused) return next.startMs;
    const at = outputMsAt(next, video.currentTime * 1000);
    return clamp(at, next.startMs, next.startMs + Math.max(0, next.durationMs - 1));
  }

  private goToSlot(slot: TimelineSlot, autoplay: boolean): void {
    const clip = this.store.clipByKey(slot.clip.clipKey);
    if (!clip) {
      // Nothing to move on to; after an `ended` nobody else will say the element stopped.
      this.video.pause();
      this.readPlayState();
      return;
    }
    this.segmentId = slot.clip.id;
    this.store.playheadMs.value = slot.startMs;
    if (this.active.key !== clip.key || !this.active.hasMeta) this.load(clip, slot, slot.startMs, autoplay);
    else this.applyAt(slot, slot.startMs, autoplay, true);
  }

  /* ========================================================================================= */
  /* Sound                                                                                     */
  /* ========================================================================================= */

  /**
   * The clip's own sound on the clock's element - and, inside a transition, the outgoing clip's on
   * the tail's, the two shared out across the window. `atMs` is where the transition is read at, the
   * playhead unless the caller knows better.
   */
  private applyVideoAudio(clip: EditClip, atMs?: number): void {
    const at = atMs ?? this.clockMs();
    this.applyBaseAudio(clip, this.windowAt(this.store.slots.value, at));
  }

  /**
   * The base clips' own sound: the clock's clip at its own volume and mute and the post's, which is
   * how the render mixes it and how a layer's clips reach the speaker too - and inside a transition
   * both clips at once, crossfaded across the window the pictures cross in, on the ramps the export
   * mixes them with; see [crossfade].
   *
   * Where the WebView will not let a page set a volume (iOS), a fade is two clips at full volume at
   * once, so it is not attempted: the incoming clip is heard from the first frame of the window, and
   * the tail not at all.
   */
  private applyBaseAudio(clip: EditClip, window: TransitionWindow | null): void {
    const silenced = clipsSilenced(this.store);
    const spare = this.spare;
    const tail = window && spare.role === 'tail' && spare.segmentId === window.from.id ? spare : null;
    if (!window || !tail) {
      applyClipAudio(this.video, clip, silenced);
      return;
    }
    if (!volumeIsWritable()) {
      applyClipAudio(this.video, clip, silenced);
      setSound(tail.video, true, tail.video.volume);
      return;
    }
    const share = crossfade(window.progress);
    setSound(this.video, silenced || clip.muted, clamp(clip.volume, 0, 1) * share.to);
    setSound(tail.video, silenced || window.from.muted, clamp(window.from.volume, 0, 1) * share.from);
  }

  /**
   * Keeps the music and the voiceover take under the playhead where the render will put them. Both
   * stay silent during a recording, for the same reason the clip's sound does.
   *
   * @param running the video has been playing steadily - this is the frame loop, not a play, a seek
   *   or a load that the video is itself still starting up from.
   */
  private syncAudio(ms: number, playing: boolean, running = false): void {
    const manifest = this.store.manifest.value;
    const total = this.store.totalMs.value;
    const live = playing && this.store.recordingFromMs.value === null;

    const music = manifest.music;
    this.setSource(this.musicEl, music?.uri ?? null, 'music');
    // Sound that is about to be due is started NOW, a stall before it is needed: the position it is
    // put at is still counted from the playhead, so what comes out starts exactly on time - and the
    // first moment of a track or a take is heard rather than swallowed by the output starting up.
    const musicLead = music && live ? this.leadWindow(this.musicEl) : 0;
    const heard = music ? musicWindow(music, total) : null;
    const musicAt =
      music && heard && live
        ? (musicSourceMsAt(music, ms, total) ??
          (ms < heard.startMs && heard.startMs - ms <= musicLead ? music.inMs + ms - heard.startMs : null))
        : null;
    if (music && heard && musicAt !== null) {
      // The render fades the track out over its last `fadeOutMs`; the preview follows along.
      const fade = music.fadeOutMs > 0 ? clamp((heard.endMs - ms) / music.fadeOutMs, 0, 1) : 1;
      this.playAt(this.musicEl, musicAt, clamp(music.volume, 0, 1) * fade, running);
    } else if (!this.musicEl.paused) {
      this.musicEl.pause();
    }

    const voiceLead = live ? this.leadWindow(this.voiceEl) : 0;
    const take = live
      ? manifest.voiceovers.find((t) => ms >= t.startMs - voiceLead && ms < t.startMs + t.durationMs)
      : undefined;
    if (take) {
      this.setSource(this.voiceEl, take.uri, 'voice');
      this.playAt(this.voiceEl, ms - take.startMs, clamp(take.volume, 0, 1), running);
    } else if (!this.voiceEl.paused) {
      this.voiceEl.pause();
    }
  }

  /** @param running see [syncAudio]. */
  private playAt(el: HTMLAudioElement, positionMs: number, volume: number, running: boolean): void {
    if (el.volume !== volume) el.volume = volume;
    if (el.paused) {
      this.putAudio(el, positionMs, running ? 'warm' : 'cold');
      startPlayback(el);
      return;
    }
    const atMs = el.currentTime * 1000;
    const settling = this.settling.get(el);
    if (settling) {
      if (performance.now() - settling.wallMs > AUDIO_SETTLE_TIMEOUT_MS) {
        this.settling.delete(el);
      } else if (atMs < settling.putAtMs + AUDIO_SETTLED_MS) {
        // Inside the stall the element is expected to be off by up to its lead; only something
        // further out than that (the music looping round) is a drift to correct now.
        if (Math.abs(atMs - positionMs) <= MAX_AUDIO_LEAD_MS + AUDIO_DRIFT_MS) return;
      } else {
        this.settling.delete(el);
        // Measured only against a video that is running steadily itself.
        const behindMs = positionMs - atMs;
        if (running && Math.abs(behindMs) <= MAX_AUDIO_LEAD_MS) {
          const leadMs = clamp(settling.leadMs + behindMs, 0, MAX_AUDIO_LEAD_MS);
          this.leadsFor(el)[settling.kind] = leadMs;
          lastAudioLeadMs = leadMs;
        }
      }
    }
    if (Math.abs(atMs - positionMs) > AUDIO_DRIFT_MS) {
      if (running) {
        this.putAudio(el, positionMs, 'seek');
      } else {
        // The video is seeking or starting as well; its own stall would be learned as the audio's.
        el.currentTime = positionMs / 1000;
        this.settling.delete(el);
      }
    }
  }

  /** Seeks an audio element to `positionMs` plus the stall it is about to have, and measures it once past it. */
  private putAudio(el: HTMLAudioElement, positionMs: number, kind: AudioPut): void {
    const leadMs = this.leadsFor(el)[kind] ?? lastAudioLeadMs;
    // A negative position is sound that is not due yet (see [syncAudio]); it starts at its beginning.
    const putAtMs = Math.max(0, positionMs + leadMs);
    if (Math.abs(el.currentTime * 1000 - putAtMs) > SEEK_EPSILON_S * 1000) el.currentTime = putAtMs / 1000;
    this.settling.set(el, { kind, putAtMs, leadMs, wallMs: performance.now() });
  }

  /** How early sound has to start on this element for it to be heard on time - its longest known stall. */
  private leadWindow(el: HTMLAudioElement): number {
    const leads = this.leadsFor(el);
    return leads.warm ?? leads.cold ?? lastAudioLeadMs;
  }

  private leadsFor(el: HTMLAudioElement): Partial<Record<AudioPut, number>> {
    let leads = this.audioLeadMs.get(el);
    if (!leads) {
      leads = {};
      this.audioLeadMs.set(el, leads);
    }
    return leads;
  }

  private setSource(el: HTMLAudioElement, uri: string | null, which: 'music' | 'voice'): void {
    const current = which === 'music' ? this.musicUri : this.voiceUri;
    if (current === uri) return;
    if (which === 'music') this.musicUri = uri;
    else this.voiceUri = uri;
    el.pause();
    if (uri) {
      el.src = this.store.host.platform.fileUrl(uri);
    } else {
      el.removeAttribute('src');
    }
    el.load();
  }

  private pauseAudio(): void {
    if (!this.musicEl.paused) this.musicEl.pause();
    if (!this.voiceEl.paused) this.voiceEl.pause();
  }

  /* ========================================================================================= */
  /* The second layer                                                                          */
  /* ========================================================================================= */

  /**
   * One layer's element, handed over as the render creates it and taken back as it removes it.
   *
   * It arrives this way rather than through the constructor because the component writes an element
   * out per layer the post HAS: a post with one video never opens a second decoder, and one with
   * five opens five because five is what it has to draw.
   */
  attachFollower(trackId: string, media: FollowerMedia | null): void {
    if (this.destroyed) return;
    this.followers.get(trackId)?.destroy();
    if (!media) {
      this.followers.delete(trackId);
      return;
    }
    this.followers.set(trackId, new FollowerVideo(this.store, media));
    // A track added while the base is still loading its own clip is going to play the moment that
    // lands, so the element is started from what the player is heading for rather than from where
    // the base happens to be sitting.
    this.syncFollower(this.isPlaying());
  }

  /**
   * Puts every layer where the base has just got to. The base element is the clock - its track is
   * the one whose length is the post's - so this is called from everywhere the base moves and from
   * nowhere else; there is no frame loop per layer and no second reading of the time.
   *
   * A follower whose track has no clip under the playhead is synced with null rather than skipped,
   * which is what tells it to hide itself: skipping would leave the last frame of a layer that has
   * ended sitting on the frame.
   */
  private syncFollower(playing: boolean): void {
    const byTrack = new Map(this.extraLayers().map((layer) => [layer.trackId, layer] as const));
    for (const [trackId, follower] of this.followers) {
      follower.sync(byTrack.get(trackId) ?? null, playing);
    }
  }

  /* ========================================================================================= */
  /* Helpers                                                                                   */
  /* ========================================================================================= */

  private setPoster(deck: BaseDeck, clip: EditorSource, sourceMs: number): void {
    const poster = posterFor(this.store, clip, sourceMs);
    deck.posterIsBlank = !poster;
    deck.video.setAttribute('poster', poster ?? BLANK_POSTER);
  }

  private currentSlot(): TimelineSlot | null {
    return this.store.slots.value.find((slot) => slot.clip.id === this.segmentId) ?? null;
  }

  private isPlaying(): boolean {
    if (this.tail) return true;
    return this.pendingLoad ? this.autoplay : !this.video.paused;
  }

  private listen(target: EventTarget, type: string, handler: () => void): void {
    target.addEventListener(type, handler);
    this.unlisten.push(() => target.removeEventListener(type, handler));
  }
}

/**
 * An element's mute and volume, each written only when it has moved: a crossfade writes these on
 * every frame of a transition, and a WebView may do real work for a write that changes nothing.
 */
function setSound(video: HTMLVideoElement, muted: boolean, volume: number): void {
  if (video.muted !== muted) video.muted = muted;
  const level = clamp(Number.isFinite(volume) ? volume : 0, 0, 1);
  if (video.volume !== level) video.volume = level;
}
