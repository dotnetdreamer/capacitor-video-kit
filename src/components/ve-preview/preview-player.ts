import {
  clamp,
  compileTransition,
  findClip,
  joinContinuousAudio,
  musicFadeAt,
  musicPhaseMs,
  musicSourceMsAt,
  musicSpeed,
  musicWindow,
  sourceMsAt,
  transitionWindowAt,
  type CompiledTransition,
  type EditAudioClip,
  type EditClip,
  type EditMusic,
  type TimelineSlot,
  type TransitionWindow,
} from '../../editor';
import { debugWarn } from '../../host/debug';
import type { EditorSource } from '../../host/host.types';
import type { EditorStore, PreviewVideoLayer } from '../../state/editor-store';
import type { EditorPlayer } from '../../state/editor.types';
import { sameUrl } from '../../state/same-url';
import type { ClipMedia } from './clip-media';
import { FollowerVideo, type FollowerMedia } from './follower-video';
import type { BaseShot } from './preview-canvas';
import {
  BLANK_POSTER,
  SEEK_EPSILON_S,
  applyClipAudio,
  applyPitch,
  applySoundRate,
  atFileEnd,
  audioEndGuardMs,
  audioSlowToSeekOnItsOwn,
  clipsSilenced,
  fileEndMs,
  musicSpan,
  onPageShown,
  oneVideoSoundAtATime,
  passFollows,
  passMs,
  playedOut,
  posterFor,
  previewSrc,
  soundOffsetMs,
  soundPutMs,
  startPlayback,
  takeSpan,
  volumeIsWritable,
  wrapAimMs,
  type SoundSpan,
} from './preview-media';
import { PreviewMixer, levelsInUse, playableHere } from './preview-mixer';
import type { PreviewPictures } from './preview-pictures';
import {
  MAX_START_LEAD_MS,
  PRELOAD_AHEAD_MS,
  TAIL_SEEK_MS,
  boundaryAfterSplits,
  boundaryKind,
  crossfade,
  easedTailRate,
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
 * A repeating section is sent round to its next pass a seek stall before its element gets to the out
 * point - the element's own seek lead, measured like every other - and not left to reach it. At the
 * latest this long before it, or before the end guard where there is one (see [AUDIO_END_GUARD_MS]):
 * the sound is checked every [PLAYHEAD_WRITE_MS], which is two frames and sometimes three, so an
 * element is always seen at least once in the last this-much before the point it has to go by.
 *
 * Left to reach it, the element stopped at the end of its file (or played on past an out point short
 * of it) and sat there until the playhead came round the seam too and the frame loop started it
 * again: up to 100 ms of silence at every seam in Chromium, where the element runs 60-90 ms ahead of
 * the playhead, and then its start stall. Sent round a stall early, it comes out of the seek on the
 * next pass's first moment as the playhead gets there, and what the stall costs is the last moment of
 * this pass instead. On WebKit it is also what keeps it off the end of its file, where a seek costs
 * the file its length: WebKit's seek stall is 95-130 ms (iOS 26.5 simulator), so it is sent round
 * before it gets inside the guard.
 *
 * Sent round any EARLIER than its stall, an element comes out of the seek on the in point before the
 * playhead is there - there is nothing before the in point to put it on - and stays that much ahead,
 * which the next seam adds to again; that is why the stall and not a fixed margin says when.
 *
 * Where the stall is SHORTER than this floor - Chromium's under 50 ms, or an iPhone's under 100 ms -
 * that is what happens all the same: the element is seen somewhere in the last this-much and has to go
 * then, up to the difference early. Each seam leaves it a little further ahead, until [AUDIO_DRIFT_MS]
 * puts it back. It stays bounded: with the preview's audio tests' stand-in elements, a 1 s section
 * looped for 28 s came to ~260 ms ahead at worst, with a correcting seek every six seams or so, for a
 * 60 ms stall on WebKit and a 10 ms one on Chromium; the iOS simulator's ~100 ms stall does not reach
 * it. A timer set for the exact moment would avoid it, but not safely: one frame late on a busy
 * WebView, it lets WebKit's element into the guard, and that element is then left to end and started
 * again cold - a gap and a start stall, where this costs a few tens of ms of lead at a seam.
 *
 * A file that ends a little short of its section's out point comes to the same. WebKit reads a 12 s
 * AAC `.m4a` as 11.975 s, where the section, read as the iOS render reads it (`probe` answers the audio
 * track's end), runs to 12.000 s. Sent round a stall before the end of its FILE, where it has to go,
 * the element has nothing to play for the rest of the pass and starts the next one up to 25 ms early,
 * which the drift check bounds in the same way. Paused rather than sent round - one that has played to
 * the end of its file - it waits for the playhead to reach the out point instead; see [soundPutMs].
 *
 * Not the element's own `loop`, even for a section that is the whole file. Both engines loop an
 * element by seeking it back to the start once it has ended, so it has the same stall - only at the
 * start of the next pass, which comes in late by it and stays late, inside the drift allowed - and on
 * the pass the post ends on, an element running ahead would loop the start of the track over the
 * last frames.
 */
const LOOP_WRAP_EARLY_MS = 50;
/**
 * An element that is still reported playing at the end of its file this long after it got there is
 * taken for one that will never say it has ended (see [AUDIO_END_GUARD_MS]), and is paused so it can
 * be put like any other. Long past the few tens of milliseconds the notice takes when it comes.
 */
const AUDIO_END_WAIT_MS = 500;
/**
 * A file whose element now says it is this much shorter than it said before, and than the stretch of
 * it the post plays, sitting at that new end, has had its length cut short under it by WebKit; see
 * [PreviewPlayer.recoverLength].
 */
const COLLAPSED_BY_MS = 250;
/**
 * ...and whose new length is no further than this from where the preview last put the element: WebKit
 * takes the length from where a seek put it (0.121 s, put there and read back to the millisecond on the
 * iOS 26.5 simulator), where a length read properly at last comes down to wherever the file really
 * ends, which has nothing to do with any put.
 */
const COLLAPSED_AT_PUT_MS = 50;
/** A file reloaded for that is not reloaded again for this long, whatever it says. */
const RELOAD_RETRY_MS = 1000;
/**
 * The lead to use before anything has been measured. The very first play after a cold launch has no
 * measurement to go on, and the phone's audio output takes ~150-200 ms to start, so music and
 * voiceovers came in that late every first time - the one play a customer is most likely to judge the
 * editor by. Starting from the middle of that range costs nothing if it is wrong: the first put is
 * measured like any other and replaces this with the real figure.
 */
const DEFAULT_AUDIO_LEAD_MS = 180;

/**
 * An audio element that is SLOW TO SEEK - every one in Safari on a Mac ([audioSlowToSeekOnItsOwn]),
 * and one played through [PreviewMixer] wherever that is - is only judged this long after it was put,
 * whatever its clock has done by then. An iPhone's element played straight to the speaker is not one
 * of them; see [PreviewPlayer.slowToSeek].
 *
 * Slow to seek is not slow to play. Left alone such an element runs at 1.00x like any other. What it
 * has is a long and uneven stall after every start and every seek, and it does not stand still and then
 * run, which is what [AUDIO_SETTLED_MS] waits out: it moves on at first, then stands still for a couple
 * of hundred milliseconds, moves, stands still again. It was measured twice on 2026-09-29, the same
 * shape both times:
 *  - ROUTED on iOS - played through the mixer, which is every music and voiceover element of a post
 *    with a level for them, and so every new sound, which comes with 80 % and a fade-out: about 440 ms
 *    of its clock lost over the second after the put, where the same element not routed loses about
 *    45 ms (the app's WebView on the iOS 26.5 simulator, with nothing muted). Its music was seeked 86
 *    times a minute and ran at 0.6x.
 *  - NOT routed, in WebKit on a Mac, which can set `volume` and so never routes anything (Playwright's
 *    build of Safari's engine, running the web editor): 390-475 ms lost over the 0.8 s after a seek,
 *    about 150 ms of it in the first quarter of a second and the rest after a couple of hundred
 *    milliseconds of running; 285-334 ms after a start. Its music was seeked again about every 0.7 s -
 *    up to 30 times in a 24 s play, 2 or 3 corrections after most seams - and twice in seven runs a
 *    correction landed in the stretch a section is sent round from and waited there, paused, for the
 *    seam (see [soundPutMs]): 126 ms and about 300 ms of silence just before it. The same page, told
 *    it had a touch screen, routed the music and was judged over this second, and the music was put
 *    once at each seam.
 * Judged the way Chromium's element is, it had "settled" a few hundred milliseconds in, with most of the
 * stall still to come, so the lead learned from it was about 150 ms; the rest of the stall then left it
 * more than [AUDIO_DRIFT_MS] behind the picture about 0.7 s after the put, and it was put again - into
 * another second of the same.
 *
 * Judged once this has gone by, the whole of the stall is in the measurement, the lead learned from it
 * covers it, and the next put - if one is needed at all - lands in step and stays there.
 *
 * Told by the engine and not by routing alone: routing is what makes an iPhone's element stall like
 * this, but a Mac's is never routed and stalls just as long. An iPhone's element that is not routed
 * stalls only about 45 ms, and is judged this way all the same - the lead learned for it is the same
 * one, learned a second later, and it does not drift anywhere near the wider allowance
 * [SLOW_SEEK_DRIFT_MS] leaves it. Chromium's, on a desktop and in Android's WebView, loses a few tens of
 * milliseconds at once, as [AUDIO_SETTLED_MS] expects, and is judged as it always was. The lead each
 * kind starts from, before its own is measured, is another matter: see [DEFAULT_SLOW_SEEK_LEADS_MS].
 */
const SLOW_SEEK_SETTLE_MS = 1200;
/** A slow-to-seek put whose clock has not got [AUDIO_SETTLED_MS] past where it was put after this long is not measured at all. */
const SLOW_SEEK_SETTLE_TIMEOUT_MS = 3000;
/**
 * A slow-to-seek element is put back in step when it is further out than this, rather than
 * [AUDIO_DRIFT_MS]. Every put of one costs a second of uneven clock, so a put for a drift the picture
 * would not show is a worse thing than the drift. Wider than a stall differs by from one put to the
 * next of the same kind - a few tens of milliseconds routed on iOS (419-481 ms over five measured),
 * up to about 85 on a Mac (a seek 390-475 ms) - so a lead learned from one put is never taken for a
 * drift on the next; see [SLOW_SEEK_SETTLE_MS].
 *
 * Wide enough, too, that an element put with a lead that misses its stall by less than this is never
 * put right on its own: it plays on that far out until its next put - the next seam at the earliest,
 * and on a sound that does not repeat, never - and only that put has the lead it was measured to
 * need. Which is why a slow-to-seek element starts from a lead close to its stall, and not from
 * [DEFAULT_AUDIO_LEAD_MS]; see [DEFAULT_ROUTED_LEAD_MS] and [DEFAULT_SLOW_SEEK_LEADS_MS].
 */
const SLOW_SEEK_DRIFT_MS = 300;
/**
 * The longest slow-to-seek stall a lead is learned for; see [MAX_AUDIO_LEAD_MS]. Well past the 481 ms
 * measured - where under [MAX_AUDIO_LEAD_MS] a stall over 400 ms, which a Mac's seek and a routed
 * iPhone's put both come to, would be learned short, at 400.
 */
const MAX_SLOW_SEEK_LEAD_MS = 700;
/**
 * The lead a routed element is put with before its own has been measured: the ~440 ms it was measured
 * losing, for the reason [DEFAULT_AUDIO_LEAD_MS] gives. Kept apart from the other kind's, and learned
 * apart from it: either one taken for the other puts every element of that kind the difference out.
 *
 * Routing, and not the engine, is what splits the two on iOS, because there it is routing that makes
 * the stall long: an iPhone's element that is not routed loses about 45 ms, and starts from
 * [DEFAULT_AUDIO_LEAD_MS]. A Mac's is never routed and stalls long all the same; it starts from
 * [DEFAULT_SLOW_SEEK_LEADS_MS].
 */
const DEFAULT_ROUTED_LEAD_MS = 440;
/**
 * The leads an element that is slow to seek ON ITS OWN - Safari's on a Mac, which routes nothing
 * ([audioSlowToSeekOnItsOwn]) - is put with before its own have been measured, for the reason
 * [DEFAULT_AUDIO_LEAD_MS] gives: close to what it was measured losing, and a kind of put at a time,
 * because a Mac's element loses far more to a seek than to a start (Playwright's build of Safari's
 * engine running the web editor, 2026-09-29).
 *  - A start, cold or warm: 285-334 ms of its clock against the wall clock, and 230-285 against the
 *    picture, which on a cold start is slow to get going itself. 280, between the two.
 *  - A seek - every seam of a repeating section, and every correction: 390-475 ms. 420.
 *
 * Started from [DEFAULT_AUDIO_LEAD_MS] instead, as it was, it misses its stall by less than
 * [SLOW_SEEK_DRIFT_MS] and so is never put right on its own: by those measurements the music would run
 * its whole first pass 50-105 ms behind the picture, and then, sent round the first seam with the lead
 * that start had taught it - which is where every put that nothing has been learned for used to turn,
 * whatever its kind - its second pass 105-245 ms behind. And a section shorter than
 * [SLOW_SEEK_SETTLE_MS] is sent round again before its stall has been judged, every time, so nothing
 * is ever learned for it and it plays at these for the whole play.
 *
 * Kept apart from [DEFAULT_AUDIO_LEAD_MS] by the engine and not by routing, because an iPhone's
 * element played straight to the speaker is WebKit's as well and loses about 45 ms: started from
 * these, it would be up to 375 ms ahead, and put again the moment it was judged.
 */
const DEFAULT_SLOW_SEEK_LEADS_MS: Readonly<Record<AudioPut, number>> = { cold: 280, warm: 280, seek: 420 };

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

/**
 * The clock's position unchanged for this long, while it is meant to be playing, is a STALL - a load,
 * a seek, a decoder that has fallen behind - and the music and the voiceover are held until it moves
 * again rather than left to run ahead of a picture that is not moving; see [holdSound]. Well past a
 * frame on any clock that is actually running: `currentTime` moves on every read of a playing element.
 */
const CLOCK_STILL_MS = 200;
/**
 * For this long after this player changes the clock's rate, a position BEHIND the segment's in point
 * is not taken for a trim that moved. With pitch correction on, WebKit flushes a playing element whose
 * rate changes back to a keyframe - or reports 0 - for a moment (see `applyPitch`), and seeking the
 * element because of it was a second stall on top of the first.
 */
const RATE_FLUSH_MS = 1000;

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
/** The same for a routed audio element; see [DEFAULT_ROUTED_LEAD_MS]. */
let lastRoutedLeadMs = DEFAULT_ROUTED_LEAD_MS;
/**
 * The same for an audio element that is slow to seek on its own - Safari's on a Mac - kept a kind of
 * put at a time, because its seek costs it far more than its start: the lead a start has just taught
 * it, taken for the first seam's, would send it round that seam 105-245 ms late; see
 * [DEFAULT_SLOW_SEEK_LEADS_MS].
 */
const lastSlowSeekLeadsMs: Record<AudioPut, number> = { ...DEFAULT_SLOW_SEEK_LEADS_MS };
/** The same for a video element's start; see [DEFAULT_VIDEO_LEAD_MS]. */
let lastVideoLeadMs = DEFAULT_VIDEO_LEAD_MS;

/** One of an audio lane's two elements: the file on it, and the clip it holds that file for. */
interface LaneSlot {
  /** The element made for the lane. [element] is this or the mixer's stand-in for it. */
  readonly own: HTMLAudioElement;
  element: HTMLAudioElement;
  uri: string | null;
  clipId: string | null;
  /** That clip's speed, which can decide [element] as its file can; see [PreviewMixer.elementFor]. */
  rate: number;
}

export interface PreviewMedia {
  /** The base track's first element. It starts as the clock. */
  video: ClipMedia;
  /** The base track's second element: the spare. See [PreviewPlayer] for what the two are for. */
  partner: ClipMedia;
  music: HTMLAudioElement;
  voice: HTMLAudioElement;
  /** Creates a detached audio element for an audio lane, which takes two. */
  makeAudio?: () => HTMLAudioElement;
  /**
   * Every video layer above the base one under the playhead, bottom to top. Read from the same
   * signal the component DRAWS from, so an element and the box it is placed in can never disagree
   * about which clip they are on.
   */
  extraLayers: () => readonly PreviewVideoLayer[];
  /** The two base elements have just traded places: the base clip on screen is on the other one now. */
  onSwap?: () => void;
  /**
   * The preview's decoded pictures, shared by every element. A layer's NEXT clip, when it is a
   * picture and the layer's element is busy showing the one before it, is decoded into these ahead
   * of its cut; see [PreviewPlayer.syncFollower].
   */
  pictures?: PreviewPictures;
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

  constructor(readonly video: ClipMedia) {}
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
  /** The component's own elements for the music and the voiceover. */
  private readonly ownAudio: Readonly<Record<'music' | 'voice', HTMLAudioElement>>;
  /**
   * The elements the music and the voiceover are on now: the component's own, unless one of those
   * is in [mixer]'s graph and its file is one the graph cannot play - see [PreviewMixer.elementFor].
   */
  private musicEl: HTMLAudioElement;
  private voiceEl: HTMLAudioElement;
  /**
   * Two elements per audio lane: one plays the clip heard now while the other holds the next clip's
   * file open, so a clip that follows straight on starts warm. With one, every join between two
   * files was a cold load, and the A13 lost the first 300 ms of the second sound to it.
   */
  private readonly audioLanes = new Map<string, readonly [LaneSlot, LaneSlot]>();
  private readonly makeAudio: () => HTMLAudioElement;
  /** How the music and the voiceover are heard at their levels where the WebView ignores `volume`. */
  private readonly mixer: PreviewMixer;
  private readonly onSwap: (() => void) | undefined;
  private readonly pictures: PreviewPictures | null;

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
  /** When this player last changed the clock's rate; see [RATE_FLUSH_MS]. */
  private rateSetAt = Number.NEGATIVE_INFINITY;
  /**
   * The clock's position as the frame loop last read it, and when it was last seen to change: what
   * says the picture is actually moving. See [watchClock].
   */
  private clockSec = Number.NaN;
  private clockMovedAt = Number.NEGATIVE_INFINITY;

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
  /** The music's speed as [setSource] last put it on [musicEl]; the takes are always at 1x. */
  private musicRate = 1;
  private voiceUri: string | null = null;
  /** Audio elements started or seeked and not yet checked: where they were put (ms), and how often. */
  private readonly settling = new Map<HTMLAudioElement, { kind: AudioPut; putAtMs: number; leadMs: number; wallMs: number; learn: boolean }>();
  /** How long each element's clock stands still after a start and after a seek, as last measured. */
  private readonly audioLeadMs = new Map<HTMLAudioElement, Partial<Record<AudioPut, number>>>();
  /**
   * The same once the element is routed through [mixer], which it is for good: a stall learned before
   * that is not the stall it has now; see [SLOW_SEEK_SETTLE_MS] and [DEFAULT_ROUTED_LEAD_MS].
   */
  private readonly routedLeadMs = new Map<HTMLAudioElement, Partial<Record<AudioPut, number>>>();
  /**
   * The longest each audio element has said its file is since its source was set, and when it was
   * last loaded again because that had collapsed; see [recoverLength].
   */
  private readonly audioLengths = new Map<HTMLAudioElement, { longestMs: number; reloadedAt: number }>();
  /** Where the preview last put each audio element in its file, in ms; see [recoverLength]. */
  private readonly audioPutAtMs = new Map<HTMLAudioElement, number>();
  /** Audio elements seen still playing at the end of their file, and since when; see [waitForEnd]. */
  private readonly audioAtEnd = new Map<HTMLAudioElement, number>();
  /**
   * Audio elements seen playing the last of their sound during this play - coming up to its out point,
   * or the end of its file, with nothing after it - and not put anywhere since; see [playedOut].
   */
  private readonly audioFinishing = new Set<HTMLAudioElement>();
  /** Base elements started from a standing frame and not yet measured; see [DEFAULT_VIDEO_LEAD_MS]. */
  private readonly starts = new Map<ClipMedia, { putAtMs: number; wallMs: number; rate: number }>();
  /** How long each base element's clock stands still after `play()`, as last measured. */
  private readonly videoLeadMs = new Map<ClipMedia, number>();

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
    this.ownAudio = { music: media.music, voice: media.voice };
    this.musicEl = media.music;
    this.voiceEl = media.voice;
    this.mixer = new PreviewMixer([media.music, media.voice]);
    this.makeAudio = media.makeAudio ?? (() => document.createElement('audio'));
    this.onSwap = media.onSwap;
    this.pictures = media.pictures ?? null;

    for (const deck of this.decks) this.listenTo(deck);
    // A picker, a phone call or the home button takes the page away, and the paused elements'
    // pictures with it; see [onPageShown] and [revive].
    this.unlisten.push(onPageShown(() => this.revive()));
  }

  /** The clock's element, whose events are the transport's. */
  private get video(): ClipMedia {
    return this.active.video;
  }

  private get spare(): BaseDeck {
    return this.decks[0] === this.active ? this.decks[1] : this.decks[0];
  }

  /**
   * The base element showing the clip under the playhead: the one whose picture's shape the crop
   * tool measures against.
   */
  get baseVideo(): ClipMedia {
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
    // Sound that had played out ahead of where the playhead was is heard again from where it is now,
    // however near its end that is; see [playedOut].
    this.audioFinishing.clear();
    if (this.pendingLoad || this.seekInFlight) {
      this.queuedMs = target;
      return;
    }
    this.goTo(target, this.isPlaying());
  }

  play(): void {
    const total = this.store.totalMs.value;
    if (!this.store.slots.value.length || total <= 0) return;
    // Before anything is started, and whatever is still loading: this is the tap.
    this.ensureAudioLanes();
    this.startMixer();
    // Decided before the busy cases below. A scrub or fling that has just landed on the end is
    // usually still loading or seeking there, and playing on from where the element is going
    // would play nothing and stop at the end again - Play looked dead.
    const restart = this.store.playheadMs.value >= total - RESTART_WITHIN_MS;
    // From the top, a sound that had played out is heard again, however short it is; see [playedOut].
    if (restart) this.audioFinishing.clear();
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
    // First, so the audio session is the app's again before whoever paused goes on to use it: the
    // voiceover sheet pauses and then opens the microphone. See [PreviewMixer].
    this.mixer.stop();
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
      atMs: at,
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
   * The output instant the preview is showing, for everything that moves with time but is not the
   * base track's own picture - the zoom camera, in particular. Inside the base track it is the very
   * reading [baseShot] takes; in the tail past it, where there is no base shot, it is the tail's
   * wall clock. Never the playhead signal while playing: that is written every 33 ms, and a camera
   * read off it would move in visible 30 Hz steps against 60 fps video.
   */
  instantMs(): number {
    if (this.destroyed) return this.store.playheadMs.value;
    return this.tail ? this.tailMs() : this.clockMs();
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
  private presentable(deck: BaseDeck | null, clipKey: string): ClipMedia | null {
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
      applyPitch(this.video, slot.clip, clipsSilenced(this.store));
      this.setClockRate(slot.clip.speed || 1);
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
    if (slot) {
      // Heard or not decides pitch correction too; see [applyPitch].
      applyPitch(this.video, slot.clip, clipsSilenced(this.store));
      this.applyVideoAudio(slot.clip);
    }
    this.ensureAudioLanes();
    if (this.isPlaying()) this.startMixer();
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
   * A source's preview copy has landed - or been given up on - since its elements were pointed at
   * it: see [EditorStore.previewUrls]. Every element holding that source is loaded again, onto what
   * [previewSrc] names now, from exactly where the playhead is, playing if it was playing.
   *
   * The copy is the same footage on the same timeline, so nothing about the edit moves; what changes
   * is that every seek after this lands at once instead of decoding seconds of full-size footage. The
   * load itself costs one short hold, the same as any source change, over the last frame the canvas
   * drew. Elements whose source has not changed are left alone, which is every element on most calls.
   */
  refreshSources(): void {
    if (this.destroyed) return;
    // Never under a voiceover take: its sound is being laid against this clock, and a reload would
    // stand the clock still under the customer's voice. The component asks again once the take ends.
    if (this.store.recordingFromMs.peek() !== null) return;
    let stale = false;
    for (const deck of this.decks) {
      if (!deck.key || this.store.isPictureKey(deck.key)) continue;
      const source = this.store.clipByKey(deck.key);
      if (!source || sameUrl(deck.video.src, previewSrc(this.store, source))) continue;
      // Forgotten, as [revive] forgets a source: `goTo` and `hold` then load it afresh.
      deck.key = null;
      deck.hasMeta = false;
      deck.failed = false;
      stale = true;
    }
    for (const follower of this.followers.values()) follower.refreshSource();
    if (!stale) return;
    // Through `seek`, which waits out a load or a seek already in flight rather than cutting it off.
    this.seek(this.store.playheadMs.value);
  }

  /**
   * The element could not play `key`'s preview copy: the copy is forgotten, so the source plays itself
   * from now on (see [EditorStore.dropPreviewUrl]). True when that is what happened - false for a
   * source that was playing itself already, whose failure is a real one.
   *
   * Also true for an element still on a copy the OTHER element has already given up on: both base
   * elements hold the same copy whenever a template cuts one clip twice in a row, and the second to
   * fail finds the copy gone from the store. Its failure is the same one, and the answer the same -
   * load what the source plays now.
   */
  private dropFailedCopy(key: string | null, video: ClipMedia): boolean {
    if (!key || this.store.isPictureKey(key)) return false;
    return this.store.dropPreviewUrl(key, video.src) || this.store.isDroppedPreviewUrl(key, video.src);
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
    this.mixer.release();
    // Both base elements are stripped, the spare too: it holds a decoder whatever it is doing.
    for (const el of [...this.decks.map(deck => deck.video), this.musicEl, this.voiceEl, ...this.laneElements()]) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    this.audioLanes.clear();
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
    this.stillClock();
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
        // A preview copy this WebView would not play: the clip plays itself instead, from wherever
        // this load was going.
        if (this.dropFailedCopy(clip.key, video)) {
          debugWarn('[ve-preview] preview copy could not be loaded; playing the clip itself', clip.key, video.error);
          deck.key = null;
          this.goTo(queued ?? ms, this.autoplay);
          return;
        }
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

  /**
   * Points one base element at a source, from nothing: whatever it had loaded is gone with this.
   *
   * A picture puts the slot's picture in the element's place first (see [ClipMedia]), which is the
   * only thing about a picture this player ever has to know: from here on it is seeked, started,
   * swapped and read like any clip.
   */
  private point(deck: BaseDeck, source: EditorSource, sourceMs: number): void {
    this.clearPut(deck);
    this.starts.delete(deck.video);
    deck.key = source.key;
    deck.hasMeta = false;
    deck.failed = false;
    deck.video.showPicture(this.store.isPictureKey(source.key));
    // The poster first, for where the element is going; see [FollowerVideo.load].
    this.setPoster(deck, source, sourceMs);
    deck.video.src = previewSrc(this.store, source);
    deck.video.load();
  }

  private applyAt(slot: TimelineSlot, ms: number, autoplay: boolean, forceSeek: boolean): void {
    const video = this.video;
    // Pitch correction before the rate, and read back each time: some WebViews reset it on every
    // source change. See [applyPitch].
    applyPitch(video, slot.clip, clipsSilenced(this.store));
    this.setClockRate(slot.clip.speed || 1);
    this.applyVideoAudio(slot.clip, ms);

    const sourceSec = sourceMsAt(slot, ms) / 1000;
    const tolerance = autoplay && !video.paused && !forceSeek ? (PLAYING_SEEK_TOLERANCE_MS * (slot.clip.speed || 1)) / 1000 : SEEK_EPSILON_S;
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
    this.stillClock();
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
    // Past the steps of a ramp to the boundary that needs the spare; see [boundaryAfterSplits].
    const ahead = index >= 0 ? boundaryAfterSplits(slots, index) : -1;
    const next = ahead > 0 ? slots[ahead] : undefined;
    if (!next || !preloadDue(ms, next)) return;
    this.primeNext(next);
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
    // By the clip it holds, not by whether it is heard yet: a spare started muted for a clip that
    // will be heard is already right when it becomes the clock, with no change on a playing element.
    applyPitch(video, clip, clipsSilenced(this.store));
    if (video.playbackRate !== speed) video.playbackRate = speed;
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
    // The clock's own LOADS have a handler of their own, which also reports it - and falls back from
    // a preview copy the same way this does. A copy that fails the clock once it is past its load -
    // a decode error part way in - is this handler's, or the clock would wait on it for good.
    const clockLoading = deck === this.active && this.pendingLoad;
    if (!clockLoading && !this.destroyed && this.dropFailedCopy(deck.key, deck.video)) {
      debugWarn('[ve-preview] preview copy could not be loaded; playing the clip itself', deck.key, deck.video.error);
      deck.key = null;
      deck.failed = false;
      // Put back where the playhead wants it, on the clip itself this time.
      this.seek(this.store.playheadMs.value);
      return;
    }
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
   * little off its own; see [easedTailRate] - and stopped on its own out point rather than let run on
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
    const rate = speed * easedTailRate(behindMs, video.playbackRate / speed);
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
  private startVideo(video: ClipMedia): void {
    if (!video.paused) return;
    // The clock, from a standstill: it has to be seen moving before the sound goes with it.
    if (video === this.video) this.stillClock();
    // A picture starts the instant it is asked to, so there is no stall to measure - and one
    // measured as zero would teach this slot's NEXT video to start late.
    if (!video.isPicture && video.readyState >= HAVE_FUTURE_DATA && !video.seeking) {
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
  private leadFor(video: ClipMedia): number {
    // No stall, so no early start: a picture started ahead of its cut would reach the cut already
    // that far into its segment, and end that much early.
    if (video.isPicture) return 0;
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
    if (this.destroyed) return;
    this.watchClock();
    if (!this.clockMoving()) this.holdSound();
    // While a new source is loading, the element still reports the OLD source's position. Acting on
    // it would compare the previous clip's time against the next clip's trim - and skip the next
    // clip outright whenever it is trimmed shorter.
    if (this.pendingLoad || this.seekInFlight) {
      // The clock has stopped: the base is between sources, or settling on a frame it was seeked
      // to. A second layer that ran on through that would come back a load's worth ahead and be
      // yanked back into place, so it waits with the base rather than drifting past it - and so
      // does a transition's tail, for the same reason. The sound is held above once the clock has
      // stood still for long enough to be a stall; see [holdSound].
      for (const follower of this.followers.values()) follower.pause();
      const spare = this.spare;
      if (spare.role === 'tail' && !spare.video.paused) spare.video.pause();
      return;
    }
    this.learnStarts();
    const slots = this.store.slots.value;
    const index = slots.findIndex(slot => slot.clip.id === this.segmentId);
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
      // A step of a ramp: the boundary that needs the spare is past the last step; see [primeAhead].
      this.primeAhead(slots, index, at);
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
      // Not a trim that moved while this player has just changed the clock's rate: that is WebKit's
      // flush back to a keyframe (see [RATE_FLUSH_MS]), and it is waited out rather than seeked.
      if (performance.now() - this.rateSetAt < RATE_FLUSH_MS) return;
      this.goTo(slot.startMs, true);
      return;
    }
    this.writePlayhead(false);
  }

  /**
   * Readies the spare for the cut or transition after the ramp the clock is in, exactly as the frame
   * loop readies it for one straight after the clock's own segment: put on the incoming clip in good
   * time, and started a start stall early. The steps of a ramp all play on the one element, so the
   * spare is free for the whole of it; see [boundaryAfterSplits].
   */
  private primeAhead(slots: readonly TimelineSlot[], index: number, at: number): void {
    const ahead = boundaryAfterSplits(slots, index);
    const next = ahead > 0 ? slots[ahead] : undefined;
    if (!next) return;
    if (preloadDue(at, next)) this.primeNext(next);
    const spare = this.spare;
    if (this.spareReadyFor(next) && spare.video.paused && prerollDue(at, next, this.leadFor(spare.video))) this.preroll(spare);
  }

  /** Sets the clock's rate, and remembers when it did; see [RATE_FLUSH_MS]. */
  private setClockRate(rate: number): void {
    if (this.video.playbackRate === rate) return;
    this.video.playbackRate = rate;
    this.rateSetAt = performance.now();
  }

  /**
   * Notes whether the clock's position has moved since the last frame. Its first reading after
   * [stillClock] is where it was put, and not a move.
   */
  private watchClock(now: number = performance.now()): void {
    const sec = this.video.currentTime;
    if (sec === this.clockSec) return;
    if (!Number.isNaN(this.clockSec)) this.clockMovedAt = now;
    this.clockSec = sec;
  }

  /**
   * The clock is being started, seeked or loaded: it has [CLOCK_STILL_MS] from now to be seen moving
   * before the sound is held for it. Counted from now rather than from its last move, so a start
   * still starts the music with it - inside the tap, which is where a browser lets sound start - and
   * only a start that then does not move is waited for.
   */
  private stillClock(): void {
    this.clockSec = Number.NaN;
    this.clockMovedAt = performance.now();
  }

  /**
   * Whether the picture is actually moving: the clock's position has changed within [CLOCK_STILL_MS].
   * The tail runs on the wall clock, which is always moving.
   */
  private clockMoving(now: number = performance.now()): boolean {
    return this.tail !== null || now - this.clockMovedAt < CLOCK_STILL_MS;
  }

  /**
   * Pauses the music and the voiceover through a stall of the clock, to be started again - with their
   * lead, see [putAudio] - by the frame loop once the picture moves.
   *
   * They used to run on through it. The playhead is read off the clock, so a stalled clock left the
   * sound running ahead of it, and the frame loop then seeked it BACK by however long the stall had
   * been: the same stretch of music heard twice at every stall, and over and over through a long one -
   * on the iOS simulator the music was put back to one spot eight times in four seconds while a
   * slowed clip stood still. A pause that ends when the picture moves is a gap instead of a repeat.
   *
   * What was being measured about them is dropped too: a stall inside the measurement is the
   * clock's, not theirs, and learned as theirs it would put every later start in the wrong place.
   */
  private holdSound(): void {
    for (const el of [this.musicEl, this.voiceEl, ...this.laneElements()]) {
      this.settling.delete(el);
      if (!el.paused) el.pause();
    }
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
      // The post is over, which lets go of the sound mixer as a pause does; see [PreviewMixer].
      this.mixer.stop();
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
    const index = this.store.slots.value.findIndex(slot => slot.clip.id === this.segmentId);
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
      // The post is over, which lets go of the sound mixer as a pause does; see [PreviewMixer].
      this.mixer.stop();
      this.store.playheadMs.value = this.store.totalMs.value;
      this.readPlayState();
      return;
    }
    const kind = current ? boundaryKind(current, next) : 'cut';
    if (kind === 'split' && next.clip.clipKey === this.active.key && !this.video.ended) {
      // Two halves of a split: the element is already exactly where the next segment begins.
      this.segmentId = next.clip.id;
      applyPitch(this.video, next.clip, clipsSilenced(this.store));
      this.setClockRate(next.clip.speed || 1);
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
   * the tail not at all. The music and the voiceover are heard at their levels there all the same,
   * through [PreviewMixer]; a clip's own sound is not put through it, for the reason written there.
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
    this.ensureAudioLanes();

    const music = manifest.music;
    this.setSource('music', music?.uri ?? null, music ? musicSpeed(music) : 1);
    // Sound that is about to be due is started NOW, a stall before it is needed: the position it is
    // put at is still counted from the playhead, so what comes out starts exactly on time - and the
    // first moment of a track or a take is heard rather than swallowed by the output starting up.
    if (music) this.syncMusicClip(music, this.musicEl, ms, total, live, running);
    else if (!this.musicEl.paused) this.musicEl.pause();

    for (const track of manifest.audioTracks ?? []) {
      const lane = this.audioLanes.get(track.id);
      // The halves of a cut as the one sound they still are, which one element plays straight on
      // through: two would hand over at the cut, and no lead puts that on the sample.
      if (lane) this.syncLane(joinContinuousAudio(track.clips), lane, ms, total, live, running);
    }

    const voiceLead = live ? this.leadWindow(this.voiceEl) : 0;
    const take = live ? manifest.voiceovers.find(t => ms >= t.startMs - voiceLead && ms < t.startMs + t.durationMs) : undefined;
    if (take) {
      this.setSource('voice', take.uri);
      this.playAt(this.voiceEl, ms - take.startMs, clamp(take.volume, 0, 1), running, takeSpan(take, ms));
    } else if (!this.voiceEl.paused) {
      this.voiceEl.pause();
    }
  }

  /**
   * One audio lane at `ms`. The clip heard now, or failing that the next one along, is on one of its
   * elements - its file open through the gap before it, as the music's element always has its file -
   * and the clip after that is loaded on the other. Each goes through [syncMusicClip], which holds a
   * clip that is not due yet and starts one a stall before it is due; a lane's clips never overlap,
   * so the two take turns, and neither ever has to cut the other off.
   */
  private syncLane(clips: readonly EditAudioClip[], lane: readonly [LaneSlot, LaneSlot], ms: number, total: number, live: boolean, running: boolean): void {
    const audible = (clip: EditAudioClip): boolean => {
      const window = musicWindow(clip, total);
      return window.endMs > window.startMs;
    };
    // Sorted by start: the first one heard now or still to come.
    const at = clips.findIndex(clip => musicSourceMsAt(clip, ms, total) !== null || (audible(clip) && musicWindow(clip, total).startMs > ms));
    const due = at >= 0 ? clips[at] : undefined;
    const after = due ? clips.slice(at + 1).find(audible) : undefined;
    // An element keeps the clip it holds: the one readied for the next clip takes over at the join
    // with its file already open, and the other is then free for the clip after that.
    const playing = (due && lane.find(slot => slot.clipId === due.id)) || lane.find(slot => !after || slot.clipId !== after.id) || lane[0];
    const spare = playing === lane[0] ? lane[1] : lane[0];
    this.setLaneSource(playing, due);
    this.setLaneSource(spare, after);
    if (due) this.syncMusicClip(due, playing.element, ms, total, live, running);
    else if (!playing.element.paused) playing.element.pause();
    // The clip after it is started a stall early on its own element, from its beginning, as the music
    // is: it is first heard on time instead of being put a lead's worth into itself at the join, and
    // the clip before it plays on to its end untouched on the other element.
    if (after) this.syncMusicClip(after, spare.element, ms, total, live, running);
    else if (!spare.element.paused) spare.element.pause();
  }

  /**
   * The same trim, phase, loop, speed, level and fades for legacy music and every lane clip. A sound
   * not due yet is put that far before its first moment in the FILE - the time to go, at its speed.
   */
  private syncMusicClip(music: EditMusic, el: HTMLAudioElement, ms: number, total: number, live: boolean, running: boolean): void {
    const heard = musicWindow(music, total);
    const lead = live ? this.leadWindow(el) : 0;
    const at =
      heard && live
        ? (musicSourceMsAt(music, ms, total) ??
          (ms < heard.startMs && heard.startMs - ms <= lead ? music.inMs + musicPhaseMs(music) + (ms - heard.startMs) * musicSpeed(music) : null))
        : null;
    if (heard && at !== null) {
      this.playAt(el, at, clamp(music.volume, 0, 1) * musicFadeAt(music, ms, total), running, musicSpan(music, heard.endMs - ms));
    } else if (!el.paused) {
      el.pause();
    }
  }

  /**
   * Keeps one audio element where the playhead wants it: `positionMs` into its file, at `volume`, on
   * the stretch of the file `span` says is heard, at the span's rate.
   *
   * Positions here are in the FILE and every allowance - a stall, a drift - is WALL time, which at a
   * rate other than 1x covers that many times as much of the file: an allowance is multiplied by
   * `span.rate` before it meets a position, and a distance between two positions divided by it before
   * it is weighed as one. At 1x both are the numbers this has always used.
   *
   * @param running see [syncAudio].
   */
  private playAt(el: HTMLAudioElement, positionMs: number, volume: number, running: boolean, span: SoundSpan): void {
    this.mixer.setLevel(el, volume);
    // Before anything below starts it, so it never starts at the speed it had for another sound.
    applySoundRate(el, span.rate);
    // Sound goes with a picture that is MOVING. Left to run through a clock that stood still, it ran
    // ahead of the picture by the length of the stall and was seeked back as soon as the picture
    // moved - a second of music heard twice on the first play of a template on the iOS simulator. The
    // frame loop starts it again on the first frame the clock is seen moving; see [holdSound].
    if (!this.clockMoving()) {
      if (!el.paused) el.pause();
      this.settling.delete(el);
      return;
    }
    const guardMs = audioEndGuardMs();
    const length = this.recoverLength(el, span, guardMs);
    if (length === 'held') {
      if (!el.paused) el.pause();
      this.settling.delete(el);
      return;
    }
    const reloaded = length === 'loaded';
    if (el.paused) {
      // Stopped at the end of the last of the sound, a little ahead of the playhead - by the preview
      // at the out point, or by the element itself at the end of its file - it has played everything
      // it is going to, and is left there; see [playedOut]. Only one seen playing up to it as the post
      // played on: a seek back to just short of the end forgets that, and it is heard again from there.
      if (this.audioFinishing.has(el)) {
        if (playedOut(el.currentTime * 1000, positionMs, span, fileEndMs(el), guardMs, (this.maxLeadMs(el) + this.driftAllowedMs(el)) * span.rate)) return;
        this.audioFinishing.delete(el);
      }
      // Not measured after a reload: the load is in the stall, and no lead makes up for that.
      if (this.putAudio(el, positionMs, running ? 'warm' : 'cold', span, !reloaded)) startPlayback(el);
      return;
    }
    if (this.waitForEnd(el, guardMs)) return;
    const atMs = el.currentTime * 1000;
    // Coming up to its out point, or to the end of its file where that is sooner, or a little past an
    // out point it was not seen coming up to in time: a repeating section is sent round to its next
    // pass now, its seek stall early (see [LOOP_WRAP_EARLY_MS]), and one with nothing after it stops
    // at the out point rather than play what the post does not use. Further past the out point than
    // [AUDIO_DRIFT_MS] it is somewhere else in the file, and put back below like any drift.
    const seekLeadMs = this.leadsFor(el).seek ?? this.fallbackLeadMs(el, 'seek');
    const endMs = Math.min(span.outMs, fileEndMs(el));
    const zoneMs = this.wrapZoneMs(el, span, guardMs);
    if (atMs >= span.inMs && endMs - atMs <= zoneMs && atMs - endMs <= AUDIO_DRIFT_MS * span.rate) {
      if (passFollows(atMs, positionMs, span)) {
        this.wrapAudio(el, atMs, positionMs, span, seekLeadMs, zoneMs, running);
        return;
      }
      this.audioFinishing.add(el);
      if (atMs >= span.outMs) {
        el.pause();
        this.settling.delete(el);
        return;
      }
    }
    // How far it is from where it should be - round the loop, at a seam; see [soundOffsetMs] - in the
    // wall time it would take to catch up, which is what a drift and a lead are both measured in.
    const offsetMs = soundOffsetMs(atMs, positionMs, span) / span.rate;
    // Slow to seek - on WebKit, or played through the mixer - its stall is judged over
    // [SLOW_SEEK_SETTLE_MS] and allowed [SLOW_SEEK_DRIFT_MS]; Chromium's exactly as it always was.
    const slow = this.slowToSeek(el);
    const maxLeadMs = this.maxLeadMs(el);
    const driftMs = this.driftAllowedMs(el);
    const settling = this.settling.get(el);
    if (settling) {
      const sinceMs = performance.now() - settling.wallMs;
      if (sinceMs > (slow ? SLOW_SEEK_SETTLE_TIMEOUT_MS : AUDIO_SETTLE_TIMEOUT_MS)) {
        this.settling.delete(el);
      } else if (soundOffsetMs(atMs, settling.putAtMs, span) < AUDIO_SETTLED_MS * span.rate || (slow && sinceMs < SLOW_SEEK_SETTLE_MS)) {
        // Inside the stall the element is expected to be off by up to its lead; only something
        // further out than that is a drift to correct now. A slow-to-seek element is inside it for
        // the whole of [SLOW_SEEK_SETTLE_MS], however far its clock has got: it moves before it
        // stands still.
        if (Math.abs(offsetMs) <= maxLeadMs + driftMs) return;
      } else {
        this.settling.delete(el);
        // Measured only against a video that is running steadily itself.
        const behindMs = -offsetMs;
        if (running && settling.learn && Math.abs(behindMs) <= maxLeadMs) {
          const leadMs = clamp(settling.leadMs + behindMs, 0, maxLeadMs);
          this.leadsFor(el)[settling.kind] = leadMs;
          if (this.mixer.isRouted(el)) lastRoutedLeadMs = leadMs;
          else if (audioSlowToSeekOnItsOwn()) lastSlowSeekLeadsMs[settling.kind] = leadMs;
          else lastAudioLeadMs = leadMs;
        }
      }
    }
    if (Math.abs(offsetMs) > driftMs) {
      if (this.seekInFlight || this.pendingLoad) {
        // The video is seeking or loading as well, and will stand still for about as long as the
        // audio does: put exactly, and not measured - its stall would be learned as the audio's. A
        // slow-to-seek element is not judged again until its own stall is over, all the same: judged
        // inside it, it is put again for a drift that is only the stall; see [SLOW_SEEK_SETTLE_MS].
        el.currentTime = positionMs / 1000;
        this.notePut(el, positionMs);
        if (slow) this.settling.set(el, { kind: 'seek', putAtMs: positionMs, leadMs: 0, wallMs: performance.now(), learn: false });
        else this.settling.delete(el);
      } else if (!this.putAudio(el, positionMs, 'seek', span, running)) {
        // The clock is running - a cut taken over from the spare, an edit that moved the sound -
        // so the audio's own seek stall is all there is to lead: put with it, and only measured
        // when the frame loop is the one asking. Where less is left of the sound than that stall
        // there is nothing to put it on, and it stops; where that would put it on the last moment
        // of a pass that another follows, it stops until the playhead is near enough the seam for
        // it to go round exactly (see [soundPutMs]), and is started again from paused.
        el.pause();
        this.settling.delete(el);
      }
    }
  }

  /**
   * Seeks an audio element to `positionMs` plus the stall it is about to have - on the next pass when
   * that carries a repeating section past its out point - and, unless `learn` is false, measures that
   * stall once past it. False, and the element left where it was, when that is past the end of
   * everything that is heard, or on the last moment of a pass another follows; see [soundPutMs].
   */
  private putAudio(el: HTMLAudioElement, positionMs: number, kind: AudioPut, span: SoundSpan, learn = true): boolean {
    const leadMs = this.leadsFor(el)[kind] ?? this.fallbackLeadMs(el, kind);
    const guardMs = audioEndGuardMs();
    // A negative position is sound that is not due yet (see [syncAudio]); it starts at its beginning.
    // The stall is wall time, and the file goes by at the span's rate through it.
    const putAtMs = soundPutMs(positionMs, leadMs * span.rate, span, fileEndMs(el), guardMs, this.wrapZoneMs(el, span, guardMs));
    if (putAtMs === null) return false;
    this.seekAudio(el, putAtMs, kind, leadMs, learn);
    return true;
  }

  /**
   * Puts `el` at `putAtMs` and starts measuring the stall that costs. Not moved at all when it is
   * already within [SEEK_EPSILON_S] of there - never the case for an element that has ended, at the
   * end of its file, because nothing is put that close to the end (see [soundPutMs]): left there,
   * `play()` would take it back to the start of the file.
   */
  private seekAudio(el: HTMLAudioElement, putAtMs: number, kind: AudioPut, leadMs: number, learn: boolean): void {
    if (Math.abs(el.currentTime * 1000 - putAtMs) > SEEK_EPSILON_S * 1000) el.currentTime = putAtMs / 1000;
    this.notePut(el, putAtMs);
    this.settling.set(el, { kind, putAtMs, leadMs, wallMs: performance.now(), learn });
  }

  /**
   * Remembers where `el` was put - the length WebKit takes when it cuts a file short (see
   * [recoverLength]) - and that it has something to play again; see [audioFinishing].
   */
  private notePut(el: HTMLAudioElement, putAtMs: number): void {
    this.audioPutAtMs.set(el, putAtMs);
    this.audioFinishing.delete(el);
  }

  /**
   * How long before the end of the pass it is on - its out point, or the end of its file where that
   * is sooner - a playing element is sent round to the next pass: its seek stall, and never less than
   * the checks need to see it there in time; see [LOOP_WRAP_EARLY_MS]. A section so short that this
   * would be most of it is sent round from halfway, so each pass is heard at all.
   *
   * In the FILE's milliseconds, as the positions it is measured from are: the stall and the checks'
   * spacing are wall time, and cover the span's rate times as much of the file. The end guard is a
   * place in the file already.
   */
  private wrapZoneMs(el: HTMLAudioElement, span: SoundSpan, guardMs: number): number {
    const seekLeadMs = this.leadsFor(el).seek ?? this.fallbackLeadMs(el, 'seek');
    return Math.min(Math.max(seekLeadMs * span.rate, guardMs + LOOP_WRAP_EARLY_MS * span.rate), passMs(span) / 2 || Infinity);
  }

  /**
   * Sends a playing element on to its section's next pass, its seek stall ahead of the seam; see
   * [LOOP_WRAP_EARLY_MS]. Put where the playhead will be once the stall is over, and measured like
   * any seek - unless that is before the in point, when it is put on the in point instead (see
   * [wrapAimMs]), and what it is measured against is not where it was put.
   *
   * Aimed at the stretch at the end of that pass where it would be sent round again (`zoneMs`) - only
   * on a section not much longer than the stall, where which pass the playhead is on is anybody's
   * guess - it would come out of this stall straight into the next one, a put 50 ms after a put. It is
   * sent on round to the in point at once instead.
   */
  private wrapAudio(el: HTMLAudioElement, atMs: number, positionMs: number, span: SoundSpan, leadMs: number, zoneMs: number, running: boolean): void {
    // The stall is wall time; the aim is a place in the file, which goes by at the span's rate.
    let aimMs = wrapAimMs(atMs, positionMs, leadMs * span.rate, span);
    if (aimMs >= Math.min(span.outMs, fileEndMs(el)) - zoneMs) aimMs -= passMs(span);
    this.seekAudio(el, Math.max(span.inMs, aimMs), 'seek', leadMs, running && aimMs >= span.inMs);
  }

  /**
   * Whether a playing `el` is at the end of its file, and so is to be left alone for now; see
   * [AUDIO_END_GUARD_MS]. It says it has ended within a few tens of milliseconds, and is put from
   * there like any paused element. One still reported playing after [AUDIO_END_WAIT_MS] is paused
   * here instead, which comes to the same: by then no notice can still be on its way.
   */
  private waitForEnd(el: HTMLAudioElement, guardMs: number): boolean {
    if (!atFileEnd(el, guardMs)) {
      this.audioAtEnd.delete(el);
      return false;
    }
    const now = performance.now();
    const since = this.audioAtEnd.get(el);
    if (since === undefined) {
      this.audioAtEnd.set(el, now);
    } else if (now - since > AUDIO_END_WAIT_MS) {
      this.audioAtEnd.delete(el);
      el.pause();
      this.settling.delete(el);
    }
    return true;
  }

  /**
   * Loads `el`'s file again when WebKit has cut its length short under it: 'loaded' when it has just
   * done so, 'held' when it is cut short but was loaded again too recently to be loaded once more yet,
   * and null for a file that is as long as it was.
   *
   * That is what a seek landing between the end of the file and WebKit's notice of it does (see
   * [AUDIO_END_GUARD_MS]): the file's length becomes wherever the seek put the element. Nothing the
   * preview does now puts it there, but an element it happens to anyway is lost for the rest of the
   * play without this - it ends the moment it starts, every time, and the drift correction seeks it
   * on every frame. Only a new load forgets the length the old one settled on.
   *
   * Told by all four at once: the element sits at the end of a file it said was more than
   * [COLLAPSED_BY_MS] longer before, which is that much shorter than the stretch of it the post plays,
   * and which now ends where the preview last put the element ([COLLAPSED_AT_PUT_MS]). A length that
   * comes down while the element is somewhere else in the file - a length that was estimated at first,
   * and has been read properly since - is not it; nor is one that comes down to where the file really
   * ends, as WebKit's own correction of an estimate does once the element plays up to it, which has
   * nothing to do with any put and would otherwise be loaded again at every seam.
   *
   * Not loaded more often than [RELOAD_RETRY_MS], so a file that truly is shorter than the post thinks
   * cannot keep it loading. In between it is held, paused where it is - which keeps all four true for
   * when it may be loaded again. Started, all it could play is the little the file now says it has,
   * over and over, and the drift correction would put it back to the start of that every few frames:
   * the preview's own stutter in place of the silence it waits in, and a put that no longer says where
   * the file was cut.
   */
  private recoverLength(el: HTMLAudioElement, span: SoundSpan, guardMs: number): 'loaded' | 'held' | null {
    const lengthMs = fileEndMs(el);
    if (!Number.isFinite(lengthMs)) return null;
    let known = this.audioLengths.get(el);
    if (!known) {
      known = { longestMs: lengthMs, reloadedAt: Number.NEGATIVE_INFINITY };
      this.audioLengths.set(el, known);
    }
    if (lengthMs > known.longestMs) known.longestMs = lengthMs;
    const putAtMs = this.audioPutAtMs.get(el);
    const collapsed =
      lengthMs + COLLAPSED_BY_MS < known.longestMs &&
      lengthMs + COLLAPSED_BY_MS < span.outMs &&
      putAtMs !== undefined &&
      Math.abs(lengthMs - putAtMs) < COLLAPSED_AT_PUT_MS &&
      atFileEnd(el, guardMs);
    if (!collapsed) return null;
    const now = performance.now();
    if (now - known.reloadedAt < RELOAD_RETRY_MS) return 'held';
    known.reloadedAt = now;
    debugWarn('[ve-preview] a sound file came back shorter than it is; loading it again', { was: known.longestMs, now: lengthMs });
    const src = el.src;
    el.pause();
    this.settling.delete(el);
    this.audioAtEnd.delete(el);
    this.audioPutAtMs.delete(el);
    this.audioFinishing.delete(el);
    // Emptied first, so the load after it starts from nothing rather than from the player it had.
    el.removeAttribute('src');
    el.load();
    if (src) el.src = src;
    el.load();
    return 'loaded';
  }

  /** How early sound has to start on this element for it to be heard on time - its longest known stall. */
  private leadWindow(el: HTMLAudioElement): number {
    const leads = this.leadsFor(el);
    return leads.warm ?? leads.cold ?? this.fallbackLeadMs(el, 'warm');
  }

  /** The stalls learned for `el` as it plays now: routed through the mixer or not; see [routedLeadMs]. */
  private leadsFor(el: HTMLAudioElement): Partial<Record<AudioPut, number>> {
    const table = this.mixer.isRouted(el) ? this.routedLeadMs : this.audioLeadMs;
    let leads = table.get(el);
    if (!leads) {
      leads = {};
      table.set(el, leads);
    }
    return leads;
  }

  /**
   * The lead for a put of `el` of this `kind` that nothing has been learned for yet on `el`: the last
   * one learned on this phone for an element that stalls as `el` does, or its default until then; see
   * [DEFAULT_AUDIO_LEAD_MS], [DEFAULT_ROUTED_LEAD_MS] and [DEFAULT_SLOW_SEEK_LEADS_MS]. Only for an
   * element that is slow to seek on its own - a Mac's - does `kind` choose it, because only there is a
   * seek known to cost far more than a start; everywhere else it is the last lead learned, of whatever
   * kind, as it always was.
   */
  private fallbackLeadMs(el: HTMLAudioElement, kind: AudioPut): number {
    if (this.mixer.isRouted(el)) return lastRoutedLeadMs;
    return audioSlowToSeekOnItsOwn() ? lastSlowSeekLeadsMs[kind] : lastAudioLeadMs;
  }

  /**
   * Whether `el`'s clock loses a long and uneven stretch over the second after every start and seek,
   * and so is judged over [SLOW_SEEK_SETTLE_MS]: Safari's on a Mac, every one of them
   * ([audioSlowToSeekOnItsOwn]), and one routed through [mixer] on any engine at all, since routing is
   * what gives an iPhone's element its stall and nothing says another engine's would come through it
   * with less.
   *
   * NOT an iPhone's element played straight to the speaker. It loses about 45 ms to a put, and judged
   * over the long second with the 300 ms allowance it was never put right after a start: the picture
   * is slow to start on a phone, the music ran about 0.3 s ahead of it for a whole pass, and each seam
   * carried that on into the next (the iOS 26.5 simulator, 2026-09-29). Judged as Chromium's is, it is
   * put in step within half a second.
   */
  private slowToSeek(el: HTMLAudioElement): boolean {
    return audioSlowToSeekOnItsOwn() || this.mixer.isRouted(el);
  }

  /** The longest stall a lead is learned for on `el`; see [MAX_AUDIO_LEAD_MS] and [MAX_SLOW_SEEK_LEAD_MS]. */
  private maxLeadMs(el: HTMLAudioElement): number {
    return this.slowToSeek(el) ? MAX_SLOW_SEEK_LEAD_MS : MAX_AUDIO_LEAD_MS;
  }

  /** How far `el` may be from the playhead before it is put back; see [AUDIO_DRIFT_MS] and [SLOW_SEEK_DRIFT_MS]. */
  private driftAllowedMs(el: HTMLAudioElement): number {
    return this.slowToSeek(el) ? SLOW_SEEK_DRIFT_MS : AUDIO_DRIFT_MS;
  }

  /**
   * Puts the music or the voiceover on `uri`, on the element [PreviewMixer.elementFor] says it is to
   * play on - which is the component's own everywhere but where that element has been routed and the
   * file is one the graph would hear as silence, or the sound is played at a `rate` the graph cannot
   * take. An element the sound moves off is stripped, as the preview strips every element it has
   * finished with, so it holds no decoder and has nothing to play. A new speed for the same file on
   * the same element is only a new rate, with nothing loaded again.
   */
  private setSource(which: 'music' | 'voice', uri: string | null, rate = 1): void {
    const current = which === 'music' ? this.musicUri : this.voiceUri;
    if (current === uri && (which === 'voice' || this.musicRate === rate)) return;
    const url = uri ? this.store.host.platform.fileUrl(uri) : null;
    const was = which === 'music' ? this.musicEl : this.voiceEl;
    const el = url ? this.mixer.elementFor(this.ownAudio[which], url, rate) : this.ownAudio[which];
    if (which === 'music') {
      this.musicUri = uri;
      this.musicRate = rate;
      this.musicEl = el;
    } else {
      this.voiceUri = uri;
      this.voiceEl = el;
    }
    if (current === uri && el === was) {
      applySoundRate(el, rate);
      return;
    }
    if (was !== el) {
      was.pause();
      was.removeAttribute('src');
      was.load();
    }
    // What was known about the file each of them had is not true of the next one.
    for (const changed of [was, el]) {
      this.audioLengths.delete(changed);
      this.audioPutAtMs.delete(changed);
      this.audioAtEnd.delete(changed);
      this.audioFinishing.delete(changed);
    }
    el.pause();
    if (url) {
      el.src = url;
    } else {
      el.removeAttribute('src');
    }
    el.load();
    // After the load, which puts an element back to its default rate - set here as well.
    applySoundRate(el, rate);
  }

  /** Makes two elements per audio lane, and releases a lane once the edit no longer has it. */
  private ensureAudioLanes(): void {
    const wanted = new Set<string>();
    const slot = (): LaneSlot => {
      const own = this.makeAudio();
      own.preload = 'auto';
      this.mixer.add(own);
      return { own, element: own, uri: null, clipId: null, rate: 1 };
    };
    for (const track of this.store.manifest.value.audioTracks ?? []) {
      wanted.add(track.id);
      if (!this.audioLanes.has(track.id)) this.audioLanes.set(track.id, [slot(), slot()]);
    }
    for (const [id, lane] of this.audioLanes) {
      if (wanted.has(id)) continue;
      for (const { own, element } of lane) {
        for (const el of new Set([own, element])) {
          el.pause();
          el.removeAttribute('src');
          el.load();
          this.forgetAudio(el);
        }
        this.mixer.remove(own);
      }
      this.audioLanes.delete(id);
    }
  }

  /** Every audio lane's elements as they play now, stand-ins included. */
  private laneElements(): HTMLAudioElement[] {
    return [...this.audioLanes.values()].flatMap(lane => lane.map(slot => slot.element));
  }

  /**
   * Puts `clip` on one of a lane's slots. The same file stays loaded on the same element - for the next
   * clip along that uses it, or for a new speed of the same clip - unless that speed moves the sound
   * between the mixer's element and its stand-in; see [PreviewMixer.elementFor].
   */
  private setLaneSource(lane: LaneSlot, clip?: EditAudioClip): void {
    const uri = clip?.uri ?? null;
    const id = clip?.id ?? null;
    const rate = clip ? musicSpeed(clip) : 1;
    if (lane.uri === uri && lane.clipId === id && lane.rate === rate) return;
    const url = uri ? this.store.host.platform.fileUrl(uri) : null;
    const wanted = url ? this.mixer.elementFor(lane.own, url, rate) : lane.own;
    if (lane.uri === uri && wanted === lane.element) {
      if (lane.clipId !== id) {
        // Two consecutive clips can use the same file. Their windows are still separate playback
        // decisions, including when the first was already marked as finishing at its out point.
        lane.element.pause();
        this.settling.delete(lane.element);
        this.audioFinishing.delete(lane.element);
      }
    } else {
      lane.element = this.changeAudioSource(lane.own, lane.element, uri, rate);
    }
    applySoundRate(lane.element, rate);
    lane.uri = uri;
    lane.clipId = id;
    lane.rate = rate;
  }

  /** Chooses the routed element or its stand-in and forgets the old file's timing. */
  private changeAudioSource(own: HTMLAudioElement, was: HTMLAudioElement, uri: string | null, rate = 1): HTMLAudioElement {
    const url = uri ? this.store.host.platform.fileUrl(uri) : null;
    const el = url ? this.mixer.elementFor(own, url, rate) : own;
    if (was !== el) {
      was.pause();
      was.removeAttribute('src');
      was.load();
    }
    // What was known about the file each of them had is not true of the next one.
    for (const changed of [was, el]) this.forgetAudio(changed);
    el.pause();
    if (url) {
      el.src = url;
    } else {
      el.removeAttribute('src');
    }
    el.load();
    return el;
  }

  private forgetAudio(el: HTMLAudioElement): void {
    this.settling.delete(el);
    this.audioLengths.delete(el);
    this.audioPutAtMs.delete(el);
    this.audioAtEnd.delete(el);
    this.audioFinishing.delete(el);
  }

  private pauseAudio(): void {
    if (!this.musicEl.paused) this.musicEl.pause();
    if (!this.voiceEl.paused) this.voiceEl.pause();
    for (const el of this.laneElements()) if (!el.paused) el.pause();
  }

  /**
   * Puts the music and the voiceover through [PreviewMixer] for this play, where the WebView ignores
   * `volume` and the post has levels for them that would otherwise not be heard; the mixer is where
   * everything else that has to hold first is written down. Asked from `play()` alone, which is the
   * customer's tap and so the one moment WebKit lets a page start sound of its own - and never during
   * a voiceover take, whose microphone the audio session belongs to until the take is over.
   */
  private startMixer(): void {
    if (volumeIsWritable() || this.store.recordingFromMs.value !== null) return;
    const manifest = this.store.manifest.value;
    const uris = [manifest.music?.uri, ...manifest.voiceovers.map(take => take.uri), ...(manifest.audioTracks ?? []).flatMap(track => track.clips.map(clip => clip.uri))];
    const own = uris.every(uri => !uri || playableHere(this.store.host.platform.fileUrl(uri)));
    this.mixer.start(own && levelsInUse(manifest));
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
    // Where only one video may be heard at a time, the layer's sound gets an element of its own;
    // see [FollowerVideo.sound].
    const sound = media.sound !== undefined ? media.sound : oneVideoSoundAtATime() ? document.createElement('audio') : null;
    this.followers.set(trackId, new FollowerVideo(this.store, { ...media, sound }));
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
   *
   * And each is readied for what its track shows next, [PRELOAD_AHEAD_MS] ahead - the lead the base
   * track's spare is given for its next clip. One with nothing on screen loads it and waits on its
   * opening frame (see [FollowerVideo.preload]); one busy showing a clip cannot, so the next clip's
   * picture, if it is one, is decoded into the shared ones for the element to find ready at the cut.
   */
  private syncFollower(playing: boolean): void {
    const byTrack = new Map(this.extraLayers().map(layer => [layer.trackId, layer] as const));
    const coming = this.followers.size > 0 ? new Map(this.store.upcomingLayers(PRELOAD_AHEAD_MS).map(layer => [layer.trackId, layer] as const)) : null;
    for (const [trackId, follower] of this.followers) {
      const layer = byTrack.get(trackId) ?? null;
      follower.sync(layer, playing);
      const next = coming?.get(trackId) ?? null;
      if (!layer) follower.preload(next);
      else if (next) this.warmPicture(next);
    }
  }

  /** Decodes the picture `layer` shows into the shared ones ahead of its cut, when it is a picture. */
  private warmPicture(layer: PreviewVideoLayer): void {
    const source = this.pictures ? this.store.clipByKey(layer.clipKey) : undefined;
    if (!source || !this.store.isPictureKey(source.key)) return;
    this.pictures?.warm(previewSrc(this.store, source));
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
    return this.store.slots.value.find(slot => slot.clip.id === this.segmentId) ?? null;
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
function setSound(video: ClipMedia, muted: boolean, volume: number): void {
  if (video.muted !== muted) video.muted = muted;
  const level = clamp(Number.isFinite(volume) ? volume : 0, 0, 1);
  if (video.volume !== level) video.volume = level;
}
