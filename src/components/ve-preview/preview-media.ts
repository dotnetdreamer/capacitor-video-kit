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
export function applyClipAudio(video: HTMLVideoElement, clip: EditClip, silenced: boolean): void {
  const muted = silenced || clip.muted;
  if (video.muted !== muted) video.muted = muted;
  const volume = clamp(clip.volume, 0, 1);
  if (video.volume !== volume) video.volume = volume;
}

let volumeWritable: boolean | null = null;

/**
 * Whether this WebView lets a page set a media element's `volume` at all.
 *
 * iOS does not: the volume is the hardware buttons' alone, and `volume` reads back 1 whatever was
 * written to it. Everything that FADES a clip's own sound - a transition's crossfade - has to know,
 * because a fade written to an element that ignores it is two clips at full volume at once. Asked of
 * a detached element once and remembered; the answer cannot change while the page is up.
 */
export function volumeIsWritable(): boolean {
  if (volumeWritable === null) {
    try {
      const probe = document.createElement('video');
      probe.volume = 0.5;
      volumeWritable = Math.abs(probe.volume - 0.5) < 0.01;
    } catch {
      volumeWritable = false;
    }
  }
  return volumeWritable;
}

/**
 * `play()` rejects with AbortError whenever a src change interrupts it. That is the normal cost of
 * swapping clips on one element, not a failure, so it is swallowed - the transport follows the
 * element's own events either way.
 */
export function startPlayback(el: HTMLMediaElement): void {
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
