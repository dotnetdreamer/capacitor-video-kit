import { effect, signal } from '@preact/signals-core';
import { MAX_LAYERS, MAX_VIDEO_TRACKS, PICTURE_SOURCE_MS, defaultClipEdit, defaultPictureEdit, insertClip, replaceClipSource } from '../editor';

import { debugWarn } from '../host/debug';
import type { EditorSource, ResolvedEditorHost, SavedSound } from '../host/host.types';
import { isPictureSource, measurePicture, pictureThumbnail } from '../web-runtime/picture';
import { extractPeaks, type Peaks } from '../web-runtime/waveform';
import type { EditorStore } from './editor-store';
import { clipWaveKey, type Filmstrip } from './editor.types';

/** One filmstrip frame per second of source, the TikTok density at the default zoom. */
const FILMSTRIP_STEP_MS = 1000;
/** A long clip spreads its frames out rather than cutting past this many: each one is a decode. */
const FILMSTRIP_MAX_FRAMES = 60;
const FILMSTRIP_MAX_HEIGHT = 160;
/**
 * The most tiles a filmstrip may be cut on exact frames rather than on keyframes.
 *
 * The cost of an exact frame is per TILE, not per second of clip: the seek decodes every frame from
 * the keyframe before the time asked for, and on the Redmi Note 7 that measures 390-460 ms a tile
 * against 140 ms for a keyframe seek, whatever the clip's length. Six of them is the couple of
 * seconds a customer will wait for the first strip to appear, and at one tile per second they are
 * the short clips where two neighbouring tiles of the same picture are most of the strip. A longer
 * clip keeps keyframe seeks, where a repeat reads as a still moment anyway and five extra seconds
 * of decoding - per clip, with the preview wanting the same decoder - would be felt.
 *
 * Only the first cut of a clip pays either way, where the host caches its frames.
 */
const PRECISE_FILMSTRIP_MAX_FRAMES = 6;

/** How long one file may hold the waveform queue before it is given up on. */
const WAVEFORM_TIMEOUT_MS = 60_000;

/**
 * How a picture on the timeline is read: whether it decodes at all, and a small frame of it for the
 * filmstrip. A seam for the same reason [EditorMedia]'s audio measurer is one - the mock DOM the
 * unit tests run in decodes no image.
 */
export interface PictureReader {
  measure(url: string): Promise<{ width: number; height: number } | null>;
  thumbnail(url: string, maxHeight: number): Promise<string>;
}

const PICTURES: PictureReader = { measure: measurePicture, thumbnail: pictureThumbnail };

/**
 * Everything in the editor that asks the host for media: the pickers, the duration probe and the
 * filmstrip frames.
 *
 * Kept out of the components because several of them start the same thing - the timeline's "+",
 * the clip toolbar's Replace, the Sound menu, the Overlay tool - and because each of these calls
 * takes long enough that what comes back has to be reconciled against a manifest that may have
 * moved on. What the host hands back is simply written to the store, and the views reading those
 * signals repaint on their own.
 *
 * The host's side of every call is the smallest thing it can be: pick a file, measure it, cut some
 * frames. The order of operations - check the caps first, close an open text edit, commit, select,
 * queue the filmstrip - is the editor's, and it lives here.
 *
 * Created by the editor shell next to [EditorStore].
 */
export class EditorMedia {
  /**
   * True from the moment a picker is opened until what it handed back has been read and landed in
   * the store. Reading a result is not instant - a clip is probed, and an unreadable one is only
   * given up on after the host's own timeout - and for all that time the editor looks idle while a
   * change is on its way in. The shell greys Next with this, and the toolbar and the timeline can
   * grey the tiles that would start a second one.
   */
  readonly busy = signal(false);

  /**
   * The customer's kept sounds, newest first, as the host last reported them. Empty until
   * [loadSounds] has run, and empty for good on a host with no library at all.
   */
  readonly sounds = signal<readonly SavedSound[]>([]);

  /** The list has been asked for at least once, so an empty list can be shown as an empty list. */
  readonly soundsLoaded = signal(false);

  /**
   * A video's audio is being pulled out right now.
   *
   * Separate from [busy], which is every picker and greys Next: this one is what the Sound sheet
   * puts a spinner and a sentence behind, because an extraction is the one call here that takes
   * long enough for a customer to wonder whether they missed the button.
   */
  readonly extracting = signal(false);

  /** Filmstrips are cut one clip at a time: each batch holds a hardware decoder the preview needs. */
  private filmstripQueue: Promise<void> = Promise.resolve();
  private readonly filmstripsPending = new Map<string, Promise<void>>();
  /** Waveforms too, and for the same reason: decoding a track is a decoder the preview wants back. */
  private waveformQueue: Promise<void> = Promise.resolve();
  private readonly waveformsPending = new Map<string, Promise<void>>();
  private stopWatchingAudio: (() => void) | null = null;
  private destroyed = false;

  constructor(
    private readonly store: EditorStore,
    private readonly host: ResolvedEditorHost,
    /**
     * How a file is measured. A parameter only so the unit tests can supply their own: the real
     * one needs Web Audio, which the mock DOM they run in does not have.
     */
    private readonly measure: typeof extractPeaks = extractPeaks,
    /** How a picture is read; a parameter for the same reason `measure` is. */
    private readonly pictures: PictureReader = PICTURES,
  ) {
    /*
     * Waveforms follow the MANIFEST rather than being asked for at each place a sound can arrive.
     *
     * There are four such places - the picker, the sound library, a draft being reopened, and a
     * voiceover take finishing - and a fifth that has no call site at all: an undo that brings a
     * removed sound back. Watching the manifest covers all five in one subscription, and it is
     * exact, because the manifest is the only thing that decides which audio the post has.
     */
    this.stopWatchingAudio = effect(() => {
      const manifest = this.store.manifest.value;
      // Each with its length, so a track too long to decode can be turned down before it is read.
      const audio: { uri: string; key: string; durationMs: number }[] = manifest.music
        ? [{ uri: manifest.music.uri, key: manifest.music.uri, durationMs: manifest.music.sourceDurationMs }]
        : [];
      for (const take of manifest.voiceovers) audio.push({ uri: take.uri, key: take.uri, durationMs: take.durationMs });

      /*
       * Every video the post uses, for the sound inside it.
       *
       * Read off `clips` rather than off the manifest, because the manifest names sources by key
       * and the file behind a key is the host's business. A source with neither a playable URL nor
       * a path is one nothing can open, and is simply left alone.
       *
       * Filed under a name of its own, so a source key can never be mistaken for an audio URI.
       */
      for (const source of this.store.clips.value) {
        // A picture has no sound to draw, and handing one to the audio decoder is a decode that
        // can only fail.
        if (isPictureSource(source)) continue;
        const url = source.playbackUrl || (source.sourcePath ? this.host.platform.fileUrl(source.sourcePath) : '');
        if (url) audio.push({ uri: url, key: clipWaveKey(source.key), durationMs: this.store.sourceDurationMs(source.key) });
      }
      /*
       * Read inside the effect, which subscribes it: a measurement landing wakes this again, and
       * the file it recorded is then skipped. That is the whole job of the read - what keeps two
       * decodes from overlapping is `waveformQueue`, not this.
       */
      const known = this.store.waveforms.value;
      for (const { uri, key, durationMs } of audio) if (uri && !known.has(key)) void this.loadWaveform(uri, durationMs, key);
    });
  }

  /** Called by the shell when the editor leaves the document. */
  dispose(): void {
    this.destroyed = true;
    this.stopWatchingAudio?.();
    this.stopWatchingAudio = null;
  }

  /* ========================================================================================= */
  /* Clips                                                                                     */
  /* ========================================================================================= */

  /**
   * The source clip's length in milliseconds, 0 when it cannot be read, and records it in the store.
   */
  async probe(source: EditorSource): Promise<number> {
    const known = this.store.durations.value.get(source.key);
    if (known !== undefined && known > 0) return known;
    if (isPictureSource(source)) return this.probePicture(source);

    let durationMs = 0;
    let readable = true;
    try {
      const measured = await this.host.media.probeDuration(source);
      if (measured > 0) durationMs = Math.round(measured);
    } catch (error) {
      /*
       * The file did not open. Recorded rather than only logged, because this is the one failure
       * the CUSTOMER can act on: their video has been deleted or moved since the draft was made,
       * and the layer has to say so instead of sitting there at the right length showing nothing.
       */
      readable = false;
      debugWarn('[EditorMedia] probe failed', source.key, error);
    }

    this.store.durations.value = new Map(this.store.durations.value).set(source.key, durationMs);
    this.markReadable(source.key, readable);
    return durationMs;
  }

  /**
   * A picture has no length to measure, so the host's duration probe is not asked - it opens a
   * `<video>`, which a JPEG is not. What is worth knowing is whether the file is still there and
   * still decodes, which is exactly the question [unreadable] exists to answer for a draft reopened
   * after a photo was deleted. Its "source" is [PICTURE_SOURCE_MS] long either way, so its segment
   * can be trimmed while the answer is on its way.
   */
  private async probePicture(source: EditorSource): Promise<number> {
    const size = await this.pictures.measure(this.urlOf(source)).catch(() => null);
    if (!size) debugWarn('[EditorMedia] picture did not decode', source.key);
    this.store.durations.value = new Map(this.store.durations.value).set(source.key, PICTURE_SOURCE_MS);
    this.markReadable(source.key, !!size);
    return PICTURE_SOURCE_MS;
  }

  /** Something this WebView can load for a source: its own URL, or the host's reading of its path. */
  private urlOf(source: EditorSource): string {
    return source.playbackUrl || (source.sourcePath ? this.host.platform.fileUrl(source.sourcePath) : '');
  }

  /** Adds a clip to `store.unreadable`, or takes it back out once its file opens again. */
  private markReadable(key: string, readable: boolean): void {
    const missing = this.store.unreadable.value;
    if (readable === !missing.has(key)) return;

    const next = new Set(missing);
    if (readable) next.delete(key);
    else next.add(key);
    this.store.unreadable.value = next;
  }

  /**
   * Cuts the clip's filmstrip into `store.filmstrips`, queued behind any strip already being cut.
   * Asking twice for the same clip joins the first request.
   */
  loadFilmstrip(source: EditorSource): Promise<void> {
    const pending = this.filmstripsPending.get(source.key);
    if (pending) return pending;
    if (this.store.filmstrips.value.has(source.key)) return Promise.resolve();

    const job = this.filmstripQueue
      .then(() => this.cutFilmstrip(source))
      .catch((error: unknown) => {
        debugWarn('[EditorMedia] filmstrip failed', source.key, error);
      })
      .finally(() => this.filmstripsPending.delete(source.key));
    this.filmstripsPending.set(source.key, job);
    this.filmstripQueue = job;
    return job;
  }

  /**
   * Measures one audio file into `store.waveforms`, queued behind any file already being measured.
   * Asking twice for the same URI joins the first request.
   *
   * Called for you when the manifest changes, which is every way a sound can arrive; it is public
   * because a host that knows a track is coming can warm it, and because the tests drive it.
   */
  loadWaveform(uri: string, sourceDurationMs = 0, key: string = uri): Promise<void> {
    const pending = this.waveformsPending.get(key);
    if (pending) return pending;
    if (this.store.waveforms.value.has(key)) return Promise.resolve();

    const job = this.waveformQueue
      .then(() => this.cutWaveform(uri, sourceDurationMs, key))
      .catch((error: unknown) => {
        // Caught here rather than left to the queue, so one file that will not decode cannot stop
        // every file after it from being measured.
        debugWarn('[EditorMedia] waveform failed', uri, error);
      })
      .finally(() => this.waveformsPending.delete(key));
    this.waveformsPending.set(key, job);
    this.waveformQueue = job;
    return job;
  }

  /**
   * Adds one more video - or picture, on a host that allows them - straight after the selected
   * segment, or at the end.
   */
  async addClip(): Promise<void> {
    // A second picker while the first result is still being read would commit into a manifest
    // that is about to change under it.
    if (this.busy.value) return;
    if (!this.store.canAddClip.value) {
      this.store.showToast(`You can add up to ${this.store.maxClips.value} clips`);
      this.store.haptic('warning');
      return;
    }
    this.busy.value = true;
    try {
      const source = await this.pickClip();
      if (!source) return;
      const durationMs = await this.probe(source);

      this.landOpenTextEdit();
      this.store.clips.value = [...this.store.clips.value, source];
      const segmentId = this.store.newId('seg');
      const afterId = this.store.selectedClip.value?.id ?? null;
      const added = this.store.commit('Add clip', m => insertClip(m, this.segmentFor(source, durationMs, segmentId), afterId));
      if (added) {
        this.store.select({ kind: 'clip', id: segmentId });
        this.store.haptic('light');
      }
      void this.loadFilmstrip(source);
    } finally {
      this.busy.value = false;
    }
  }

  /**
   * Picks the second video and puts it on a layer of its own, so two clips are on screen at once.
   * Returns the new layer's id, or null when the customer backed out or there was no room.
   *
   * The same picker the base timeline uses: a source is a source, and the only thing that makes this
   * one different is which layer its segment lands on. It uses a clip slot like any other, which is
   * why the post's own limit is checked here as well as the layer cap.
   */
  async addVideoTrack(): Promise<string | null> {
    // A second picker while the first result is still being read would commit into a manifest
    // that is about to change under it.
    if (this.busy.value) return null;
    if (this.store.videoTracksFull.value) {
      this.store.showToast(`You can have ${MAX_VIDEO_TRACKS} videos on screen at once`);
      this.store.haptic('warning');
      return null;
    }
    if (!this.store.canAddClip.value) {
      this.store.showToast(`You can add up to ${this.store.maxClips.value} clips`);
      this.store.haptic('warning');
      return null;
    }
    this.busy.value = true;
    try {
      const source = await this.pickClip();
      if (!source) return null;
      const durationMs = await this.probe(source);

      this.landOpenTextEdit();
      this.store.clips.value = [...this.store.clips.value, source];
      const segmentId = this.store.newId('seg');
      const trackId = this.store.addVideoTrack(this.segmentFor(source, durationMs, segmentId));
      if (!trackId) {
        this.dropUnusedSource(source);
        return null;
      }
      void this.loadFilmstrip(source);
      return trackId;
    } finally {
      this.busy.value = false;
    }
  }

  /**
   * Points the selected segment at a different video. The old source stays in `store.clips` - an
   * undo can bring back a segment that still refers to it - and the shell only reports the clips
   * the manifest actually uses.
   */
  async replaceSelectedClip(): Promise<void> {
    // A second picker while the first result is still being read would commit into a manifest
    // that is about to change under it.
    if (this.busy.value) return;
    const target = this.store.selectedClip.value;
    if (!target) return;
    this.busy.value = true;
    try {
      const source = await this.pickClip();
      if (!source) return;
      const durationMs = await this.probe(source);

      this.landOpenTextEdit();
      this.store.clips.value = [...this.store.clips.value, source];
      // The segment is looked up again by id: it may have been deleted while the picker was open.
      const replaced = this.store.commit('Replace', m =>
        replaceClipSource(m, target.id, source.key, durationMs, this.host.editing.replaceKeepsLength, isPictureSource(source)),
      );
      if (!replaced) {
        this.dropUnusedSource(source);
        return;
      }
      this.store.haptic('light');
      void this.loadFilmstrip(source);
    } finally {
      this.busy.value = false;
    }
  }

  /* ========================================================================================= */
  /* Sound                                                                                     */
  /* ========================================================================================= */

  /**
   * The door every "Add sound" in the editor goes through: the Sound menu, the timeline's own
   * button and the music row's Replace.
   *
   * A host with a library gets the Sound sheet, where extracting one is the first thing on it. A
   * host without one gets the file picker straight away, exactly as every host did before the
   * library existed - a sheet whose only content is one button is worse than the button.
   */
  openSound(): void {
    this.store.pause();
    if (this.host.media.sounds) this.store.openPanel('sound');
    else void this.pickMusic();
  }

  async pickMusic(): Promise<void> {
    // A second picker while the first result is still being read would commit into a manifest
    // that is about to change under it.
    if (this.busy.value) return;
    this.store.pause();
    this.busy.value = true;
    try {
      let picked;
      try {
        picked = await this.host.media.pickAudio();
      } catch (error) {
        debugWarn('[EditorMedia] audio picker failed', error);
        this.store.showToast("That audio file can't be used. Try an MP3 or M4A.", 2400);
        this.store.haptic('warning');
        return;
      }
      if (!picked) return;

      this.useTrack(picked.uri, picked.fileName || 'Music', picked.sourceDurationMs);
    } finally {
      this.busy.value = false;
    }
  }

  /**
   * Puts a sound the customer already saved onto the post. No picker and no device call - the file
   * is one the library handed over - so this is the one thing here that happens instantly.
   */
  useSound(sound: SavedSound): void {
    if (this.busy.value) return;
    this.store.pause();
    this.landOpenTextEdit();
    this.useTrack(sound.uri, sound.fileName || 'Sound', sound.durationMs);
  }

  /**
   * Reads the library into [sounds]. Cheap to call again - the Sound sheet asks on every opening,
   * because an extraction from a previous opening may have finished since.
   *
   * A library that will not answer leaves the list as it was and says so in the console: the sheet
   * has a picker and an extract button on it whatever the list holds, and a red bar over a list that
   * is empty anyway would be the only thing this told anyone.
   */
  async loadSounds(): Promise<void> {
    const library = this.host.media.sounds;
    if (!library) {
      this.soundsLoaded.value = true;
      return;
    }
    try {
      const saved = await library.list();
      if (this.destroyed) return;
      this.sounds.value = [...saved];
    } catch (error) {
      debugWarn('[EditorMedia] sound library failed', error);
    } finally {
      if (!this.destroyed) this.soundsLoaded.value = true;
    }
  }

  /**
   * The whole of "extract from video": pick one, pull its audio out, keep it, and put it on the
   * post. The sound stays in the library afterwards, which is the point of it - the next edit finds
   * it in the list with no video to go looking for.
   *
   * Everything about it can go wrong in a way worth a different sentence: a video with no sound in
   * it is not a failure, a cancel is not either, and neither is a library that has no room left. So
   * each is answered here rather than folded into one "could not add sound".
   */
  async extractSound(): Promise<void> {
    const library = this.host.media.sounds;
    if (!library || this.busy.value) return;
    this.busy.value = true;
    try {
      const source = await this.pickVideo();
      if (!source) return;

      this.extracting.value = true;
      let saved: SavedSound | null;
      try {
        saved = await library.extract(source);
      } catch (error) {
        debugWarn('[EditorMedia] extract failed', source.key, error);
        this.store.showToast("That video's sound could not be saved. Try another one.", 2400);
        this.store.haptic('warning');
        return;
      } finally {
        this.extracting.value = false;
      }

      // A silent video. Said plainly, because nothing went wrong and the customer is about to try
      // the same video again if they are told it failed.
      if (!saved) {
        this.store.showToast('That video has no sound in it', 2400);
        this.store.haptic('warning');
        return;
      }

      // Ahead of the reload, so the new sound is in the list the moment the sheet repaints rather
      // than after a round trip to the library. Newest first, like the library's own order.
      const sound = saved;
      this.sounds.value = [sound, ...this.sounds.value.filter(one => one.id !== sound.id)];
      this.landOpenTextEdit();
      this.useTrack(sound.uri, sound.fileName || 'Sound', sound.durationMs);
      void this.loadSounds();
    } finally {
      this.extracting.value = false;
      this.busy.value = false;
    }
  }

  /**
   * Takes one sound out of the library for good.
   *
   * A sound the post is USING is removed from the list all the same and left on the post: the
   * manifest holds the URI rather than the record, an undo can bring back a step that names it, and
   * a delete that also silently pulled the music out of a post would be the customer losing two
   * things for one tap. What they then have is a post whose track is not in their library, which is
   * exactly what a track picked from files has always been.
   */
  async removeSound(id: string): Promise<void> {
    const library = this.host.media.sounds;
    if (!library) return;
    const before = this.sounds.value;
    this.sounds.value = before.filter(sound => sound.id !== id);
    try {
      await library.remove(id);
    } catch (error) {
      debugWarn('[EditorMedia] sound delete failed', id, error);
      if (this.destroyed) return;
      // Put back, or the row is gone from a list whose file is still there and comes back at the
      // next opening with no explanation.
      this.sounds.value = before;
      this.store.showToast('That sound could not be deleted');
      this.store.haptic('warning');
    }
  }

  /* ========================================================================================= */
  /* Photos                                                                                    */
  /* ========================================================================================= */

  async pickPhoto(): Promise<void> {
    // A second picker while the first result is still being read would commit into a manifest
    // that is about to change under it.
    if (this.busy.value) return;
    // Checked before the picker opens: choosing a photo only to be told there is no room for it
    // is worse than being told straight away.
    if (this.store.layersFull.value) {
      this.store.showToast(`You can add up to ${MAX_LAYERS} layers`);
      this.store.haptic('warning');
      return;
    }
    this.store.pause();
    this.busy.value = true;
    try {
      let picked;
      try {
        picked = await this.host.media.pickImage();
      } catch (error) {
        debugWarn('[EditorMedia] photo picker failed', error);
        this.store.showToast("That photo can't be used. Try a JPEG or PNG.", 2400);
        this.store.haptic('warning');
        return;
      }
      if (!picked) return;

      this.landOpenTextEdit();
      this.store.addImage(picked.uri, picked.fileName || 'Photo', picked.aspect);
    } finally {
      this.busy.value = false;
    }
  }

  /* ========================================================================================= */
  /* Internals                                                                                 */
  /* ========================================================================================= */

  /**
   * Closes a text edit the picker outlived, before this class's own change goes into the store.
   *
   * Add text is ONE gesture from the layer being created to Done, so that Cancel can remove it
   * without a trace and Done is a single undo step. Reading a picker's result takes seconds - long
   * enough for someone to give up waiting, tap Text and start typing - and the `commit` that
   * follows closes whatever gesture is open as a step of its own. That left "Add text" as two
   * steps, with the layer already committed and Cancel with nothing left to take back. Finishing
   * the text first lands it exactly as Done would have, and the media change follows it.
   */
  /**
   * Puts a track on the post, from wherever it came from.
   *
   * The volume is the one thing carried over from a track being replaced: it is the only field of
   * the six the customer sets by hand, and having it reset to 80% every time a different song is
   * tried is the difference between comparing two tracks and setting the level twice.
   */
  private useTrack(uri: string, fileName: string, sourceDurationMs: number): void {
    const existing = this.store.manifest.value.music;
    this.store.setMusic(
      {
        uri,
        fileName,
        sourceDurationMs,
        inMs: 0,
        outMs: 0,
        startMs: 0,
        volume: existing?.volume ?? 0.8,
        loop: true,
        fadeOutMs: 400,
      },
      existing ? 'Replace sound' : 'Add sound',
    );
  }

  private landOpenTextEdit(): void {
    if (this.store.textEdit.value) this.store.finishText();
  }

  /**
   * A picked video, or null on a cancel. A rejection is a real failure and has to say so, or the
   * button looks dead; a cancel says nothing, which is why the host contract makes them two
   * different answers rather than one rejection the editor has to read a message out of.
   */
  private async pickVideo(): Promise<EditorSource | null> {
    this.store.pause();
    try {
      return await this.host.media.pickVideo();
    } catch (error) {
      debugWarn('[EditorMedia] video picker failed', error);
      this.store.showToast("That video can't be used. Try another one.", 2400);
      this.store.haptic('warning');
      return null;
    }
  }

  /**
   * A clip for the timeline: a video, or a video or a picture on a host that allows pictures there
   * and supplies a picker that offers both. Null on a cancel, and on a failure after saying so.
   *
   * A host that allows pictures but has no `pickMedia` gets `pickVideo`, which is the promise the
   * option makes - it governs what the pickers offer, and a host with only a video picker can only
   * offer videos.
   */
  private async pickClip(): Promise<EditorSource | null> {
    const pickMedia = this.host.media.pickMedia;
    if (!this.host.editing.pictures || !pickMedia) return this.pickVideo();
    this.store.pause();
    try {
      return await pickMedia.call(this.host.media);
    } catch (error) {
      debugWarn('[EditorMedia] media picker failed', error);
      this.store.showToast("That file can't be used. Try another one", 2400);
      this.store.haptic('warning');
      return null;
    }
  }

  /**
   * The segment a picked source goes onto the timeline as: a picture held for [PICTURE_CLIP_MS], or
   * a video trimmed to the whole of its length.
   */
  private segmentFor(source: EditorSource, durationMs: number, segmentId: string) {
    return isPictureSource(source) ? defaultPictureEdit(source.key, segmentId) : defaultClipEdit(source.key, durationMs, segmentId);
  }

  /**
   * Takes a source back out after the edit refused it. Nothing - not even an undo step - refers to
   * it by this point.
   *
   * Whatever the host allocated to hand it over is the host's to release: a blob URL the editor
   * revoked here would be one it did not create, and on a Capacitor host there is nothing to
   * revoke at all.
   */
  private dropUnusedSource(source: EditorSource): void {
    this.store.clips.value = this.store.clips.value.filter(clip => clip !== source);
  }

  private async cutFilmstrip(source: EditorSource): Promise<void> {
    if (this.destroyed) return;
    if (isPictureSource(source)) {
      await this.cutPictureStrip(source);
      return;
    }
    const durationMs = this.store.sourceDurationMs(source.key) || (await this.probe(source));

    // Frames sit at whole multiples of the step so a host that caches them by time hands the same
    // strip back when the editor is opened again.
    const stepMs = durationMs > FILMSTRIP_STEP_MS * FILMSTRIP_MAX_FRAMES ? Math.ceil(durationMs / FILMSTRIP_MAX_FRAMES) : FILMSTRIP_STEP_MS;
    const count = Math.max(1, Math.min(FILMSTRIP_MAX_FRAMES, Math.ceil(durationMs / stepMs)));
    const timesMs = Array.from({ length: count }, (_, i) => i * stepMs);

    let strip: Filmstrip | null = null;
    try {
      const urls = await this.host.media.thumbnails({
        source,
        timesMs,
        maxHeight: FILMSTRIP_MAX_HEIGHT,
        // A keyframe seek is one decode, but a camera writes a keyframe only every second or two,
        // so a strip at one frame per second shows several tiles of the same picture. A precise
        // seek decodes forward from the keyframe before the time asked for, which costs roughly
        // three keyframe seeks per tile - worth it while the strip is short enough to appear
        // promptly, and paid once where the host caches the frames.
        precise: durationMs > 0 && count <= PRECISE_FILMSTRIP_MAX_FRAMES,
      });
      if (urls.length > 0) strip = { stepMs, urls: [...urls] };
    } catch (error) {
      debugWarn('[EditorMedia] thumbnails failed', source.key, error);
    }
    if (!strip && source.thumbnailUrl) {
      // One frame standing for the whole clip: a step as long as the clip puts every tile on it.
      strip = {
        stepMs: Math.max(FILMSTRIP_STEP_MS, durationMs),
        urls: [this.host.platform.fileUrl(source.thumbnailUrl)],
      };
    }
    if (!strip || this.destroyed) return;

    this.store.filmstrips.value = new Map(this.store.filmstrips.value).set(source.key, strip);
  }

  /**
   * A picture's filmstrip: ONE small frame of it, standing for every tile.
   *
   * The step is the whole of the picture's source, which is what puts every tile on frame 0 however
   * the segment is trimmed - the same trick a video with only a poster uses. Cut in the page rather
   * than asked of the host, whose thumbnailer seeks a video, and small rather than the file itself: a
   * tile is 160 px tall, and a timeline that tiled a twelve megapixel photo would decode it that big.
   * A picture that will not shrink is tiled as it is, which is slow and still right.
   */
  private async cutPictureStrip(source: EditorSource): Promise<void> {
    const url = this.urlOf(source);
    if (!url) return;
    let frame: string;
    try {
      frame = await this.pictures.thumbnail(url, FILMSTRIP_MAX_HEIGHT);
    } catch (error) {
      debugWarn('[EditorMedia] picture thumbnail failed', source.key, error);
      frame = url;
    }
    if (this.destroyed) return;
    this.store.filmstrips.value = new Map(this.store.filmstrips.value).set(source.key, { stepMs: PICTURE_SOURCE_MS, urls: [frame] });
  }

  /**
   * Reads one audio file and writes what it found - or `null` - into `store.waveforms`.
   *
   * `null` is recorded rather than nothing, and that is the point of the method: a file this
   * WebView cannot decode must be remembered as such, or the manifest watcher would ask for it
   * again on the very next edit and the editor would spend the rest of the session retrying a
   * decode that has already failed.
   *
   * The URL goes through `platform.fileUrl` first. In a plain page that hands the URL back as it came
   * and costs nothing, but a native host hands out URIs that only its local server can turn into
   * something fetchable.
   */
  private async cutWaveform(uri: string, sourceDurationMs: number, key: string): Promise<void> {
    if (this.destroyed) return;

    let peaks: Peaks | null = null;
    try {
      /*
       * Raced against a clock, because everything else waits behind this one.
       *
       * `decodeAudioData` has no timeout of its own, and a file that never settles would leave
       * `waveformQueue` pointing at a promise that never resolves - no track measured again for
       * the rest of the session, and nothing to say why. A minute is far longer than any file
       * inside [MAX_SOURCE_MS] needs and short enough that a stuck one does not cost the session.
       */
      peaks = await Promise.race([
        this.measure(this.host.platform.fileUrl(uri), undefined, sourceDurationMs),
        new Promise<null>(done => setTimeout(() => done(null), WAVEFORM_TIMEOUT_MS)),
      ]);
      if (!peaks) debugWarn('[EditorMedia] nothing to draw for', uri);
    } catch (error) {
      /*
       * A THROW has to be recorded too, and that is the whole reason for this try.
       *
       * `extractPeaks` answers null rather than throwing, but `platform.fileUrl` is the host's own
       * code and a native one can refuse a URI it did not expect. Letting that escape would leave
       * no entry in the map - and the manifest watcher runs on every write of the manifest, which
       * during a gesture is every frame, so one refused URI would start a decode thirty times a
       * second for the rest of the session.
       */
      debugWarn('[EditorMedia] waveform failed', uri, error);
    }

    // Checked again on the way out: measuring is slow enough for the editor to have been closed,
    // or for this very track to have been replaced, while it was happening.
    if (this.destroyed) return;
    this.store.waveforms.value = new Map(this.store.waveforms.value).set(key, peaks);
  }
}
