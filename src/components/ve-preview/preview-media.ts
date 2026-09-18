import { clamp, type EditClip } from '../../editor';
import { debugWarn } from '../../host/debug';
import type { EditorSource } from '../../host/host.types';
import type { EditorStore } from '../../state/editor-store';

/**
 * What the preview's `<video>` elements share.
 *
 * There are two of them now - the base track's and the one above it - and everything below is the
 * part of playing a clip that does not depend on which of the two is doing it: where a clip's file
 * is, what covers the element while it goes black, and how a clip's own sound reaches the speaker.
 * The base element is still the clock and still owns the timeline; this is only the machinery both
 * of them need, kept in one place so a fix made for one cannot miss the other.
 */

/** Closer than this to where the element already is, a seek is not worth a decode. */
export const SEEK_EPSILON_S = 0.008;

/** How far a paused element is moved to make it paint again; see [repaintPaused]. */
const REPAINT_NUDGE_S = 0.001;

/**
 * How long the held frame stays up when no presented-frame callback arrives to lower it.
 *
 * Only reached where `requestVideoFrameCallback` is missing, or where the element is paused and so
 * presents nothing new. Two compositor frames at 60 Hz is enough to cover the repaint, and being a
 * little late is invisible while being early puts the black back.
 */
const HOLD_FALLBACK_MS = 34;

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
 * Makes a PAUSED element paint the frame it is parked on again, into the box the render has just
 * given it.
 *
 * A `<video>` that is not playing presents nothing of its own accord, and WKWebView composites a
 * paused one as a layer it does not repaint when only that layer's geometry changes. A layout
 * preset moves and clips both elements without moving the playhead by a millisecond, so the base
 * element kept the picture it had painted for its old box and showed black inside its new one,
 * while the export of the same manifest was correct. Everything this file already says about a
 * fresh source - that a paused WebView video sits on the poster, or on black, until something seeks
 * it - is true of a moved one too.
 *
 * A seek is what makes a paused element decode and present, and it has to be a seek to a position
 * the element is NOT already on: a WebView is free to answer a seek to where it already is with
 * nothing at all, which is what the player's own seek watchdog exists for. So this moves by a
 * millisecond, which is a small fraction of a frame at any rate a phone shoots at - the same
 * picture comes back, it is simply asked for again. The element is then that far from where the
 * player put it, and can never be further: the next ordinary seek measures itself against
 * [SEEK_EPSILON_S] and pulls it back the moment the nudges add up past it.
 *
 * An element with no frame yet is left alone. It has nothing to paint, and the load it is in the
 * middle of ends with a seek of its own.
 */
export function repaintPaused(video: HTMLVideoElement): void {
  if (!video.paused || video.readyState < 2 /* HAVE_CURRENT_DATA */) return;
  const at = video.currentTime;
  const ahead = at + REPAINT_NUDGE_S;
  // Backwards at the very end of a file, where there is no room ahead to move into and the seek
  // would be clamped straight back to the position the element is already on.
  const room = !Number.isFinite(video.duration) || ahead <= video.duration;
  video.currentTime = room ? ahead : Math.max(0, at - REPAINT_NUDGE_S);
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

/**
 * The outgoing clip's last frame, held over a `<video>` while the element is pointed at the next
 * source.
 *
 * Pointing a `<video>` at a new file tears its decode pipeline down, and WKWebView paints black
 * through the whole load-seek chain - the `poster` attribute does not reliably cover it and is blank
 * anyway for a clip whose filmstrip has not been cut yet. A bitmap cannot go black, costs no
 * decoder, and holds the real frame at full resolution.
 *
 * One of these per element rather than one for the preview: the second layer loads its own sources
 * and goes black in exactly the same way, and a hold that belonged to the player would have to be
 * told which element it was covering on every call.
 */
export class VideoHold {
  /** Cancels the pending reveal: a `requestVideoFrameCallback` handle, or a timer id behind it. */
  private cancel: (() => void) | null = null;
  private raised = false;
  private destroyed = false;
  /**
   * Whether the canvas holds a frame from some earlier raise. It is what lets a raise that cannot
   * copy a FRESH frame still put something over the element instead of letting black through; see
   * [raise]. Once true it stays true - the canvas is never cleared, only drawn over.
   */
  private hasFrame = false;

  /**
   * @param safetyMs how long a raised hold may stay up with nothing coming to lower it; see [raise].
   */
  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly setHolding: (on: boolean) => void,
    private readonly safetyMs: number,
  ) {}

  /**
   * Copies the frame currently on screen into the hold canvas and shows it.
   *
   * Called immediately before a source change, which is the only thing that makes the element go
   * black. `drawImage` from a `capacitor://` or remote video taints the canvas, but tainting only
   * blocks readback and this canvas is never read, so a tainted one displays perfectly.
   *
   * A frame is only there to copy once `readyState` has one. When there is not one - the element is
   * already part way through a load - the canvas is left holding whatever the LAST raise put on it
   * and that is shown instead. It is a frame or two stale and it is replaced within about a tenth of
   * a second, which is a far better answer than the black it covers: crossing a cut while the
   * element has not settled is exactly what a scrub over a clip boundary does, several times a
   * second, and every one of those used to flash.
   *
   * Only the very first load of a session finds an empty canvas, and there black is what the frame
   * already shows, so the hold is skipped rather than raised over a blank one.
   */
  raise(): void {
    if (this.destroyed) return;
    if (!this.copyFrame() && !this.hasFrame) return;
    this.cancel?.();
    this.raised = true;
    this.setHolding(true);
    // A hold that is never lowered is a frozen preview, which is worse than the flash it replaces.
    // Nothing is expected to need this - the callers lower on the frame landing, on their own seek
    // watchdog, or explicitly when a load fails - so it is a backstop against a path nobody thought
    // of, sized by its owner to outlast every watchdog it has.
    const safety = setTimeout(() => this.done(), this.safetyMs);
    this.cancel = () => clearTimeout(safety);
  }

  /**
   * Copies the frame the element is settled on, ready for a raise that will not be able to.
   *
   * A raise can only copy while the element still HAS a frame, and during a scrub across a cut it
   * never does: each crossing arrives with the element already part way through the seek the last
   * crossing asked for. The canvas would then never be written at all, and every crossing would
   * show black. This is called from the other end - wherever the element has just settled on a
   * frame - so that there is always a recent one to fall back on.
   *
   * Does nothing while a hold is up: that frame is the one being shown, and replacing it with
   * whatever the element has part way through its load is how a hold starts flickering.
   */
  prime(): void {
    if (this.destroyed || this.raised) return;
    this.copyFrame();
  }

  /**
   * Copies what is on the element into the canvas, and says whether there was anything to copy.
   *
   * Intrinsic size, so `object-fit: contain` letterboxes the canvas exactly as it letterboxes the
   * video and the held frame does not jump a pixel when it appears.
   */
  private copyFrame(): boolean {
    const video = this.video;
    if (video.readyState < 2 /* HAVE_CURRENT_DATA */ || !video.videoWidth || !video.videoHeight) {
      return false;
    }
    if (this.canvas.width !== video.videoWidth) this.canvas.width = video.videoWidth;
    if (this.canvas.height !== video.videoHeight) this.canvas.height = video.videoHeight;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return false;
    try {
      ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
    } catch {
      // `drawImage` from a `capacitor://` or remote video taints the canvas, but tainting only
      // blocks readback and this canvas is never read, so a tainted one displays perfectly. A frame
      // that genuinely cannot be copied leaves whatever the last raise put there.
      return false;
    }
    this.hasFrame = true;
    return true;
  }

  /**
   * Lowers the hold once the element has actually PAINTED a frame of the new source.
   *
   * `seeked` is too early: it fires when the seek is resolved, not when the frame is on screen, and
   * lowering there puts the black back for a frame or two. `requestVideoFrameCallback` fires with a
   * frame presented, which is exactly the moment the hold has stopped being needed. Where it does
   * not exist the timer is a floor, not a guess: it only has to outlast one compositor frame.
   */
  lower(): void {
    if (this.destroyed || !this.raised) return;
    this.cancel?.();
    const video = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    const done = () => this.done();
    if (typeof video.requestVideoFrameCallback === 'function') {
      const handle = video.requestVideoFrameCallback(done);
      // A paused element presents no new frames, so the callback may never come. The timer is the
      // backstop for that case and for a load that failed outright.
      const timer = setTimeout(done, HOLD_FALLBACK_MS);
      this.cancel = () => {
        clearTimeout(timer);
        video.cancelVideoFrameCallback?.(handle);
      };
      return;
    }
    const timer = setTimeout(done, HOLD_FALLBACK_MS);
    this.cancel = () => clearTimeout(timer);
  }

  /**
   * Takes the hold away, DOWN.
   *
   * Lowering here rather than only cancelling the pending reveal, because the signal belongs to the
   * component and outlives this object: the follower's hold is destroyed on every remove of the
   * second video and on every undo of adding one, and a hold destroyed while it was up left that
   * signal on. The canvas the NEXT hold is handed is then a fresh one, born with the class that
   * shows it, blank, over the whole frame - and it can never come down, because the new hold has
   * not been raised and [lower] returns at its first line for good.
   */
  destroy(): void {
    this.destroyed = true;
    this.done();
  }

  private done(): void {
    // The reveal was armed with a presented-frame callback AND the timer behind it, and only one of
    // the two has brought us here. An orphaned frame callback does not expire: it waits for the
    // element's next presented frame, which on a paused element means the next play - a whole hold
    // or more later - and then lowers whichever hold is up by then, a frame early and black.
    const cancel = this.cancel;
    this.cancel = null;
    cancel?.();
    // The hold is coming down because the new frame is on screen, so this is the best moment there
    // is to stock the canvas for the next one - and the cheapest, once per clip change.
    this.copyFrame();
    this.raised = false;
    this.setHolding(false);
  }
}
