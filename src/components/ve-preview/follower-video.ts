import { findClip } from '../../editor';
import { debugWarn } from '../../host/debug';
import type { EditorSource } from '../../host/host.types';
import type { EditorStore, PreviewVideoLayer } from '../../state/editor-store';
import {
  BLANK_POSTER,
  SEEK_EPSILON_S,
  applyClipAudio,
  clipsSilenced,
  posterFor,
  previewSrc,
  startPlayback,
} from './preview-media';

/**
 * How far out of step with the base the second element is left alone, in OUTPUT milliseconds.
 *
 * A frame or two apart is invisible and a seek is not free: every one of them stalls the decoder,
 * so correcting the drift on every playhead write would cost more in stutter than the drift ever
 * costs in accuracy. Put another way, this is the point at which the picture is wrong enough to be
 * worth a hiccup.
 */
const DRIFT_MS = 80;

export interface FollowerMedia {
  video: HTMLVideoElement;
}

/**
 * The second layer's `<video>`, kept in step with the base one.
 *
 * It is a FOLLOWER and never a clock. The base track's length is the post's, so the base element is
 * what plays, what fires the frame loop and what says where the playhead is; this one is only ever
 * put where that says, which is why it has none of the player's machinery - no queued seeks, no
 * autoplay to remember, no advancing of its own. Each call to [sync] hands it the layer under the
 * playhead, or null when the track's window has not started, has ended, or the post has no second
 * layer at that instant, and null simply pauses it where it stands.
 *
 * It has no hold canvas and needs none. Pointing a `<video>` at another file paints black through
 * the whole load-seek chain, which is what a hold used to cover; the preview is one composited
 * canvas now, and a canvas keeps what was last drawn into it - so a layer between sources is simply
 * a layer the compositor does not repaint. See [PreviewCanvas].
 */
export class FollowerVideo {
  private readonly video: HTMLVideoElement;
  private readonly unlisten: Array<() => void> = [];

  /** The host clip key whose source is on the element, whether or not it loaded. */
  private loadedKey: string | null = null;
  /** Where the base says this element should be, in SOURCE milliseconds. */
  private targetMs = 0;
  private posterIsBlank = true;
  /** The last thing [sync] was told, so a load that lands later can pick up where it left off. */
  private layer: PreviewVideoLayer | null = null;
  private playing = false;
  private destroyed = false;

  constructor(
    private readonly store: EditorStore,
    media: FollowerMedia,
  ) {
    this.video = media.video;
    // A load lands on the file's first frame until its metadata is in and the position can be
    // clamped against a duration, so where the playhead is gets said again here - and said as a real
    // seek, which is the one thing that makes a freshly loaded element present anything at all.
    this.listen('loadedmetadata', () => this.apply(true));
    this.listen('error', () => this.onError());
  }

  /**
   * Puts the element where the playhead now is. `layer` is null whenever the second track has
   * nothing on screen, and the element then idles paused - it keeps its source and its decoded
   * frame, so coming back into the track's window costs a seek rather than a whole load.
   */
  sync(layer: PreviewVideoLayer | null, playing: boolean): void {
    if (this.destroyed) return;
    this.layer = layer;
    this.playing = playing;
    if (!layer) {
      this.pause();
      return;
    }
    this.targetMs = layer.sourceMs;
    const source = this.store.clipByKey(layer.clipKey);
    if (!source) {
      this.pause();
      return;
    }
    if (this.loadedKey !== source.key) {
      this.load(source);
      return;
    }
    this.apply();
  }

  pause(): void {
    if (!this.video.paused) this.video.pause();
  }

  /** A filmstrip arrived; this layer may have been showing the blank poster. */
  refreshPoster(): void {
    if (this.destroyed || !this.posterIsBlank) return;
    const source = this.layer ? this.store.clipByKey(this.layer.clipKey) : undefined;
    if (source && source.key === this.loadedKey) this.setPoster(source);
  }

  /**
   * Puts this layer's picture back after the page has been away; see [PreviewPlayer.revive], which
   * is the only caller and where the whole of it is written down. Forgetting the source is what
   * makes [sync] load it again, and a load is what a purged element needs.
   */
  revive(): void {
    if (this.destroyed || !this.video.paused) return;
    this.loadedKey = null;
    this.sync(this.layer, this.playing);
  }

  destroy(): void {
    this.destroyed = true;
    for (const off of this.unlisten) off();
    // Pauses and strips the element, so the decoder is handed back at once rather than whenever the
    // element is collected - the whole reason there may only ever be two of these.
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }

  /* ========================================================================================= */
  /* Internals                                                                                 */
  /* ========================================================================================= */

  /** Points the element at another source. There is no token to supersede: the wanted layer is a
      field, so a load that lands late applies wherever the playhead has got to by then. */
  private load(source: EditorSource): void {
    const video = this.video;
    this.loadedKey = source.key;
    // Order matters: the frame has to be copied while the OLD source is still on screen. One line
    // later, after `src` is assigned, there is nothing left to copy.
    this.setPoster(source);
    video.src = previewSrc(this.store, source);
    video.load();
    // The position written by `apply` below becomes the element's DEFAULT playback start position
    // while the metadata is still coming, so the load lands on the frame the playhead is on instead
    // of on the file's first one and then seeking away from it.
    this.apply();
  }

  /**
   * Rate, sound and position, from the layer [sync] was last given. `fresh` is a source whose
   * metadata has just arrived, which is always seeked; see below.
   */
  private apply(fresh = false): void {
    const layer = this.layer;
    const clip = layer ? findClip(this.store.manifest.value, layer.clipId) : null;
    if (!clip) return;
    const video = this.video;
    const speed = clip.speed || 1;
    if (video.playbackRate !== speed) video.playbackRate = speed;
    // Some WebViews reset pitch correction on every source change, so it is set each time.
    (video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
    applyClipAudio(video, clip, clipsSilenced(this.store));

    // Running, the element carries itself between playhead writes and only a drift worth a stall is
    // corrected; stopped, nothing else moves it, so it goes exactly where it is wanted. The source
    // runs at the clip's speed, so the output milliseconds the drift is measured in are that many
    // more of the file when the clip is sped up.
    const tolerance = this.playing && !video.paused ? (DRIFT_MS * speed) / 1000 : SEEK_EPSILON_S;
    const targetSec = this.targetMs / 1000;
    // A source that has just loaded is seeked whatever those two numbers say, which is the same rule
    // the base element's loader has for the same reason: an element that has never been seeked keeps
    // the show-poster flag the load set, and a WebView answers the first decoded frame of one that
    // still has it by not presenting it. Every "Add video" lands exactly there - a new layer starts
    // at 0 with the playhead on 0, so the tolerance found nothing to correct - and the second layer
    // then sat on its blank poster, showing nothing, until some other edit happened to move it.
    if (fresh || Math.abs(video.currentTime - targetSec) > tolerance) video.currentTime = targetSec;

    if (this.playing) {
      if (video.paused) startPlayback(video);
    } else {
      this.pause();
    }
  }

  private onError(): void {
    debugWarn('[ve-preview] second layer could not be loaded', this.loadedKey, this.video.error);
    // `loadedKey` is deliberately left where it is. Forgetting it would point the element at the
    // same unreadable file again on the very next playhead write, and again on the one after that;
    // the layer simply shows nothing until its clip changes, which is what the render would do with
    // a file it cannot open either.
  }

  private setPoster(source: EditorSource): void {
    const poster = posterFor(this.store, source, this.targetMs);
    this.posterIsBlank = !poster;
    this.video.setAttribute('poster', poster ?? BLANK_POSTER);
  }

  private listen(type: string, handler: () => void): void {
    this.video.addEventListener(type, handler);
    this.unlisten.push(() => this.video.removeEventListener(type, handler));
  }
}
