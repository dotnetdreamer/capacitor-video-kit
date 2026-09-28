import { clamp, type EditClip } from '../../editor';
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
 * `playbackUrl` is already loadable by contract; anything else goes through the host, which is the
 * one place in the package that knows how this app turns a path into a URL. A source with neither
 * is a host that handed over nothing to play, and the element is pointed at the empty string rather
 * than at the page itself, which is what a bare `src=""` resolves to.
 */
export function previewSrc(store: EditorStore, source: EditorSource): string {
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
