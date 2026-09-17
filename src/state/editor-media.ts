import { signal } from '@preact/signals-core';
import {
  MAX_LAYERS,
  MAX_VIDEO_TRACKS,
  defaultClipEdit,
  insertClip,
  replaceClipSource,
} from '../editor';

import { debugWarn } from '../host/debug';
import type { EditorSource, ResolvedEditorHost } from '../host/host.types';
import type { EditorStore } from './editor-store';
import type { Filmstrip } from './editor.types';

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

  /** Filmstrips are cut one clip at a time: each batch holds a hardware decoder the preview needs. */
  private filmstripQueue: Promise<void> = Promise.resolve();
  private readonly filmstripsPending = new Map<string, Promise<void>>();
  private destroyed = false;

  constructor(
    private readonly store: EditorStore,
    private readonly host: ResolvedEditorHost,
  ) {}

  /** Called by the shell when the editor leaves the document. */
  dispose(): void {
    this.destroyed = true;
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

    let durationMs = 0;
    try {
      const measured = await this.host.media.probeDuration(source);
      if (measured > 0) durationMs = Math.round(measured);
    } catch (error) {
      debugWarn('[EditorMedia] probe failed', source.key, error);
    }

    this.store.durations.value = new Map(this.store.durations.value).set(source.key, durationMs);
    return durationMs;
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

  /** Adds one more video straight after the selected segment, or at the end. */
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
      const source = await this.pickVideo();
      if (!source) return;
      const durationMs = await this.probe(source);

      this.landOpenTextEdit();
      this.store.clips.value = [...this.store.clips.value, source];
      const segmentId = this.store.newId('seg');
      const afterId = this.store.selectedClip.value?.id ?? null;
      const added = this.store.commit('Add clip', (m) =>
        insertClip(m, defaultClipEdit(source.key, durationMs, segmentId), afterId),
      );
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
      const source = await this.pickVideo();
      if (!source) return null;
      const durationMs = await this.probe(source);

      this.landOpenTextEdit();
      this.store.clips.value = [...this.store.clips.value, source];
      const segmentId = this.store.newId('seg');
      const trackId = this.store.addVideoTrack(defaultClipEdit(source.key, durationMs, segmentId));
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
      const source = await this.pickVideo();
      if (!source) return;
      const durationMs = await this.probe(source);

      this.landOpenTextEdit();
      this.store.clips.value = [...this.store.clips.value, source];
      // The segment is looked up again by id: it may have been deleted while the picker was open.
      const replaced = this.store.commit('Replace', (m) =>
        replaceClipSource(m, target.id, source.key, durationMs),
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

      this.landOpenTextEdit();
      const existing = this.store.manifest.value.music;
      this.store.setMusic(
        {
          uri: picked.uri,
          fileName: picked.fileName || 'Music',
          sourceDurationMs: picked.sourceDurationMs,
          inMs: 0,
          outMs: 0,
          startMs: 0,
          volume: existing?.volume ?? 0.8,
          loop: true,
          fadeOutMs: 400,
        },
        existing ? 'Replace sound' : 'Add sound',
      );
    } finally {
      this.busy.value = false;
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
   * Takes a source back out after the edit refused it. Nothing - not even an undo step - refers to
   * it by this point.
   *
   * Whatever the host allocated to hand it over is the host's to release: a blob URL the editor
   * revoked here would be one it did not create, and on a Capacitor host there is nothing to
   * revoke at all.
   */
  private dropUnusedSource(source: EditorSource): void {
    this.store.clips.value = this.store.clips.value.filter((clip) => clip !== source);
  }

  private async cutFilmstrip(source: EditorSource): Promise<void> {
    if (this.destroyed) return;
    const durationMs = this.store.sourceDurationMs(source.key) || (await this.probe(source));

    // Frames sit at whole multiples of the step so a host that caches them by time hands the same
    // strip back when the editor is opened again.
    const stepMs =
      durationMs > FILMSTRIP_STEP_MS * FILMSTRIP_MAX_FRAMES
        ? Math.ceil(durationMs / FILMSTRIP_MAX_FRAMES)
        : FILMSTRIP_STEP_MS;
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
}
