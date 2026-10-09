import { clamp, musicSectionMs, musicSpeed, soundEffectPlaysSpeedAsRecord, type EditClip, type EditMusic, type EditVoiceover } from '../../editor';
import { debugWarn } from '../../host/debug';
import type { EditorSource } from '../../host/host.types';
import type { EditorStore } from '../../state/editor-store';

/**
 * What the preview's `<video>` elements share.
 *
 * There is one per video track, and everything below is the part of playing a clip that does not
 * depend on which of them is doing it: where a clip's file is, what it shows before it has a frame,
 * and how a clip's own sound reaches the speaker. The base element is still the clock and still owns
 * the timeline; this is only the machinery all of them need, kept in one place so a fix made for one
 * cannot miss the others.
 *
 * What is NOT here any more is the hold: a `<canvas>` per element carrying the outgoing frame while
 * the element was pointed at the next source, because pointing a `<video>` at a new file paints
 * black through the whole load-seek chain. The preview is one composited canvas now, and a canvas
 * keeps whatever was last drawn into it, so a layer between sources is a layer the compositor
 * declines to repaint - see [PreviewCanvas], which is also where the waiting is bounded.
 */

/** Closer than this to where the element already is, a seek is not worth a decode. */
export const SEEK_EPSILON_S = 0.008;

/**
 * A transparent pixel for a clip with no frame to show yet. Android's WebView draws a grey
 * placeholder with a play glyph over a `<video>` that has no poster at all, which would sit over the
 * preview until the first frame decodes.
 */
export const BLANK_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Where a source's file is, as something this WebView can play.
 *
 * The source's preview copy first, where the host has made one ([EditorStore.previewUrls]): the same
 * footage on the same timeline, which a cut seeks at once. Read with `peek`, so a view that resolves
 * a source inside an effect does not start re-running whenever a copy lands - the preview reloads its
 * elements onto a copy deliberately, from where they are (see [PreviewPlayer.refreshSources]).
 *
 * `playbackUrl` is already loadable by contract; anything else goes through the host, which is the
 * one place in the package that knows how this app turns a path into a URL. A source with neither
 * is a host that handed over nothing to play, and the element is pointed at the empty string rather
 * than at the page itself, which is what a bare `src=""` resolves to.
 */
export function previewSrc(store: EditorStore, source: EditorSource): string {
  const copy = store.previewUrls.peek().get(source.key);
  if (copy) return copy;
  if (source.playbackUrl) return source.playbackUrl;
  if (source.sourcePath) return store.host.platform.fileUrl(source.sourcePath);
  return '';
}

/**
 * A paused WebView video can sit black until it is played; this is what shows instead - the
 * filmstrip frame nearest where the segment is parked, else the clip's own thumbnail. Null when
 * neither is there yet, which is what the poster is put back for once a filmstrip arrives.
 */
export function posterFor(store: EditorStore, source: EditorSource, sourceMs: number): string | null {
  const strip = store.filmstrips.value.get(source.key);
  if (strip?.urls.length) {
    const frame = Math.floor(Math.max(0, sourceMs) / Math.max(1, strip.stepMs));
    return strip.urls[Math.min(strip.urls.length - 1, frame)];
  }
  return source.thumbnailUrl ? store.host.platform.fileUrl(source.thumbnailUrl) : null;
}

/** Whether the post is silencing its clips' own sound: turned off outright, or a take being
    recorded, when the phone's speaker would be recorded along with the customer's voice. */
export function clipsSilenced(store: EditorStore): boolean {
  return store.manifest.value.originalMuted || store.recordingFromMs.value !== null;
}

/** A clip's own sound on the element playing it. A second layer's clips get theirs the same way. */
export function applyClipAudio(video: { muted: boolean; volume: number }, clip: EditClip, silenced: boolean): void {
  const muted = silenced || clip.muted;
  if (video.muted !== muted) video.muted = muted;
  const volume = clamp(clip.volume, 0, 1);
  if (video.volume !== volume) video.volume = volume;
}

/**
 * Pitch correction on the element playing `clip`: on where the clip's own sound is heard, off where
 * it is not. Set it BEFORE the element's rate, so a rate change never meets it on for nothing.
 *
 * On, a slowed or sped-up clip's sound keeps its own pitch, as the render has it. Off, nothing
 * changes for a clip nobody can hear - and on iOS a great deal is saved. WebKit hands the rate of an
 * element with pitch correction on to AVFoundation's time-pitch algorithm, and every change of rate
 * on a playing element then flushes the player back to a keyframe and stands its clock still.
 * Measured in this package's WKWebView on the iOS 26.5 simulator (2026-09-27), eight rate changes on
 * a playing element: three jumps back to a keyframe and 3.2 s of frozen clock with it on and the
 * element muted, 8.5 s with it on and heard, and nothing at all with it off, muted or heard. A
 * template's clips are nearly always muted under its music and its speed ramps change the rate at
 * every step, so every step was a stall - and the music was seeked back after each one.
 *
 * Written only when it differs: each write is a message to the media process, and the spare's is
 * asked for on every frame it waits. Read back rather than remembered, so a WebView that resets it
 * with a new source is caught.
 */
export function applyPitch(video: { preservesPitch?: boolean }, clip: EditClip, silenced: boolean): void {
  const keep = !silenced && !clip.muted && clip.volume > 0;
  if (video.preservesPitch !== keep) video.preservesPitch = keep;
}

/**
 * Whether this WebView lets only ONE `<video>` with sound play at a time: iOS, where starting a
 * second one pauses the first, on the spot and with no error. Measured in this package's WKWebView
 * on the iOS 26.5 simulator (2026-09-27): two unmuted videos, the second started 800 ms after the
 * first - the first paused; the second muted - both played; the second an unmuted `<audio>` playing
 * an MP4 - both played. A post with a layer whose own sound is on over a base clip whose sound is on
 * therefore could not be played in the preview at all: Play started the base, the layer's start
 * paused it, and the transport went straight back to Play.
 *
 * Told apart by the other thing only iOS's WebKit does: a `volume` it will not let a page set
 * ([volumeIsWritable]). See [FollowerVideo] for what is done about it; the base track's own two
 * elements never start with their sound on at once (the spare is started muted, and a transition's
 * tail is not heard where the volume cannot fade it).
 */
export function oneVideoSoundAtATime(): boolean {
  return !volumeIsWritable();
}

let volumeWritable: boolean | null = null;

/**
 * Whether this WebView lets a page set a media element's `volume` at all.
 *
 * iOS does not: the volume is the hardware buttons' alone. Everything that FADES a clip's own sound -
 * a transition's crossfade - has to know, because a fade written to an element that ignores it is
 * two clips at full volume at once. So do the music and the voiceover, which are heard at their
 * levels there through [PreviewMixer] instead. Worked out once and remembered; the answer cannot
 * change while the page is up.
 *
 * An iPhone or an iPad is taken for what it is ([appleTouchWebKit]) before anything is asked of an
 * element. Asking one is what this did alone, and iOS used to answer it by reading back 1 whatever
 * was written; iOS 26's WebKit reads back what was written to an element that is not playing, and
 * puts it back to 1 the moment the element plays (measured on the iOS 26.5 simulator, 2026-09-28).
 * The probe said "writable" there, and every one of the things above quietly took the path for a
 * WebView where volume works: the music's level and fade-out unheard, and a transition's two clips
 * both left sounding.
 */
export function volumeIsWritable(): boolean {
  if (volumeWritable === null) {
    if (appleTouchWebKit()) {
      volumeWritable = false;
    } else {
      try {
        const probe = document.createElement('video');
        probe.volume = 0.5;
        volumeWritable = Math.abs(probe.volume - 0.5) < 0.01;
      } catch {
        volumeWritable = false;
      }
    }
  }
  return volumeWritable;
}

/**
 * Apple's WebKit on a touch screen: every WebView on an iPhone, and on an iPad, which calls itself a
 * Mac but has a touch screen no Mac has. Where the two restrictions above - `volume` ignored, one
 * `<video>` with sound at a time - are iOS's own.
 */
function appleTouchWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /^Apple/.test(navigator.vendor ?? '') && (navigator.maxTouchPoints ?? 0) > 1;
}

/**
 * `play()` rejects with AbortError whenever a src change interrupts it. That is the normal cost of
 * swapping clips on one element, not a failure, so it is swallowed - the transport follows the
 * element's own events either way.
 */
export function startPlayback(el: { play(): Promise<void> }): void {
  el.play().catch((error: unknown) => {
    if ((error as DOMException)?.name !== 'AbortError') debugWarn('[ve-preview] play failed', error);
  });
}

/* ============================================================================================ */
/* The music and the voiceover                                                                  */
/* ============================================================================================ */

/**
 * On Apple's WebKit, an audio element that is still playing this close to the end of its FILE is not
 * moved: it is left to reach the end and say so itself, and is put where it is wanted once it has.
 *
 * WebKit ends an element in two steps. Its clock gets to the end first, and from then the element
 * reads its duration back as its `currentTime`, `ended` true and `paused` still false; the media
 * process's own notice that the file has played out comes a moment later - 22 ms, measured in this
 * package's WKWebView on the iOS 26.5 simulator (2026-09-28) - and on its way through
 * (`MediaPlayerPrivateAVFoundation::didEnd`) it takes wherever the player is AT THAT MOMENT as the
 * file's real length, because the length AVFoundation gave at the start is sometimes an estimate. A
 * seek that lands in between is where the player is when the notice arrives. That is exactly what a
 * loop's seam used to be: the music at the end of its file and the preview putting it back to the
 * start of the next pass. The 12-second track's length became 0.121 s at the second seam of both
 * runs, every play of it ended the moment it began, and the preview put it back on every frame for
 * the rest of the play (716 seeks in 36 s) while nothing was heard. Pausing it first and then putting
 * it is not relied on: nothing in a pause calls back a notice that is already on its way. Once the
 * element has said it has ended, the notice has been and gone - its duration is the true one - and it
 * is put like any paused element.
 *
 * Nothing is lost by waiting: there is no more than this left of the file to play, and a repeating
 * section is sent round before it gets here (see [PreviewPlayer.playAt]).
 *
 * Only there. No other engine has been seen to do it: Chromium stops an element at the end of its file
 * with `paused` and `ended` together and keeps the length it read. Elsewhere the guard is `ended`
 * alone, and a section can be sent round right up to its end; see [audioEndGuardMs].
 */
export const AUDIO_END_GUARD_MS = 50;

/**
 * How close to the end of its file a playing audio element may be moved: not within
 * [AUDIO_END_GUARD_MS] on Apple's WebKit - every iOS WebView, and Safari - and anywhere short of the
 * end elsewhere. Asked each time rather than remembered: it is one comparison.
 */
export function audioEndGuardMs(): number {
  if (typeof navigator === 'undefined') return 0;
  return /^Apple/.test(navigator.vendor ?? '') ? AUDIO_END_GUARD_MS : 0;
}

/**
 * Whether this is Apple's WebKit - Safari on a Mac, and every WebView on an iPhone or an iPad - whose
 * `<audio>` clock can lose a long and uneven stretch over the second after a start or a seek: always on
 * a Mac, and on a phone once the element is played through Web Audio. [audioSlowToSeekOnItsOwn] says
 * which of those the player judges once that second is over; see [PreviewPlayer]'s
 * [SLOW_SEEK_SETTLE_MS]. Chromium's, on a desktop and in Android's WebView, loses a few tens of
 * milliseconds at once and is judged as it always was. Asked each time rather than remembered, as
 * [audioEndGuardMs] is: it is one comparison.
 */
export function audioSlowToSeek(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /^Apple/.test(navigator.vendor ?? '');
}

/**
 * Whether an audio element here is slow to seek ON ITS OWN, played straight to the speaker: Apple's
 * WebKit where a page can set `volume` ([volumeIsWritable]), which is Safari on a Mac - and so routes
 * nothing through [PreviewMixer]. An iPhone's or an iPad's element is slow to seek only once it is
 * routed; played straight to the speaker it loses about 45 ms. [PreviewPlayer] asks, because the two
 * are put with different leads before their own have been measured; see its
 * [DEFAULT_SLOW_SEEK_LEADS_MS].
 */
export function audioSlowToSeekOnItsOwn(): boolean {
  return audioSlowToSeek() && volumeIsWritable();
}

/**
 * The stretch of a sound file one `<audio>` element plays, and for how much longer: the music's
 * section, which may repeat, or a voiceover take. `inMs` and `outMs` are positions in the FILE; `outMs`
 * is Infinity when the length of the file is not known, and then nothing below reads it.
 */
export interface SoundSpan {
  inMs: number;
  outMs: number;
  /** The stretch starts again from `inMs` when it reaches `outMs`, for as long as the sound goes on. */
  loop: boolean;
  /**
   * How much more of the FILE is played from this instant, every pass still to come counted: the
   * post's milliseconds left, times [rate]. In the file's terms because everything it is weighed
   * against - how far an element is from its out point - is a position in the file.
   */
  leftMs: number;
  /**
   * How fast the element plays its file: the sound's speed, 1 for a take. Every stretch of WALL time
   * the player reckons with - a stall it leads by, a drift it allows - covers this much more of the
   * file, and is turned into the file's terms with it before it meets a position.
   */
  rate: number;
  /**
   * There, and true, for a sound whose speed is a record's - slower is lower ([ComposeMusic.varispeed]):
   * its element plays at [rate] with its pitch let go, as the render plays it. Absent for every sound
   * that keeps its pitch, which is every sound at 1x.
   */
  varispeed?: true;
}

/** The music's section, heard for `leftMs` more of the post; see [musicSectionMs]. */
export function musicSpan(music: EditMusic, leftMs: number): SoundSpan {
  const section = musicSectionMs(music);
  const rate = musicSpeed(music);
  return {
    inMs: music.inMs,
    outMs: section > 0 ? music.inMs + section : Infinity,
    loop: music.loop && section > 0,
    leftMs: leftMs * rate,
    rate,
    ...(playsAsRecord(music) ? { varispeed: true as const } : {}),
  };
}

/** Whether a sound's element lets its pitch go with its speed; see [SoundSpan.varispeed]. */
export function playsAsRecord(music: Pick<EditMusic, 'speed' | 'effect'>): boolean {
  return musicSpeed(music) !== 1 && soundEffectPlaysSpeedAsRecord(music.effect);
}

/** A voiceover take, from its first moment to its last, with the playhead at `outputMs`. */
export function takeSpan(take: EditVoiceover, outputMs: number): SoundSpan {
  return { inMs: 0, outMs: take.durationMs > 0 ? take.durationMs : Infinity, loop: false, leftMs: take.startMs + take.durationMs - outputMs, rate: 1 };
}

/**
 * A sound's element at the speed its sound plays at, its pitch kept as the render keeps it - or let
 * go with the speed, `varispeed`, for a sound whose speed is a record's, as the render plays that one.
 * The DEFAULT rate as well as the rate, because `load()` puts an element back to its default: an
 * element given a sped-up sound's file is at that sound's speed from the moment the file is on it, and
 * the mixer reads the default to keep such an element out of its graph; see [PreviewMixer.elementFor].
 *
 * Written only when it differs, as every level in the preview is: each write is a message to the
 * media process, and this is asked on every check of a playing sound.
 */
export function applySoundRate(el: HTMLMediaElement, rate: number, varispeed = false): void {
  if (rate !== 1) keepPitch(el, !varispeed);
  if (el.defaultPlaybackRate !== rate) el.defaultPlaybackRate = rate;
  if (el.playbackRate !== rate) el.playbackRate = rate;
}

/**
 * Whether `el` keeps its pitch at a rate other than 1x: on, every element's default, for a sound that
 * keeps it, and off for a record's speed - which WebKit then plays without the time-pitch algorithm
 * at all (see [applyPitch]). Written only to change it, as it always was.
 */
function keepPitch(el: HTMLMediaElement, keep: boolean): void {
  if (keep ? el.preservesPitch === false : el.preservesPitch !== false) el.preservesPitch = keep;
}

/** How long one pass of the span is; 0 when the file's length is not known. */
export function passMs(span: SoundSpan): number {
  return Number.isFinite(span.outMs) ? Math.max(0, span.outMs - span.inMs) : 0;
}

/** Whether a position is on the span itself, its out point included. */
function onSpan(ms: number, span: SoundSpan): boolean {
  return ms >= span.inMs && ms <= span.outMs;
}

/**
 * Where on its pass an element at `atMs` is, for telling WHICH pass it is on: where it is, or the out
 * point for one that has played on past it. An element there was not seen coming up to the seam in
 * time to be sent round (see [PreviewPlayer.playAt]) and is at the end of its pass all the same - not
 * somewhere on the next one, which is what its position read straight made of it, and the playhead
 * that had already gone round was then taken to be a whole pass ahead of it.
 */
function passPositionMs(atMs: number, span: SoundSpan): number {
  return Math.min(atMs, span.outMs);
}

/**
 * The furthest into its file an element can be put on the pass it is on: short of the span's out
 * point, and short of the end of its file by the end guard (see [audioEndGuardMs]) - or, where there
 * is none, by as much as makes a seek worth making ([SEEK_EPSILON_S]). An element that has ended sits
 * at the end of its file, a put that close to it is not made (see [PreviewPlayer.seekAudio]), and
 * `play()` then takes the element back to the start of the file, which is the very restart this is
 * all here to keep out.
 */
function putLimitMs(span: SoundSpan, fileEndMs: number, guardMs: number): number {
  return Math.min(span.outMs, fileEndMs - Math.max(guardMs, SEEK_EPSILON_S * 1000));
}

/**
 * How far an element at `atMs` in its file is AHEAD of `wantMs` (negative: behind), measured round
 * the loop when the span repeats and both are on it.
 *
 * Round the loop because at a seam the two are on different passes for a moment: the playhead is at
 * the start of the next pass while the element is still finishing this one, or the element has been
 * sent on to the next pass (see [wrapAimMs]) while the playhead finishes this one. Taken straight,
 * either is a whole section of drift, and the element was pulled back across the seam it had just
 * been sent over - a second seek and a second stall at every seam.
 */
export function soundOffsetMs(atMs: number, wantMs: number, span: SoundSpan): number {
  const offset = atMs - wantMs;
  const pass = passMs(span);
  if (!span.loop || pass <= 0 || !onSpan(atMs, span) || !onSpan(wantMs, span)) return offset;
  if (offset > pass / 2) return offset - pass;
  if (offset < -pass / 2) return offset + pass;
  return offset;
}

/**
 * Whether another pass of the span follows the one the element at `atMs` is on before the sound
 * stops. The element's pass is the playhead's, or the one before it when the playhead has already
 * gone round the seam and the element has not - see [soundOffsetMs] - or the one after it when the
 * element has and the playhead has not. An element past the out point is at the end of its pass; see
 * [passPositionMs].
 */
export function passFollows(atMs: number, positionMs: number, span: SoundSpan): boolean {
  const pass = passMs(span);
  if (!span.loop || pass <= 0) return false;
  const passAtMs = passPositionMs(atMs, span);
  let endsInMs = span.outMs - positionMs;
  if (onSpan(passAtMs, span) && onSpan(positionMs, span)) {
    const offset = passAtMs - positionMs;
    if (offset > pass / 2) endsInMs -= pass;
    else if (offset < -pass / 2) endsInMs += pass;
  }
  return endsInMs < span.leftMs;
}

/**
 * Where to put an element that is to be heard at `positionMs` once the stall of `leadMs` that putting
 * it costs is over - a paused one about to be started, or a playing one that has drifted: `leadMs`
 * further on, and round onto the next pass of a repeating span when that carries it past the out
 * point, or past the end of its file (`fileEndMs`) where that comes first.
 *
 * Null when it is not to be put anywhere yet, and not started. Where no pass follows this one, that is
 * because what is left of the sound is shorter than the stall: started, it would play what lies past
 * the out point, or, at the end of its file, go back to the start of it, which is what `play()` does
 * to an element that has ended. Where one does, it is because the put would land on the last stretch
 * of this pass, where the element would have to be put again as soon as it came out of this stall:
 * within `zoneMs` of the end of the pass (its out point, or the end of the file where that comes
 * first) - the stretch in which a playing element is sent round (see [PreviewPlayer.playAt]), which
 * cost the seam a second stall straight after the first - or past the point it can be put at all
 * ([putLimitMs]) but short of the end. Sent round from there it would have to go before the in point,
 * where there is nothing to put it on, and start the next pass early and stay that far ahead. Asked
 * again at the next check, with the playhead that much nearer the seam, it goes round onto the next
 * pass exactly; the tail of this pass it misses is shorter than the stall.
 *
 * Also null past the end of the file but short of the out point, where the file ends no more than
 * `zoneMs` before it: WebKit reads a 12 s AAC `.m4a` as 11.975 s, where iOS's composer - the render,
 * and `probe` with it - reads its audio track to 12.000 s, and a sound picked on iOS gets that as its
 * section. The element has nothing to play for the last 25 ms of each pass; sent round from there it
 * too would go before the in point and start the next pass that much early, where waiting a check
 * lets it go round exactly, on the pass the render is on. It is left paused where it is: one that has
 * played that far sits at the end of its file, and is only asked about once WebKit has said it has
 * got there (see [AUDIO_END_GUARD_MS]), so the one seek it is ever given is the one onto the next
 * pass, and no seek lands between the end of the file and that notice. A file that ends further
 * short of the out point than that is not a file read a little short but a length that is wrong -
 * a sound replaced under the post - and it goes round at the end of the file at once, which is where
 * the render loops it too: never past the end of its audio track.
 */
export function soundPutMs(positionMs: number, leadMs: number, span: SoundSpan, fileEndMs = Infinity, guardMs = 0, zoneMs = 0): number | null {
  const putMs = positionMs + leadMs;
  const limitMs = putLimitMs(span, fileEndMs, guardMs);
  const pass = passMs(span);
  const follows = span.loop && pass > 0 && span.outMs - positionMs < span.leftMs;
  if (!follows) return putMs < limitMs ? Math.max(0, putMs) : null;
  const endMs = Math.min(span.outMs, fileEndMs);
  if (putMs < Math.min(limitMs, endMs - zoneMs)) return Math.max(0, putMs);
  if (putMs < (span.outMs - endMs <= zoneMs ? span.outMs : endMs)) return null;
  return clamp(putMs - pass, span.inMs, span.outMs);
}

/**
 * Where a PLAYING element about to reach a repeating span's out point - or just past it; see
 * [passPositionMs] - would have to be put for it to come out of the seek stall of `leadMs` that
 * putting it costs exactly where the playhead will be by then, on the next pass. The playhead is
 * still on the element's pass, short of the seam, or has already gone round it; see [soundOffsetMs].
 *
 * Before the in point when the element is being sent round further ahead of the seam than its stall
 * - an element running ahead of the playhead, or a stall shorter than the checks are apart. There is
 * nothing before the in point to play, so it is put ON the in point, and starts the next pass that
 * much early; see [PreviewPlayer.wrapAudio].
 */
export function wrapAimMs(atMs: number, positionMs: number, leadMs: number, span: SoundSpan): number {
  const pass = passMs(span);
  const passAtMs = passPositionMs(atMs, span);
  const playheadRound = onSpan(passAtMs, span) && onSpan(positionMs, span) && passAtMs - positionMs > pass / 2;
  return positionMs + leadMs - (playheadRound ? 0 : pass);
}

/**
 * Whether a STOPPED element at `atMs` has played the last of the sound out, and is no more than
 * `slackMs` ahead of the playhead getting there: it is at the span's out point, or as far into its
 * file as it can be put ([putLimitMs]), with no pass after this one.
 *
 * Such an element is left where it is. It ran ahead of the playhead - Chromium's by 60-90 ms in the
 * web editor, and by however much a lead measured too long put it - and has already played what the
 * playhead has still to reach; put back where the playhead is, as any other stopped element is, it
 * played that stretch a second time: the last tenth of a second of a trimmed sound, a take or the
 * last pass of a track, heard twice.
 */
export function playedOut(atMs: number, positionMs: number, span: SoundSpan, fileEndMs = Infinity, guardMs = 0, slackMs = 0): boolean {
  if (atMs < putLimitMs(span, fileEndMs, guardMs) || passFollows(atMs, positionMs, span)) return false;
  const aheadMs = atMs - positionMs;
  return aheadMs >= 0 && aheadMs <= slackMs;
}

/** The end of the element's file, in ms; Infinity while its length is not known. */
export function fileEndMs(el: { duration: number }): number {
  const ms = el.duration * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : Infinity;
}

/**
 * Whether the element has ended, or is within `guardMs` of the end of its file; see
 * [AUDIO_END_GUARD_MS].
 */
export function atFileEnd(el: { ended: boolean; duration: number; currentTime: number }, guardMs: number): boolean {
  return el.ended || fileEndMs(el) - el.currentTime * 1000 < guardMs;
}

/**
 * Calls back every time the page comes back from being hidden, and stops when the function it
 * returns is called.
 *
 * This is the one moment a paused element loses its picture with nothing in the editor having asked
 * for anything. A hidden page is a page WebKit takes the memory back from: every paused element is
 * put on `BufferingPolicy::PurgeResources`, which throws its decoded frame and its rendering
 * resources away, and the page coming back puts none of it back. The element still reports
 * HAVE_ENOUGH_DATA at the position it is parked on, and paints black.
 *
 * No seek cures that, which is what makes it look like a bug in this package rather than a state the
 * platform left behind: neither [repaintPaused]'s nudge nor a real scrub across the whole post
 * changes the policy, and the frames they ask for are never presented. Only a fresh load or playing
 * does - `play()` is where WebKit itself puts the policy back - which is exactly the shape of the
 * report this was found from: the base track went black, no layout preset and no scrub brought it
 * back, and Play fixed it instantly and for good.
 *
 * Every host picker hides the page. Adding a second video opens one, which is why "adding the second
 * track" was the trigger; it is no more about the second track than about the picker in front of it.
 */
export function onPageShown(handler: () => void): () => void {
  const listener = () => {
    if (document.visibilityState === 'visible') handler();
  };
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}
