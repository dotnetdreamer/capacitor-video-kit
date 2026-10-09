import { findClip, type EditClip } from '../../editor';
import { debugWarn } from '../../host/debug';
import type { EditorSource } from '../../host/host.types';
import type { EditorStore, PreviewVideoLayer } from '../../state/editor-store';
import { sameUrl } from '../../state/same-url';
import type { ClipMedia } from './clip-media';
import { BLANK_POSTER, SEEK_EPSILON_S, applyClipAudio, applyPitch, clipsSilenced, posterFor, previewSrc, soundHushed, startPlayback } from './preview-media';

/**
 * How far out of step with the base the second element is left alone, in OUTPUT milliseconds.
 *
 * A frame or two apart is invisible and a seek is not free: every one of them stalls the decoder,
 * so correcting the drift on every playhead write would cost more in stutter than the drift ever
 * costs in accuracy. Put another way, this is the point at which the picture is wrong enough to be
 * worth a hiccup.
 */
const DRIFT_MS = 80;

/**
 * The same for a layer's SOUND where it plays on an element of its own (see [FollowerVideo.sound]),
 * and wider, as the music's is: a seek of something heard is heard, so only a drift the ear would
 * catch against the picture is corrected.
 */
const SOUND_DRIFT_MS = 200;

/**
 * How far ahead of the picture the layer's sound is put as it starts: an `<audio>` element's clock
 * stands still for about this long after `play()` while the phone's audio output starts - the
 * figure the player starts the music with before it has measured one (`DEFAULT_AUDIO_LEAD_MS`) -
 * so put where the picture is, the sound was heard that late for the whole play.
 */
const SOUND_START_LEAD_MS = 180;

/** `readyState >= HAVE_CURRENT_DATA`: the element has a frame of where it is. */
const HAVE_CURRENT_DATA = 2;

export interface FollowerMedia {
  video: ClipMedia;
  /**
   * Where only one `<video>` with sound may play at a time (see `oneVideoSoundAtATime`): the element
   * this layer's own sound plays on, while its video plays muted. Absent everywhere else, where the
   * video element is heard itself.
   */
  sound?: HTMLAudioElement | null;
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
  private readonly video: ClipMedia;
  /**
   * The layer's own sound, on an `<audio>` of its own, where the WebView lets only one `<video>` with
   * sound play at a time - iOS, where the base clip's element is that one, and a layer's element
   * started with its sound on paused the base on the spot, so a post with a layer's sound on would
   * not play at all. There the layer's video plays muted and this plays the same file's sound, in
   * step with it: every layer is still heard, as the render mixes them. Null everywhere else.
   */
  private readonly sound: HTMLAudioElement | null;
  /** The host clip key whose source is on [sound], whether or not it loaded. */
  private soundKey: string | null = null;
  private readonly unlisten: Array<() => void> = [];

  /** The host clip key whose source is on the element, whether or not it loaded. */
  private loadedKey: string | null = null;
  /** Where the base says this element should be, in SOURCE milliseconds. */
  private targetMs = 0;
  private posterIsBlank = true;
  /** The last thing [sync] was told, so a load that lands later can pick up where it left off. */
  private layer: PreviewVideoLayer | null = null;
  /**
   * The layer the track shows next, while it shows nothing, which the element is loaded and waiting
   * on; see [preload]. Null once a layer is on screen.
   */
  private ahead: PreviewVideoLayer | null = null;
  private playing = false;
  private destroyed = false;

  constructor(
    private readonly store: EditorStore,
    media: FollowerMedia,
  ) {
    this.video = media.video;
    this.sound = media.sound ?? null;
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
    this.ahead = null;
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

  /**
   * Gets the element ready for the layer its track shows next, while it shows nothing: the source
   * loaded and the element paused on the frame the layer opens on, so the layer is on screen from
   * the first frame of its window.
   *
   * Left until the window opened, the source was put on the element on that very frame, and the
   * stage held every other layer still while it came - a picture decoding, a video loading, seeking
   * and finding its first frame - and then jumped to where the post had got to in the meantime. A
   * split whose halves slide in over 600 ms lost the first 220-380 ms of the slide that way on the
   * iOS 26.5 simulator (2026-10-07): the halves appeared a third of the way in. The base track has
   * always done this for its next clip, on its spare element (see `preloadDue`); a layer's element
   * has nothing else to do while its track is off screen, so it waits on its next clip itself.
   *
   * Nothing is done while a layer is on screen - the element is busy showing it - or for null.
   */
  preload(next: PreviewVideoLayer | null): void {
    if (this.destroyed || this.layer || !next) return;
    const source = this.store.clipByKey(next.clipKey);
    if (!source) return;
    this.ahead = next;
    this.targetMs = next.sourceMs;
    if (this.loadedKey !== source.key) {
      this.load(source);
      return;
    }
    this.apply();
  }

  pause(): void {
    if (!this.video.paused) this.video.pause();
    if (this.sound && !this.sound.paused) this.sound.pause();
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

  /**
   * The source on this element has a preview copy now, or has lost the one it had; see
   * [PreviewPlayer.refreshSources], the only caller. Forgetting the source makes [sync] load what
   * [previewSrc] names now, from where the playhead is. Nothing happens for a source that has not
   * changed.
   */
  refreshSource(): void {
    if (this.destroyed || !this.loadedKey || this.store.isPictureKey(this.loadedKey)) return;
    const source = this.store.clipByKey(this.loadedKey);
    if (!source || sameUrl(this.video.src, previewSrc(this.store, source))) return;
    this.loadedKey = null;
    this.soundKey = null;
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
    this.stripSound();
  }

  /* ========================================================================================= */
  /* Internals                                                                                 */
  /* ========================================================================================= */

  /** Points the element at another source. There is no token to supersede: the wanted layer is a
      field, so a load that lands late applies wherever the playhead has got to by then. */
  private load(source: EditorSource): void {
    const video = this.video;
    this.loadedKey = source.key;
    // A picture takes the element's place in the slot before anything else is asked of it; see
    // [ClipMedia]. From here on it is loaded, seeked and started like any clip.
    video.showPicture(this.store.isPictureKey(source.key));
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
    // On screen, or waiting for its window to open (see [preload]): the same element either way, and
    // only one that is on screen is ever started or heard.
    const live = this.layer !== null;
    const layer = this.layer ?? this.ahead;
    const clip = layer ? findClip(this.store.manifest.value, layer.clipId) : null;
    if (!clip) return;
    const video = this.video;
    const speed = clip.speed || 1;
    const silenced = clipsSilenced(this.store);
    // Pitch correction before the rate, and read back each time: some WebViews reset it on every
    // source change. On only where the layer's sound is heard; see [applyPitch].
    applyPitch(video, clip, silenced || this.sound !== null);
    if (video.playbackRate !== speed) video.playbackRate = speed;
    // With a sound element of its own, the picture plays silent: see [sound]. And so does it while an
    // audio effect layer's copy is heard in its place.
    const hushed = soundHushed(this.store);
    applyClipAudio(video, clip, hushed || this.sound !== null);

    // Running, the element carries itself between playhead writes and only a drift worth a stall is
    // corrected; stopped, nothing else moves it, so it goes exactly where it is wanted. The source
    // runs at the clip's speed, so the output milliseconds the drift is measured in are that many
    // more of the file when the clip is sped up. A paused element with a frame that a play has just
    // reached - the one [preload] left on the opening frame of its window - is started from there,
    // as a running one would carry on: the playhead is a frame or two past that frame by the time
    // the window opens, and a seek to close those milliseconds would throw the waiting frame away.
    const running = this.playing && (!video.paused || (live && video.readyState >= HAVE_CURRENT_DATA));
    const tolerance = running ? (DRIFT_MS * speed) / 1000 : SEEK_EPSILON_S;
    const targetSec = this.targetMs / 1000;
    // A source that has just loaded is seeked whatever those two numbers say, which is the same rule
    // the base element's loader has for the same reason: an element that has never been seeked keeps
    // the show-poster flag the load set, and a WebView answers the first decoded frame of one that
    // still has it by not presenting it. Every "Add video" lands exactly there - a new layer starts
    // at 0 with the playhead on 0, so the tolerance found nothing to correct - and the second layer
    // then sat on its blank poster, showing nothing, until some other edit happened to move it.
    if (fresh || Math.abs(video.currentTime - targetSec) > tolerance) video.currentTime = targetSec;

    if (live && this.playing) {
      if (video.paused) startPlayback(video);
    } else {
      this.pause();
    }
    if (live) this.applySound(clip, silenced);
  }

  /**
   * The layer's sound on [sound]: the same file as the picture, at the clip's speed and pitch, where
   * the picture is, running when it runs - and nothing at all, not even loaded, while the layer is
   * not heard.
   */
  private applySound(clip: EditClip, silenced: boolean): void {
    const sound = this.sound;
    if (!sound) return;
    const source = this.loadedKey ? this.store.clipByKey(this.loadedKey) : undefined;
    const heard = !silenced && !clip.muted && clip.volume > 0 && !!source && !this.store.isPictureKey(source.key);
    if (!heard || !source) {
      if (!sound.paused) sound.pause();
      return;
    }
    if (this.soundKey !== source.key) {
      this.soundKey = source.key;
      sound.src = previewSrc(this.store, source);
      sound.load();
    }
    const speed = clip.speed || 1;
    applyPitch(sound, clip, silenced);
    if (sound.playbackRate !== speed) sound.playbackRate = speed;
    // Under an audio effect layer's copy it plays on without a sound, so it is where the post is when
    // the copy ends and it is heard again.
    const quiet = this.store.soundUnderCopy.peek();
    if (sound.muted !== quiet) sound.muted = quiet;
    // Stopped, it simply stops: nothing is heard, so nothing is put anywhere until it starts again.
    if (!this.playing) {
      if (!sound.paused) sound.pause();
      return;
    }
    const targetSec = this.targetMs / 1000;
    if (sound.paused) {
      sound.currentTime = targetSec + (SOUND_START_LEAD_MS * speed) / 1000;
      startPlayback(sound);
      return;
    }
    if (Math.abs(sound.currentTime - targetSec) > (SOUND_DRIFT_MS * speed) / 1000) sound.currentTime = targetSec;
  }

  /** Lets go of the sound's decoder, as [destroy] does the picture's. */
  private stripSound(): void {
    const sound = this.sound;
    if (!sound) return;
    sound.pause();
    sound.removeAttribute('src');
    sound.load();
    this.soundKey = null;
  }

  private onError(): void {
    // A preview copy this WebView would not play: forgotten, so the store's change has the layer
    // loaded again on the clip itself (see [refreshSource]). A real failure is below.
    const key = this.loadedKey;
    const src = this.video.src;
    // Or a copy some other element has already given up on, whose failure is the same one.
    if (key && !this.store.isPictureKey(key) && (this.store.dropPreviewUrl(key, src) || this.store.isDroppedPreviewUrl(key, src))) {
      debugWarn('[ve-preview] preview copy could not be loaded; playing the clip itself', key, this.video.error);
      this.refreshSource();
      return;
    }
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
