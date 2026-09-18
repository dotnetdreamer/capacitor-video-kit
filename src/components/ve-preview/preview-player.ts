import {
  clamp,
  musicSourceMsAt,
  musicWindow,
  sourceMsAt,
  type EditClip,
  type TimelineSlot,
} from '../../editor';
import { debugWarn } from '../../host/debug';
import type { EditorSource } from '../../host/host.types';
import type { EditorStore, PreviewVideoLayer } from '../../state/editor-store';
import type { EditorPlayer } from '../../state/editor.types';
import { FollowerVideo, type FollowerMedia } from './follower-video';
import {
  BLANK_POSTER,
  SEEK_EPSILON_S,
  VideoHold,
  applyClipAudio,
  clipsSilenced,
  onPageShown,
  posterFor,
  previewSrc,
  repaintPaused,
  startPlayback,
} from './preview-media';

/** How often the playhead signal is written while playing. The timeline scrolls from it. */
const PLAYHEAD_WRITE_MS = 33;
/**
 * A cut to a different source starts this far before the segment's out point. The check runs once
 * a frame, so without the margin the old clip would show a frame or two past its trim.
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

export interface PreviewMedia {
  video: HTMLVideoElement;
  /** Where the outgoing frame is held while the video element is pointed at the next source. */
  hold: HTMLCanvasElement;
  /** Raises and lowers the hold. The component owns the signal the render reads. */
  setHolding: (on: boolean) => void;
  music: HTMLAudioElement;
  voice: HTMLAudioElement;
  /**
   * The video layer above the base one under the playhead, or null when there is none there. It is
   * read from the same signal the component DRAWS from, so the element and the box it is placed in
   * can never disagree about which clip they are on.
   */
  extraLayer: () => PreviewVideoLayer | null;
}

/**
 * Plays the edit on ONE `<video>` element per video LAYER, swapping each between its own segments,
 * plus one `<audio>` for the music and one for the voiceover take under the playhead.
 *
 * One element per layer and not one per segment, because phones run out of hardware decoders long
 * before they run out of anything else, and the feed behind this modal may still hold some. The
 * second layer's element is a [FollowerVideo] and is attached only while the post has a second
 * track; this one stays the clock, because the base track's length is the post's. The cost of the
 * single element is that moving between sources is a load, and nearly everything below exists to
 * make those loads invisible:
 *  - every load is superseded by the next (a token), so a slow one never lands on top of a newer one;
 *  - while a load or a seek is in flight, further seeks only remember the latest target, so scrubbing
 *    the timeline cannot queue up a decode per frame;
 *  - two segments cut from the same source back to back (a split) play straight through with no load
 *    and no seek, and a segment of the same source with a different trim is only a seek.
 *
 * Every store read below happens on a media event, a frame of the loop or a deferred effect, so it
 * is outside any signal effect and therefore untracked: nothing here subscribes to the store, and
 * what it writes - the playhead, the transport - is what wakes the components that draw from it.
 */
export class PreviewPlayer implements EditorPlayer {
  private readonly video: HTMLVideoElement;
  private readonly musicEl: HTMLAudioElement;
  private readonly voiceEl: HTMLAudioElement;

  /** The segment the element is showing, by segment id - indices move when the manifest changes. */
  private segmentId: string | null = null;
  /** The host clip key whose source is on the element. */
  private loadedKey: string | null = null;
  private posterIsBlank = true;

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

  private musicUri: string | null = null;
  private voiceUri: string | null = null;
  /** Audio elements started or seeked and not yet checked: where they were put (ms), and how often. */
  private readonly settling = new Map<
    HTMLAudioElement,
    { kind: AudioPut; putAtMs: number; leadMs: number; wallMs: number }
  >();
  /** How long each element's clock stands still after a start and after a seek, as last measured. */
  private readonly audioLeadMs = new Map<HTMLAudioElement, Partial<Record<AudioPut, number>>>();

  private destroyed = false;
  private readonly unlisten: Array<() => void> = [];

  private readonly hold: VideoHold;
  private readonly extraLayer: () => PreviewVideoLayer | null;
  /** The second layer's element while the post has one; see [attachFollower]. */
  private follower: FollowerVideo | null = null;

  constructor(
    private readonly store: EditorStore,
    media: PreviewMedia,
  ) {
    this.video = media.video;
    // Sized to outlast the load watchdog and one seek watchdog behind it, which is the longest a
    // hold can legitimately be waiting for the frame that replaces it.
    this.hold = new VideoHold(media.video, media.hold, media.setHolding, LOAD_WATCHDOG_MS + SEEK_WATCHDOG_MS);
    this.extraLayer = media.extraLayer;
    this.musicEl = media.music;
    this.voiceEl = media.voice;

    this.listen(this.video, 'play', () => this.readPlayState());
    // At a segment's natural end `pause` comes just before `ended`, which moves on to the next
    // segment. Reading it as a real pause would flash the transport to "play" across every cut.
    this.listen(this.video, 'pause', () => {
      if (!this.video.ended) this.readPlayState();
    });
    this.listen(this.video, 'seeked', () => this.onSeeked());
    this.listen(this.video, 'ended', () => this.onEnded());
    // The frame loop is what moves the playhead; this only covers a WebView that has stopped
    // running animation frames (the app in the background, a throttled tab) while the element plays.
    this.listen(this.video, 'timeupdate', () => {
      if (!this.video.paused) this.follow();
    });
    // A picker, a phone call or the home button takes the page away, and the paused elements'
    // pictures with it; see [onPageShown] and [revive].
    this.unlisten.push(onPageShown(() => this.revive()));
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
      startPlayback(this.video);
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
  }

  /* ========================================================================================= */
  /* Reacting to the edit                                                                      */
  /* ========================================================================================= */

  /**
   * The segments changed - a trim, a split, a speed, a reorder, a delete, an undo. While paused the
   * frame under the playhead is shown again; while playing, the segment that is on screen keeps
   * playing with its new speed and sound, unless it is gone or now belongs to another source.
   */
  resync(): void {
    if (this.destroyed) return;
    const playing = this.isPlaying();
    const slot = this.currentSlot();
    if (playing && slot && !this.pendingLoad && slot.clip.clipKey === this.loadedKey) {
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
    this.follower?.refreshPoster();
    if (!this.posterIsBlank) return;
    const slot = this.currentSlot();
    const clip = slot ? this.store.clipByKey(slot.clip.clipKey) : undefined;
    if (!slot || !clip || clip.key !== this.loadedKey) return;
    this.setPoster(clip, sourceMsAt(slot, this.store.playheadMs.value));
  }

  /**
   * An element's box has just moved on screen, and a paused one does nothing about that by itself;
   * see [repaintPaused] for what that costs and why a seek is the answer.
   *
   * This is called from the render rather than from the effects above, because the frame has to be
   * painted into the box the element ALREADY has and the render is where it gets one. It is also the
   * only place a geometry change can be noticed at all: a layout preset writes rectangles onto every
   * clip of both tracks without moving the playhead, so `resync` runs, finds the element on exactly
   * the time it is already on, and quite rightly seeks nothing. Nothing else in the player ever
   * hears that the picture is meant to be somewhere else.
   *
   * A seek in flight is left to land: it is going to present a frame of its own, into whatever box
   * the element has by then, and a nudge would only pull it off the position it was asked for. A
   * load in flight has no frame to repaint and is filtered out by [repaintPaused].
   */
  repaintBase(): void {
    if (this.destroyed || this.seekInFlight) return;
    repaintPaused(this.video);
  }

  /** The same for the second layer, whose box every arrangement moves along with the base's. */
  repaintExtra(): void {
    if (this.destroyed) return;
    this.follower?.repaint();
  }

  /**
   * Puts the picture back after the page has been away; [onPageShown] is where what takes it is
   * written down.
   *
   * The source is FORGOTTEN rather than seeked, which is the whole of the fix: forgetting it is what
   * makes `goTo` load it again, and a load is one of the two things that gives a purged element a
   * picture back. The load ends in a forced seek to the playhead like every other, so what arrives is
   * the frame the customer was left looking at.
   *
   * An element that is playing has lost nothing - playing is the other thing that restores it, and
   * WebKit has already done it by the time this runs - so it is left alone rather than stalled by a
   * load it does not need.
   */
  private revive(): void {
    if (this.destroyed || !this.video.paused) return;
    this.loadedKey = null;
    this.goTo(this.store.playheadMs.value, false);
    this.follower?.revive();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopLoop();
    this.cancelLoad?.();
    this.cancelLoad = null;
    this.hold.destroy();
    this.follower?.destroy();
    this.follower = null;
    if (this.seekTimer) clearTimeout(this.seekTimer);
    for (const off of this.unlisten) off();
    for (const el of [this.video, this.musicEl, this.voiceEl]) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }

  /* ========================================================================================= */
  /* Loading and seeking                                                                       */
  /* ========================================================================================= */

  /** Puts the element on the segment under `ms`, loading its source only when it is not already on. */
  private goTo(ms: number, autoplay: boolean, forceSeek = false): void {
    if (this.destroyed) return;
    const slots = this.store.slots.value;
    const index = slotIndexAt(slots, ms);
    if (index < 0) return;
    const slot = slots[index];
    const clip = this.store.clipByKey(slot.clip.clipKey);
    if (!clip) return;

    this.segmentId = slot.clip.id;
    this.store.playheadMs.value = ms;

    if (this.loadedKey !== clip.key) {
      this.load(clip, slot, ms, autoplay);
      return;
    }
    this.applyAt(slot, ms, autoplay, forceSeek);
  }

  /**
   * Points the element at another source. The position, speed and sound are applied once its
   * metadata is in - through `goTo` again, so a manifest that changed during the load is read as it
   * is by then, and a seek that arrived meanwhile wins over the one that started the load.
   */
  private load(clip: EditorSource, slot: TimelineSlot, ms: number, autoplay: boolean): void {
    const video = this.video;
    const token = ++this.loadToken;
    this.cancelLoad?.();
    this.pendingLoad = true;
    this.autoplay = autoplay;
    this.loadedKey = clip.key;
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
        this.loadedKey = null;
        // Nothing is coming to replace the held frame, and holding a stale one over a clip that
        // will not play reads as the preview being stuck. The queued seek below may raise it again.
        this.hold.lower();
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

    // Order matters: the frame has to be copied while the OLD source is still on screen. One line
    // later, after `src` is assigned, there is nothing left to copy.
    this.hold.raise();
    this.setPoster(clip, sourceMsAt(slot, ms));
    video.src = previewSrc(this.store, clip);
    video.load();
  }

  private applyAt(slot: TimelineSlot, ms: number, autoplay: boolean, forceSeek: boolean): void {
    const video = this.video;
    video.playbackRate = slot.clip.speed || 1;
    // Some WebViews reset pitch correction on every source change, so it is set each time.
    (video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
    this.applyVideoAudio(slot.clip);

    const sourceSec = sourceMsAt(slot, ms) / 1000;
    const tolerance =
      autoplay && !video.paused && !forceSeek
        ? (PLAYING_SEEK_TOLERANCE_MS * (slot.clip.speed || 1)) / 1000
        : SEEK_EPSILON_S;
    if (forceSeek || Math.abs(video.currentTime - sourceSec) > tolerance) {
      this.armSeek();
      video.currentTime = sourceSec;
    }

    this.autoplay = autoplay;
    if (autoplay) {
      if (video.paused) startPlayback(video);
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
      // Still holding on purpose: a scrub that queued another target has not arrived anywhere yet,
      // and lowering between the two would show the intermediate frame as a flicker.
      this.goTo(next, this.isPlaying());
      return;
    }
    // Settled on the frame that was asked for, so the held one has done its job.
    this.hold.lower();
    if (!this.video.paused) this.syncAudio(this.store.playheadMs.value, true);
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
    const playing = !this.video.paused;
    if (this.store.playing.value !== playing) this.store.playing.value = playing;
    if (playing) {
      this.startLoop();
    } else {
      this.stopLoop();
      this.pauseAudio();
      this.follower?.pause();
    }
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
   * One step of playback: moves on at the segment's out point, and otherwise keeps the playhead and
   * the audio in step with the element. Reading the trim from the manifest every time, rather than
   * from a copy taken when the segment started, means a trim changed mid-playback applies at once.
   */
  private follow(): void {
    // While a new source is loading, the element still reports the OLD source's position. Acting on
    // it would compare the previous clip's time against the next clip's trim - and skip the next
    // clip outright whenever it is trimmed shorter.
    if (this.pendingLoad || this.seekInFlight || this.destroyed) {
      // The clock has stopped: the base is between sources, or settling on a frame it was seeked
      // to. A second layer that ran on through that would come back a load's worth ahead and be
      // yanked back into place, so it waits with the base rather than drifting past it.
      this.follower?.pause();
      return;
    }
    const slots = this.store.slots.value;
    const index = slots.findIndex((slot) => slot.clip.id === this.segmentId);
    if (index < 0) {
      this.goTo(clamp(this.store.playheadMs.value, 0, this.store.totalMs.value), true);
      return;
    }
    const slot = slots[index];
    const next = slots[index + 1];
    const sourceMs = this.video.currentTime * 1000;
    const seamless = !!next && continuesInPlace(slot, next);
    const cutAt = seamless ? slot.clip.outMs : slot.clip.outMs - CUT_EARLY_MS;

    if (sourceMs >= cutAt) {
      // At a clip's natural end the element sets `paused` BEFORE it fires `pause` - so `paused` alone
      // reads "was not playing" and the preview would stall at the boundary. `playing` still holds
      // what the events last reported, which is the truth: it was playing up to the end.
      this.advance(index, this.store.playing.value || !this.video.paused);
      return;
    }
    if (sourceMs < slot.clip.inMs - BEHIND_TRIM_MS) {
      this.goTo(slot.startMs, true);
      return;
    }
    this.writePlayhead(false);
  }

  private writePlayhead(force: boolean): void {
    if (this.pendingLoad || this.seekInFlight) return;
    const now = performance.now();
    if (!force && now - this.lastWriteAt < PLAYHEAD_WRITE_MS) return;
    const slot = this.currentSlot();
    if (!slot || slot.clip.clipKey !== this.loadedKey) return;
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
      this.video.pause();
      this.pauseAudio();
      this.store.playheadMs.value = this.store.totalMs.value;
      this.readPlayState();
      return;
    }
    if (current && continuesInPlace(current, next) && next.clip.clipKey === this.loadedKey && !this.video.ended) {
      // Two halves of a split: the element is already exactly where the next segment begins.
      this.segmentId = next.clip.id;
      this.video.playbackRate = next.clip.speed || 1;
      this.applyVideoAudio(next.clip);
      return;
    }
    this.goToSlot(next, wasPlaying);
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
    if (this.loadedKey !== clip.key) this.load(clip, slot, slot.startMs, autoplay);
    else this.applyAt(slot, slot.startMs, autoplay, true);
  }

  /* ========================================================================================= */
  /* Sound                                                                                     */
  /* ========================================================================================= */

  /** The clip's own sound. A second layer's clips reach the speaker the same way, through the same
      call: the render mixes them identically, through their own volume and mute and the post's. */
  private applyVideoAudio(clip: EditClip): void {
    applyClipAudio(this.video, clip, clipsSilenced(this.store));
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
   * The extra track's element, handed over as the render creates it and taken back as it removes
   * it. It arrives this way rather than through the constructor because the component only writes it
   * out while the post HAS a second track: a post with one video never opens a second decoder, which
   * is the budget [MAX_VIDEO_TRACKS] is counting.
   */
  attachFollower(media: FollowerMedia | null): void {
    if (this.destroyed) return;
    this.follower?.destroy();
    this.follower = media ? new FollowerVideo(this.store, media, LOAD_WATCHDOG_MS + SEEK_WATCHDOG_MS) : null;
    // A track added while the base is still loading its own clip is going to play the moment that
    // lands, so the element is started from what the player is heading for rather than from where
    // the base happens to be sitting.
    this.syncFollower(this.isPlaying());
  }

  /**
   * Puts the second layer where the base has just got to. The base element is the clock - its track
   * is the one whose length is the post's - so this is called from everywhere the base moves and
   * from nowhere else; there is no second frame loop and no second reading of the time.
   */
  private syncFollower(playing: boolean): void {
    this.follower?.sync(this.extraLayer(), playing);
  }

  /* ========================================================================================= */
  /* Helpers                                                                                   */
  /* ========================================================================================= */

  private setPoster(clip: EditorSource, sourceMs: number): void {
    const poster = posterFor(this.store, clip, sourceMs);
    this.posterIsBlank = !poster;
    this.video.setAttribute('poster', poster ?? BLANK_POSTER);
  }

  private currentSlot(): TimelineSlot | null {
    return this.store.slots.value.find((slot) => slot.clip.id === this.segmentId) ?? null;
  }

  private isPlaying(): boolean {
    return this.pendingLoad ? this.autoplay : !this.video.paused;
  }

  private listen(target: EventTarget, type: string, handler: () => void): void {
    target.addEventListener(type, handler);
    this.unlisten.push(() => target.removeEventListener(type, handler));
  }
}

/** The segment playing at `ms`; the very end of the timeline belongs to the last one. */
export function slotIndexAt(slots: readonly TimelineSlot[], ms: number): number {
  if (!slots.length) return -1;
  const index = slots.findIndex((slot) => ms < slot.startMs + slot.durationMs);
  return index >= 0 ? index : slots.length - 1;
}

/** Whether `next` picks up the same source exactly where `slot` leaves it - the two halves of a split. */
export function continuesInPlace(slot: TimelineSlot, next: TimelineSlot): boolean {
  return slot.clip.clipKey === next.clip.clipKey && Math.abs(next.clip.inMs - slot.clip.outMs) <= 1;
}
