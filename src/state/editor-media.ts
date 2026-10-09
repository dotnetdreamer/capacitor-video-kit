import { effect, signal, untracked } from '@preact/signals-core';
import {
  MAX_LAYERS,
  MAX_VIDEO_TRACKS,
  MIN_LAYER_MS,
  MUSIC_FADE_MS,
  PICTURE_SOURCE_MS,
  audioTrackIdOfClip,
  defaultClipEdit,
  defaultPictureEdit,
  insertClip,
  musicSpeed,
  musicWindow,
  replaceClipSource,
  toComposeSoundSpec,
  totalDurationMs,
  uniqueClipKeys,
  wireAudioEffects,
  type ComposeAudioEffect,
  type ComposeSpec,
  type EditManifest,
} from '../editor';

import { debugWarn } from '../host/debug';
import type { CatalogueSound, EditorSource, PickedAudio, ResolvedEditorHost, SavedSound, SoundCategory } from '../host/host.types';
import { isPictureSource, measurePicture, pictureThumbnail } from '../web-runtime/picture';
import { CopySources, copyGroups, copySoundKey, makeEffectCopy } from '../web-runtime/effect-copy';
import { extractPeaks, type Peaks } from '../web-runtime/waveform';
import type { EditorStore } from './editor-store';
import { buildPlan, type RenderPlan } from '../video-composer/web/plan';
import { clipWaveKey, type AudioEffectCopy, type Filmstrip, type SoundReplaceTarget } from './editor.types';

/** One filmstrip frame per second of source, the TikTok density at the default zoom. */
const FILMSTRIP_STEP_MS = 1000;
/** A long clip spreads its frames out rather than cutting past this many: each one is a decode. */
const FILMSTRIP_MAX_FRAMES = 60;
const FILMSTRIP_MAX_HEIGHT = 160;
/**
 * The most tiles a filmstrip may be cut on exact frames rather than on keyframes, while the clip has
 * no preview copy to cut them from.
 *
 * The cost of an exact frame is per TILE, not per second of clip: the seek decodes every frame from
 * the keyframe before the time asked for, and on the Redmi Note 7 that measures 390-460 ms a tile
 * against 140 ms for a keyframe seek, whatever the clip's length. Six of them is the couple of
 * seconds a customer will wait for the first strip to appear, and at one tile per second they are
 * the short clips where two neighbouring tiles of the same picture are most of the strip. A longer
 * clip starts on keyframe seeks, and five extra seconds of decoding - per clip, with the preview
 * wanting the same decoder - would be felt.
 *
 * But a keyframe seek lands on the keyframe NEAREST the time, which is as often after it as before:
 * a phone keys every one to four seconds, so a tile can show a moment seconds from its own, and in
 * footage cut together - a film, a music video, where an encoder keys at every shot change - the
 * nearest keyframe is the next shot, which the strip then shows a tile or two before the preview
 * reaches it. So a clip with a preview copy ([EditorMediaHost.previewProxy]) is cut exactly however
 * long it is: the host cuts those frames from the copy, which is small and keyed every half second,
 * where an exact frame costs about what a keyframe of the clip does. A strip cut on keyframes before
 * its copy was made is cut again once the copy lands (see [EditorMedia.refineFilmstrip]).
 *
 * Only the first cut of a clip pays either way, where the host caches its frames.
 */
const PRECISE_FILMSTRIP_MAX_FRAMES = 6;

/** How long one file may hold the waveform queue before it is given up on. */
const WAVEFORM_TIMEOUT_MS = 60_000;

/**
 * How long the post has to stay as it is before the copies it wants are asked for. A slider being
 * dragged changes the post on every frame, and every frame's copy would be the sound under the layer
 * decoded and put through it for a moment nobody hears; this is long enough to let the finger go and
 * short enough that the copy it settled on is on its way at once.
 */
const EFFECT_COPY_SETTLE_MS = 250;

/**
 * How long a copy that has been replaced is kept before its file is let go: the preview may still be
 * reading it until its next look at the playhead, a frame or two later.
 */
const EFFECT_COPY_RELEASE_MS = 5000;

/**
 * Past six minutes a source is not decoded for a copy. Decoding is all or nothing, at 32 kHz stereo
 * that is some 90 MB for one file, and Chromium holds it at the file's own rate on the way there. The
 * preview then plays the sounds under the layer as they are; the render has the layer either way.
 */
const MAX_COPY_SOURCE_MS = 6 * 60 * 1000;

/** One copy as [EditorMedia] asks for it: the post's sound as the render plans it, and the layers' windows. */
interface EffectCopyAsk {
  plan: RenderPlan;
  windows: ComposeAudioEffect[];
  soundKey: string;
  effectKey: string;
}

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

  /**
   * The id of the sound being handed to the person right now ([downloadSound]), or null. Its row
   * puts a spinner where its save button was. One at a time: on iOS the save is a sheet the person
   * is still looking at.
   */
  readonly downloadingSound = signal<string | null>(null);

  /**
   * The host's music library ([EditorMediaHost.soundCatalogue]) as it last answered, with the
   * categories that hold no track left out: one tab each on the Sound sheet. Empty until
   * [loadCatalogue] has answered, and empty for good on a host with no catalogue or one that could
   * not be read.
   */
  readonly catalogue = signal<readonly SoundCategory[]>([]);

  /** The catalogue has answered once, a list or a failure, so the sheet can stop waiting on it. */
  readonly catalogueLoaded = signal(false);

  /**
   * The id of the catalogue track being fetched right now ([useCatalogueSound]), or null. Its row
   * puts a spinner where the tick goes, because a track on a server can take seconds to arrive.
   */
  readonly fetchingSound = signal<string | null>(null);

  /**
   * The file each catalogue track became in this edit, by track id: how the sheet ticks the track
   * the post is using, since a catalogue row knows its track and not its file.
   */
  readonly catalogueFiles = signal<ReadonlyMap<string, string>>(new Map());

  /**
   * The Sound sheet's tab the customer last chose in this edit, or null before they chose one. The
   * sheet reopens on it, where it would otherwise pick one by what is in each.
   */
  readonly soundTab = signal<string | null>(null);

  /** Filmstrips are cut one clip at a time: each batch holds a hardware decoder the preview needs. */
  private filmstripQueue: Promise<void> = Promise.resolve();
  private readonly filmstripsPending = new Map<string, Promise<void>>();
  /** The clips whose strip in the store was cut on exact frames; see [refineFilmstrip]. */
  private readonly exactStrips = new Set<string>();
  /**
   * Waveforms too, and for the same reason: decoding a track is a decoder the preview wants back. The
   * copies through an effect wait in the same queue, since each one decodes a whole sound as well, and
   * two at once would be twice the largest allocation the editor makes.
   */
  private waveformQueue: Promise<void> = Promise.resolve();
  private readonly waveformsPending = new Map<string, Promise<void>>();
  /** The layer copies being made now, by layer and keys; see [watchForEffectCopies]. */
  private readonly effectCopiesPending = new Set<string>();
  /** The wait before the copies are asked for; see [EFFECT_COPY_SETTLE_MS]. */
  private effectCopyTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The sources the layer copies are mixed from, kept from one copy to the next. Made at the first
   * copy, so an editor whose post has no layer never builds a context to decode with.
   */
  private copySourcesMade: CopySources | null = null;
  /** How long each source a copy may read runs, by the URL it is read at; see [MAX_COPY_SOURCE_MS]. */
  private copySourceMs = new Map<string, number>();
  private stopWatchingAudio: (() => void) | null = null;
  private stopWatchingEffects: (() => void) | null = null;
  /** See [watchForCopies]: the sources a copy has been asked for. */
  private stopWatchingCopies: (() => void) | null = null;
  private readonly copiesAsked = new Set<string>();
  /** The sources whose copy has had its answer, a copy or none; what [whenCopied] waits on. */
  private readonly copiesAnswered = signal<ReadonlySet<string>>(new Set());
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
      // Nothing on screen draws a waveform: nothing is measured, and the first view that does draw
      // them wakes this again. See [EditorStore.waveformViewers].
      if (this.store.waveformViewers.value === 0) return;
      const manifest = this.store.manifest.value;
      // Each with its length, so a track too long to decode can be turned down before it is read.
      const audio: { uri: string; key: string; durationMs: number }[] = manifest.music
        ? [{ uri: manifest.music.uri, key: manifest.music.uri, durationMs: manifest.music.sourceDurationMs }]
        : [];
      for (const track of manifest.audioTracks ?? []) {
        for (const clip of track.clips) audio.push({ uri: clip.uri, key: clip.uri, durationMs: clip.sourceDurationMs });
      }
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

    this.watchForCopies();
    this.watchForEffectCopies();
  }

  /** Called by the shell when the editor leaves the document. */
  dispose(): void {
    this.destroyed = true;
    this.stopWatchingAudio?.();
    this.stopWatchingAudio = null;
    this.stopWatchingEffects?.();
    this.stopWatchingEffects = null;
    if (this.effectCopyTimer !== null) clearTimeout(this.effectCopyTimer);
    this.effectCopyTimer = null;
    // The copies are this editor's alone: nothing else holds their URLs.
    for (const copy of this.store.audioEffectCopies.peek().values()) URL.revokeObjectURL(copy.url);
    this.store.audioEffectCopies.value = new Map();
    this.copySourcesMade?.clear();
    this.stopWatchingCopies?.();
    this.stopWatchingCopies = null;
    // Wakes every [whenCopied] still waiting, which resolves on finding this destroyed.
    this.copiesAnswered.value = new Set(this.copiesAnswered.peek());
  }

  /* ========================================================================================= */
  /* Preview copies                                                                            */
  /* ========================================================================================= */

  /**
   * Asks the host for each video source's preview copy ([EditorMediaHost.previewProxy]) and puts
   * each one that comes back into [EditorStore.previewUrls], where the preview takes it up.
   *
   * Every source not asked for yet goes out at once, the ones the EDIT uses first, in the order it
   * plays them: the host makes its copies one at a time in the order asked, and answers one it has
   * already made at once - so a clip copied on an earlier visit is back straight away rather than
   * waiting behind another clip's transcode. Each source is asked for once for the life of this
   * object, whatever came of it: a copy the host could not make is not asked for again on every edit.
   */
  private watchForCopies(): void {
    if (!this.host.media.previewProxy) return;
    this.stopWatchingCopies = effect(() => {
      // Read here so a source added or replaced, or one that opens again, wakes this; the asking
      // itself peeks. Read INTO something: a bare `void signal.value` is a read whose value goes
      // nowhere, which the production minifier drops as free of side effects - and the effect is then
      // subscribed to nothing and never runs again.
      const sources = this.store.clips.value.length + uniqueClipKeys(this.store.manifest.value).length + this.store.unreadable.value.size;
      if (sources > 0) untracked(() => this.askForCopies());
    });
  }

  private askForCopies(): void {
    const ask = this.host.media.previewProxy;
    if (this.destroyed || !ask) return;
    for (const source of this.notAskedFor()) {
      this.copiesAsked.add(source.key);
      ask
        .call(this.host.media, source)
        .catch((error: unknown) => {
          debugWarn('[EditorMedia] preview copy failed', source.key, error);
          return null;
        })
        .then(url => {
          if (this.destroyed) return;
          if (url) {
            this.store.previewUrls.value = new Map(this.store.previewUrls.peek()).set(source.key, url);
            this.refineFilmstrip(source);
          }
          this.copiesAnswered.value = new Set(this.copiesAnswered.peek()).add(source.key);
        });
    }
  }

  /**
   * Resolves once each of `keys` that can have a preview copy has had its answer - a copy in
   * [EditorStore.previewUrls], or none to be had - and at once on a host that makes none. A key that
   * is a picture, an unreadable file or no source at all has nothing to wait for. Never rejects.
   *
   * For a host that would rather its preview STARTED on the copies than switched to them mid-play -
   * the template studio, whose every cut is a seek. It bounds the wait itself: a long clip's copy can
   * take longer than anyone should look at a still frame for, and the preview plays the clip itself
   * until its copy lands, as it always could.
   */
  whenCopied(keys: readonly string[]): Promise<void> {
    if (!this.host.media.previewProxy) return Promise.resolve();
    return new Promise<void>(resolve => {
      let stop: (() => void) | null = null;
      let done = false;
      const finish = () => {
        done = true;
        stop?.();
        resolve();
      };
      stop = effect(() => {
        const answered = this.copiesAnswered.value;
        const unreadable = this.store.unreadable.value;
        const waiting = keys.some(key => {
          const source = this.store.clipByKey(key);
          return !!source && !isPictureSource(source) && !this.store.isPictureKey(key) && !unreadable.has(key) && !answered.has(key);
        });
        if (!waiting || this.destroyed) untracked(finish);
      });
      // The effect's first run can finish before `stop` is assigned; it is stopped here then.
      if (done) stop();
    });
  }

  /** The video sources no copy has been asked for: the edit's own, in the order it plays them, then the rest. */
  private notAskedFor(): EditorSource[] {
    const clips = this.store.clips.peek();
    const unreadable = this.store.unreadable.peek();
    const byKey = new Map(clips.map(source => [source.key, source] as const));
    const wanted: EditorSource[] = [];
    for (const key of new Set([...uniqueClipKeys(this.store.manifest.peek()), ...byKey.keys()])) {
      if (this.copiesAsked.has(key) || unreadable.has(key)) continue;
      const source = byKey.get(key);
      if (!source || isPictureSource(source) || this.store.isPictureKey(key)) continue;
      wanted.push(source);
    }
    return wanted;
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
   * Cuts a clip's filmstrip again on exact frames now that its preview copy has landed, when the
   * strip it has was cut on keyframes - see [PRECISE_FILMSTRIP_MAX_FRAMES] for why that strip shows
   * shots before the preview reaches them, and why the copy is what makes exact frames affordable.
   *
   * Queued behind the strips being cut, like any other. Only a clip that HAS a strip is cut again:
   * one still waiting for its first cut finds the copy there when its turn comes, and is cut exactly
   * the first time. The strip it replaces stays up until the exact one is ready, and stays for good
   * if the host cannot give one.
   */
  private refineFilmstrip(source: EditorSource): void {
    this.filmstripQueue = this.filmstripQueue
      .then(() => {
        if (this.destroyed || this.exactStrips.has(source.key) || !this.store.filmstrips.peek().has(source.key)) return;
        return this.cutFilmstrip(source);
      })
      .catch((error: unknown) => {
        debugWarn('[EditorMedia] exact filmstrip failed', source.key, error);
      });
  }

  /* ========================================================================================= */
  /* Copies of the audio effect layers                                                         */
  /* ========================================================================================= */

  /**
   * Makes the preview's copy of what each audio effect layer makes of the post's sound
   * ([EditorStore.audioEffectCopies], `effect-copy.ts`), and lets go of the ones it no longer needs.
   *
   * It follows the MANIFEST, as the waveforms do, so a layer added, a draft reopened with one and an
   * undo that brings one back are all the same case. On every change a copy whose sound is no longer
   * the post's ([AudioEffectCopy.soundKey]) - a sound under its layer moved, the layer moved - is taken
   * away AT ONCE, so the preview plays the sounds as they are rather than a layer over sound that is
   * not there; one that differs only in the layer's effect, sliders or Slow plays on until its new
   * copy lands. New copies are asked for once the post has stayed still ([EFFECT_COPY_SETTLE_MS]).
   */
  private watchForEffectCopies(): void {
    this.stopWatchingEffects = effect(() => {
      const manifest = this.store.manifest.value;
      // The sources' files, which a copy reads: one arriving or moving is a new plan.
      void this.store.clips.value;
      untracked(() => {
        const wanted = this.wantedEffectCopies(manifest);
        this.dropStaleEffectCopies(wanted);
        if (this.effectCopyTimer !== null) clearTimeout(this.effectCopyTimer);
        this.effectCopyTimer = null;
        if (wanted.size === 0) return;
        this.effectCopyTimer = setTimeout(() => {
          this.effectCopyTimer = null;
          if (this.destroyed) return;
          const copies = this.store.audioEffectCopies.peek();
          for (const [id, ask] of this.wantedEffectCopies(this.store.manifest.peek())) {
            const made = copies.get(id);
            if (!made || made.soundKey !== ask.soundKey || made.effectKey !== ask.effectKey) this.loadEffectCopy(id, ask);
          }
        }, EFFECT_COPY_SETTLE_MS);
      });
    });
  }

  /**
   * The copies the layers the post plays want now - one for each run of layers close enough to share
   * one ([copyGroups]) - by their layers' ids, with what it takes to make each. Empty for a post with no
   * layer, which costs nothing more, and for one whose sound cannot be laid out here (a clip whose file
   * is gone), which then plays as it is.
   */
  private wantedEffectCopies(manifest: EditManifest): Map<string, EffectCopyAsk> {
    const wanted = new Map<string, EffectCopyAsk>();
    const layers = manifest.audioEffects ?? [];
    if (layers.length === 0) return wanted;
    let plan: RenderPlan;
    try {
      plan = buildPlan(this.readableSoundSpec(manifest), new Map());
    } catch (error) {
      debugWarn('[EditorMedia] the sound under the audio effects could not be laid out', error);
      return wanted;
    }
    const totalMs = totalDurationMs(manifest);
    const played = layers.flatMap(layer => wireAudioEffects([layer], totalMs).map(window => ({ id: layer.id, window })));
    for (const group of copyGroups(played.map(({ id, window }) => ({ ...window, id })))) {
      const windows = group.map(({ id: _id, ...window }) => window);
      wanted.set(group.map(one => one.id).join(','), {
        plan,
        windows,
        soundKey: copySoundKey(plan, windows),
        effectKey: JSON.stringify(windows.map(window => [window.speed ?? 1, window.effect ?? null])),
      });
    }
    return wanted;
  }

  /**
   * The post's sound as the wire carries it, every file at a URL this page can read - a clip at the
   * one the preview plays, a sound and a take through the host's `fileUrl`, as the waveforms read them
   * - with how long each runs noted for [MAX_COPY_SOURCE_MS].
   */
  private readableSoundSpec(manifest: EditManifest): ComposeSpec {
    const uriByKey = new Map<string, string>();
    const lengths = new Map<string, number>();
    for (const source of this.store.clips.peek()) {
      const url = source.playbackUrl || (source.sourcePath ? this.host.platform.fileUrl(source.sourcePath) : '');
      if (!url) continue;
      uriByKey.set(source.key, url);
      lengths.set(url, this.store.sourceDurationMs(source.key));
    }
    const spec = toComposeSoundSpec(manifest, uriByKey);
    const readable = (uri: string, durationMs: number): string => {
      const url = this.host.platform.fileUrl(uri);
      lengths.set(url, Math.max(lengths.get(url) ?? 0, durationMs));
      return url;
    };
    const sounds = [...(manifest.music ? [manifest.music] : []), ...(manifest.audioTracks ?? []).flatMap(track => track.clips)];
    const soundMs = new Map(sounds.map(sound => [sound.uri, sound.sourceDurationMs]));
    const audio = spec.audio;
    if (audio.music) audio.music = { ...audio.music, uri: readable(audio.music.uri, soundMs.get(audio.music.uri) ?? 0) };
    if (audio.musicTracks) audio.musicTracks = audio.musicTracks.map(track => track.map(sound => ({ ...sound, uri: readable(sound.uri, soundMs.get(sound.uri) ?? 0) })));
    audio.voiceover = audio.voiceover.map(take => ({ ...take, uri: readable(take.uri, take.durationMs) }));
    this.copySourceMs = lengths;
    return spec;
  }

  /**
   * Takes away every copy no longer to be played: one for a layer the post has not got, or no longer
   * plays, and one made from other sound than the post's now. Its file is let go a moment later
   * ([EFFECT_COPY_RELEASE_MS]).
   */
  private dropStaleEffectCopies(wanted: ReadonlyMap<string, EffectCopyAsk>): void {
    const copies = this.store.audioEffectCopies.peek();
    const stale = [...copies].filter(([id, copy]) => wanted.get(id)?.soundKey !== copy.soundKey);
    if (stale.length === 0) return;
    const next = new Map(copies);
    for (const [id, copy] of stale) {
      next.delete(id);
      this.releaseCopyLater(copy);
    }
    this.store.audioEffectCopies.value = next;
  }

  /**
   * Makes one copy into `store.audioEffectCopies`, queued behind every decode already waiting. Asking
   * for one already on its way joins it, and one the post has moved on from by the time its turn comes
   * is not made at all. A copy that could not be made leaves the layer's sounds playing as they are.
   */
  private loadEffectCopy(id: string, ask: EffectCopyAsk): void {
    const key = `${id}\n${ask.soundKey}\n${ask.effectKey}`;
    if (this.effectCopiesPending.has(key)) return;
    this.effectCopiesPending.add(key);
    const still = (): boolean => {
      const now = this.wantedEffectCopies(this.store.manifest.peek()).get(id);
      return !!now && now.soundKey === ask.soundKey && now.effectKey === ask.effectKey;
    };
    const job = this.waveformQueue
      .then(async () => {
        if (this.destroyed || !still()) return;
        this.copySources.begin();
        const abort = new AbortController();
        // Raced against the waveform's clock, for its reason: everything else waits behind this.
        const timer = setTimeout(() => abort.abort(), WAVEFORM_TIMEOUT_MS);
        let made: Awaited<ReturnType<typeof makeEffectCopy>> = null;
        try {
          made = await makeEffectCopy(ask.plan, ask.windows, this.copySources, abort.signal);
        } finally {
          clearTimeout(timer);
        }
        if (!made) {
          debugWarn('[EditorMedia] no copy of the audio effect', id);
          return;
        }
        if (this.destroyed || !still()) return;
        const copy: AudioEffectCopy = { url: URL.createObjectURL(made.blob), startMs: made.startMs, endMs: made.endMs, soundKey: ask.soundKey, effectKey: ask.effectKey };
        const copies = this.store.audioEffectCopies.peek();
        const was = copies.get(id);
        if (was) this.releaseCopyLater(was);
        this.store.audioEffectCopies.value = new Map(copies).set(id, copy);
      })
      .catch((error: unknown) => {
        debugWarn('[EditorMedia] the copy of the audio effect failed', id, error);
      })
      .finally(() => this.effectCopiesPending.delete(key));
    this.waveformQueue = job;
  }

  private get copySources(): CopySources {
    return (this.copySourcesMade ??= new CopySources(uri => (this.copySourceMs.get(uri) ?? 0) > MAX_COPY_SOURCE_MS));
  }

  /** Lets go of a copy's file once nothing can still be reading it; see [EFFECT_COPY_RELEASE_MS]. */
  private releaseCopyLater(copy: AudioEffectCopy): void {
    setTimeout(() => URL.revokeObjectURL(copy.url), EFFECT_COPY_RELEASE_MS);
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
      const replaced = this.store.commit('Replace', m => replaceClipSource(m, target.id, source.key, durationMs, this.host.editing.replaceKeepsLength, isPictureSource(source)));
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
   * buttons, and with `replace` a sound row's Replace, whose pick goes in place of that sound.
   *
   * A host with a library or a catalogue gets the Sound sheet, where extracting one is the first
   * thing on it and the catalogue's categories are tabs. A host with neither gets the file picker
   * straight away, exactly as every host did before the library existed - a sheet whose only content
   * is one button is worse than the button.
   */
  openSound(replace: SoundReplaceTarget | null = null): void {
    this.store.pause();
    if (this.host.media.sounds || this.host.media.soundCatalogue) {
      this.store.openSoundSheet(replace);
    } else {
      // No sheet to hold the choice, so it is held for the picker's one answer; see [pickMusic].
      this.store.soundReplaceTarget.value = replace;
      void this.pickMusic();
    }
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
      // A Replace with no sheet to stay open on was for this one answer, a pick or a cancel.
      if (this.store.panel.value !== 'sound') this.store.soundReplaceTarget.value = null;
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

  /** Whether the host's library can hand a sound to the person, which puts a download button on every row. */
  get canDownloadSounds(): boolean {
    return typeof this.host.media.sounds?.download === 'function';
  }

  /**
   * Hands a copy of one kept sound to the person, outside the app: the host's library decides where
   * ([EditorSoundLibrary.download]) - a browser's download, a phone's Downloads, or the save sheet
   * iOS shows. Nothing about the post changes, and the sheet stays open.
   *
   * A person who backed out of a save sheet is told nothing: they saw the sheet and chose. A
   * second tap while one is under way is ignored rather than queued, because on iOS the first is a
   * sheet that is still up.
   */
  async downloadSound(sound: SavedSound): Promise<void> {
    const library = this.host.media.sounds;
    if (!library?.download || this.downloadingSound.value !== null) return;
    this.store.pause();
    this.downloadingSound.value = sound.id;
    try {
      const saved = await library.download(sound);
      if (this.destroyed || !saved) return;
      this.store.showToast('Sound downloaded');
      this.store.haptic('light');
    } catch (error) {
      debugWarn('[EditorMedia] sound download failed', sound.id, error);
      if (this.destroyed) return;
      this.store.showToast('That sound could not be downloaded. Try again.', 2400);
      this.store.haptic('warning');
    } finally {
      if (!this.destroyed) this.downloadingSound.value = null;
    }
  }

  /** Whether the host keeps the customer's own sounds, which is what the sheet's Saved tab lists. */
  get hasSoundLibrary(): boolean {
    return !!this.host.media.sounds;
  }

  /**
   * Reads the host's music library into [catalogue]. The Sound sheet asks on every opening and the
   * host keeps the answer ([EditorSoundCatalogue.categories]), so the second opening costs nothing.
   *
   * A catalogue that will not answer - offline, or a server that has none yet - leaves the tabs as
   * they were and says so in the console. The saved sounds and both ways in are still there, and a
   * red bar would only tell a customer about a library they never asked for.
   */
  async loadCatalogue(): Promise<void> {
    const catalogue = this.host.media.soundCatalogue;
    if (!catalogue) {
      this.catalogueLoaded.value = true;
      return;
    }
    try {
      const categories = await catalogue.categories();
      if (this.destroyed) return;
      this.catalogue.value = categories.filter(category => category.sounds.length > 0);
    } catch (error) {
      debugWarn('[EditorMedia] sound catalogue failed', error);
    } finally {
      if (!this.destroyed) this.catalogueLoaded.value = true;
    }
  }

  /**
   * Puts a catalogue track on the post: the host fetches it, or finds it where it kept it, and it
   * goes on as a saved sound does. A track that cannot be had is said once, and the post and the
   * sheet stay as they were, so a second tap can try again.
   *
   * It holds [busy] meanwhile, as a picker does: the file arriving is a change on its way into the
   * manifest, and Next must not build a post that is about to have a sound added under it.
   */
  async useCatalogueSound(sound: CatalogueSound): Promise<void> {
    const catalogue = this.host.media.soundCatalogue;
    if (!catalogue || this.busy.value) return;
    this.store.pause();
    this.busy.value = true;
    this.fetchingSound.value = sound.id;
    try {
      let file: PickedAudio;
      try {
        file = await catalogue.file(sound);
      } catch (error) {
        debugWarn('[EditorMedia] catalogue track failed', sound.id, error);
        if (this.destroyed) return;
        this.store.showToast('Track not downloaded. Check your connection', 2400);
        this.store.haptic('warning');
        return;
      }
      if (this.destroyed) return;
      this.catalogueFiles.value = new Map(this.catalogueFiles.value).set(sound.id, file.uri);
      this.landOpenTextEdit();
      this.useTrack(file.uri, sound.title || file.fileName || 'Music', file.sourceDurationMs || sound.durationMs);
    } finally {
      if (!this.destroyed) {
        this.fetchingSound.value = null;
        this.busy.value = false;
      }
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
   * From a Replace it goes in place of that sound ([EditorStore.soundReplaceTarget]). Otherwise each
   * pick is another sound on the output timeline. The selected audio lane is tried first, directly
   * after its selected clip; otherwise the playhead is used. When that lane has no room, the store
   * finds another lane or opens one.
   */
  private useTrack(uri: string, fileName: string, sourceDurationMs: number): void {
    this.landOpenTextEdit();
    const replacing = this.store.soundReplaceTarget.value;
    if (replacing?.kind === 'audio' && this.store.replaceAudioClip(replacing.id, { uri, fileName, sourceDurationMs })) return;
    if (replacing?.kind === 'music' && this.store.manifest.value.music) {
      this.replaceMusic(uri, fileName, sourceDurationMs);
      return;
    }
    const selected = this.store.selectedAudio.value;
    const legacy = this.store.selection.value?.kind === 'music' ? this.store.manifest.value.music : null;
    const anchor = selected ?? legacy;
    const target = selected ? audioTrackIdOfClip(this.store.manifest.value, selected.id) : null;
    const total = this.store.totalMs.value;
    // Up to a whole millisecond: a sped-up sound rarely ends on one, and a start rounded down from its
    // end would overlap it by the fraction and be turned away from its lane.
    const selectedEnd = anchor ? Math.ceil(musicWindow(anchor, total).endMs) : 0;
    const at = anchor && selectedEnd + MIN_LAYER_MS <= total ? selectedEnd : Math.min(this.store.playheadMs.value, Math.max(0, total - Math.max(MIN_LAYER_MS, sourceDurationMs)));
    const sound = {
      uri,
      fileName,
      sourceDurationMs,
      inMs: 0,
      outMs: 0,
      startMs: at,
      endMs: 0,
      volume: 0.8,
      loop: false,
      fadeOutMs: MUSIC_FADE_MS,
    };
    if (target && this.store.addAudioClip(sound, target)) return;
    if (this.store.addAudioClip(sound)) return;
    this.store.showToast('There is no room for that audio on this timeline');
    this.store.haptic('warning');
  }

  /**
   * An older edit's one sound swapped for another, as Replace did it before there were lanes. The
   * volume, the two fades and the speed are carried over: they are what the volume and speed sheets
   * set by hand, and having them reset every time a different song is tried is the difference between
   * comparing two tracks and setting the sound up twice. A lane's Replace keeps them too.
   */
  private replaceMusic(uri: string, fileName: string, sourceDurationMs: number): void {
    const existing = this.store.manifest.value.music;
    if (!existing) return;
    const fadeInMs = existing.fadeInMs ?? 0;
    const speed = musicSpeed(existing);
    this.store.setMusic(
      {
        uri,
        fileName,
        sourceDurationMs,
        inMs: 0,
        outMs: 0,
        startMs: 0,
        endMs: 0,
        volume: existing.volume,
        loop: true,
        ...(fadeInMs > 0 ? { fadeInMs } : {}),
        fadeOutMs: existing.fadeOutMs,
        ...(speed !== 1 ? { speed } : {}),
      },
      'Replace sound',
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
    // Exact while the strip is short, and at any length once the clip's preview copy is there to cut
    // the frames from: see [PRECISE_FILMSTRIP_MAX_FRAMES] for both.
    const precise = durationMs > 0 && (count <= PRECISE_FILMSTRIP_MAX_FRAMES || this.store.previewUrls.peek().has(source.key));

    let strip: Filmstrip | null = null;
    try {
      const urls = await this.host.media.thumbnails({ source, timesMs, maxHeight: FILMSTRIP_MAX_HEIGHT, precise });
      if (urls.length > 0) strip = { stepMs, urls: [...urls] };
    } catch (error) {
      debugWarn('[EditorMedia] thumbnails failed', source.key, error);
    }
    // Only for a clip with no strip at all: a keyframe strip the exact cut could not replace is a
    // better picture of the clip than one frame of it.
    if (!strip && source.thumbnailUrl && !this.store.filmstrips.peek().has(source.key)) {
      // One frame standing for the whole clip: a step as long as the clip puts every tile on it.
      strip = {
        stepMs: Math.max(FILMSTRIP_STEP_MS, durationMs),
        urls: [this.host.platform.fileUrl(source.thumbnailUrl)],
      };
    } else if (strip && precise) {
      this.exactStrips.add(source.key);
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
