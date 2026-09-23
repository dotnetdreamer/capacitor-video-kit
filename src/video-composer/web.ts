import { WebPlugin } from '@capacitor/core';

import { describe, extensionOf, fileUri, putFile, resolve, safeSegment } from '../web-runtime/files';

import { downloadBlob } from '../web-runtime/gallery';

import { deleteSound, extractAudio, listSounds, saveSound } from '../web-runtime/sounds';

import type {
  CapabilitiesResult,
  CheckMediaOptions,
  CheckMediaResult,
  DeleteSoundOptions,
  EncodeFrame,
  EncodeSupport,
  CleanupOptions,
  ComposeSpec,
  ExtractAudioOptions,
  ExtractAudioResult,
  GalleryAccessResult,
  GalleryThumbnailResult,
  JobIdOptions,
  ListGalleryVideosResult,
  JobState,
  ListSoundsResult,
  MediaAccessResult,
  PickAudioFileResult,
  PrepareJobOptions,
  PrepareJobResult,
  ProbeOptions,
  ProbeResult,
  ReleaseMediaOptions,
  ResolveGalleryVideoResult,
  RetainMediaOptions,
  RetainMediaResult,
  SaveToGalleryOptions,
  SaveToGalleryResult,
  StageRenderInputResult,
  StartVoiceRecordingOptions,
  SweepMediaOptions,
  SweepMediaResult,
  SystemInsetsResult,
  ThumbnailsOptions,
  ThumbnailsResult,
  VoiceRecordingResult,
} from './definitions';
import type { VideoComposerPlugin } from './plugin';
import { encodableAt, webCapabilities } from './web/capabilities';
import { cancelJob, cleanupBatch, jobState, startJob, sweepJobs } from './web/jobs';
import { probeMedia } from './web/media';
import { validateSpec } from './web/spec';
import { thumbnails as cutThumbnails } from './web/thumbnails';
import { startVoiceRecording, stopVoiceRecording, VoiceError } from './web/voice';

/**
 * The composer, in a browser.
 *
 * This used to be six lines of `unavailable()`, on the reasoning that a second renderer is a second
 * thing to keep in sync. That reasoning still holds, and this file is written to it: nothing here
 * decides anything the native engines decide. The plan, the geometry, the colour matrix and the
 * audio layout are ports of `RenderPlan.kt` and `ColorMatrix.kt` line for line, the spec is checked
 * with the same refusals as `ComposeSpecParser`, and everywhere the three engines could drift, the
 * arithmetic sits in a pure module with a unit test rather than in a shader nobody can assert on.
 *
 * What a browser can now do, and what it still cannot:
 *
 * - `compose` renders and encodes a real MP4, H.264 and AAC, from the same spec a phone takes. It
 *   needs WebCodecs; `capabilities()` says so honestly where that is missing, and `compose` then
 *   fails with `unsupported` rather than pretending.
 * - The render does NOT survive the page. A browser has no foreground service and no WorkManager,
 *   so a tab closed mid-render stops rendering. The RESULT does survive, in IndexedDB, so a reload
 *   after a finished render still reads it back from `getState` - which is more than the native
 *   plugins promise, and is the most a browser can honestly offer.
 * - `prepareJob` copies the inputs into durable storage, which is the same guarantee the native job
 *   folder gives for the same reason: a `blob:` URL from a picker dies with the document, and a post
 *   that outlives the page cannot depend on one.
 *
 * Errors keep the native codes, so a host written against a phone needs no second set of branches.
 */
export class VideoComposerWeb extends WebPlugin implements VideoComposerPlugin {
  constructor() {
    super();
    // Anything the last page was rendering when it went away is marked `interrupted`, and records
    // nobody will read again are dropped. Deliberately not awaited: the plugin is usable while it
    // runs, and a browser with no IndexedDB simply has nothing to sweep.
    void sweepJobs().catch(() => undefined);
  }

  async compose(spec: ComposeSpec): Promise<{ jobId: string }> {
    // A malformed spec is a bug in the caller, not a render outcome, so it fails the call itself
    // rather than arriving later as a `failed` event - exactly as it does natively.
    const checked = validateSpec(spec);
    return await startJob(checked, (event, data) => this.notifyListeners(event, data, true));
  }

  async cancel(options: JobIdOptions): Promise<void> {
    cancelJob(required(options?.jobId, 'jobId'));
  }

  async getState(options: JobIdOptions): Promise<JobState> {
    const jobId = required(options?.jobId, 'jobId');
    try {
      return await jobState(jobId);
    } catch {
      throw coded(`no job with id ${jobId}`, 'job_not_found');
    }
  }

  async probe(options: ProbeOptions): Promise<ProbeResult> {
    const uri = required(options?.uri, 'uri');
    try {
      const probed = await probeMedia(uri);
      return {
        durationMs: probed.durationMs,
        width: probed.width,
        height: probed.height,
        rotation: probed.rotation,
        hasAudio: probed.hasAudio,
        hasVideo: probed.hasVideo,
      };
    } catch (error) {
      throw coded(describe(error), 'unreadable_input');
    }
  }

  async thumbnails(options: ThumbnailsOptions): Promise<ThumbnailsResult> {
    required(options?.uri, 'uri');
    if (!Array.isArray(options?.timesMs)) throw coded('timesMs is required', 'invalid_spec');
    try {
      return await cutThumbnails(options);
    } catch (error) {
      throw coded(describe(error), 'unreadable_input');
    }
  }

  /**
   * A browser has no demuxer a page can reach, so this decodes the video and writes the samples out
   * as WAV: about 10 MB a minute, against well under one for the remux a phone does. It is the only
   * door `decodeAudioData` leaves open, and it is why `keep: false` still writes a file - there is
   * nowhere cheaper to put it.
   */
  async extractAudio(options: ExtractAudioOptions): Promise<ExtractAudioResult> {
    const uri = required(options?.uri, 'uri');
    let audio: Awaited<ReturnType<typeof extractAudio>>;
    try {
      audio = await extractAudio(uri);
    } catch (error) {
      throw coded(describe(error), 'unreadable_input');
    }
    if (!audio) return { hasAudio: false };

    const fileName = options?.fileName || withoutExtension(nameOf(uri)) || 'Sound';
    const saved = await saveSound(audio.blob, {
      fileName,
      durationMs: audio.durationMs,
      sourceName: nameOf(uri) || undefined,
    });
    return {
      hasAudio: true,
      id: saved.id,
      uri: saved.uri,
      fileName: saved.fileName,
      durationMs: saved.durationMs,
      savedAt: saved.savedAt,
    };
  }

  /**
   * The browser's own download, because a page has no gallery to put anything in.
   *
   * `directory` and `album` are read and ignored rather than refused: a caller written for a phone
   * passes them, and rejecting a save over an option a browser has no notion of would make the web
   * the one platform where the same call needs a branch around it.
   */
  async saveToGallery(options: SaveToGalleryOptions): Promise<SaveToGalleryResult> {
    const uri = required(options?.uri, 'uri');

    let blob: Blob;
    try {
      blob = await resolve(uri);
    } catch (error) {
      throw coded(describe(error), 'unreadable_input');
    }

    try {
      downloadBlob(blob, options?.fileName || nameOf(uri) || 'video.mp4');
    } catch (error) {
      throw coded(describe(error), 'unsupported');
    }

    /* The URI it was handed. A page is given no handle on what it just downloaded - the file is
       the person's now, in a folder this code will never learn the name of - so minting one would
       be the web answering a question the other platforms answer truthfully. */
    return { uri };
  }

  /*
   * A page has no library to list: the only videos it can reach are the ones a person hands it
   * through a file input, one pick at a time. So access says `unsupported` - an answer, which a
   * host branches on to offer that input instead - and the three calls that would read the library
   * refuse with the same code the native plugins use for a platform that cannot do a thing.
   */
  async requestGalleryAccess(): Promise<GalleryAccessResult> {
    return { access: 'unsupported' };
  }

  async listGalleryVideos(): Promise<ListGalleryVideosResult> {
    throw coded('a browser has no video library to list', 'unsupported');
  }

  async galleryThumbnail(): Promise<GalleryThumbnailResult> {
    throw coded('a browser has no video library to list', 'unsupported');
  }

  async resolveGalleryVideo(): Promise<ResolveGalleryVideoResult> {
    throw coded('a browser has no video library to list', 'unsupported');
  }

  /*
   * The honest answers rather than refusals, so a host that keeps picks makes the same five calls
   * everywhere and never asks which platform it is on.
   *
   * A page's pick has no durable name AT ALL: it is a `File` behind a `blob:` URL that dies with the
   * document, so `retainMedia` says as much, and a host reads `durable: false` as "keep the bytes",
   * in IndexedDB, which is where a draft in a browser keeps them anyway. `checkMedia` answers true
   * for any name it is given because the question is not the plugin's to answer here: the host holds
   * those bytes, and only the host knows whether they are still there. No name at all is false, as
   * it is natively. Nothing needs a permission to read what the page holds, and the page holds no
   * copy of the kit's to release or to sweep - but the arguments of those two are checked as iOS
   * checks them, where they decide what is deleted, so a host's mistake is refused here too rather
   * than passing on the one platform where it happens to cost nothing. That includes a release's
   * `keep`, which deletes nothing anywhere but must still be a list when it is anything but absent
   * or null.
   */
  async retainMedia(options: RetainMediaOptions): Promise<RetainMediaResult> {
    return { uri: required(options?.uri, 'uri'), durable: false };
  }

  async checkMedia(options: CheckMediaOptions): Promise<CheckMediaResult> {
    const uri = options?.uri ?? '';
    return { exists: uri.length > 0, uri };
  }

  async requestMediaAccess(): Promise<MediaAccessResult> {
    return { granted: true };
  }

  async releaseMedia(options: ReleaseMediaOptions): Promise<void> {
    if (!Array.isArray(options?.uris)) throw coded('uris is required', 'invalid_spec');
    // `undefined` is absent, as it is once a call is JSON on its way to a phone, and so is `null`,
    // which survives that trip and names nothing to spare: Android's `releaseMedia` reads it as left
    // out too, as Capacitor's getters read a JSON null on both phones.
    if (options.keep != null && !Array.isArray(options.keep)) throw coded('keep must be a list of URIs', 'invalid_spec');
  }

  async sweepMedia(options: SweepMediaOptions): Promise<SweepMediaResult> {
    if (!Array.isArray(options?.keep)) throw coded('keep is required', 'invalid_spec');
    if (!Number.isFinite(options?.before)) throw coded('before is required', 'invalid_spec');
    return { removed: 0 };
  }

  /*
   * The three calls a page has no use for, refused with `UNIMPLEMENTED`: the code Capacitor's own
   * `unimplemented()` gives and Android's `call.unimplemented` rejects `pickAudioFile` with, made by
   * `coded` like every other refusal here so a test can stand in for the base class.
   *
   * A browser picks a sound through its own file input, which is what the editor's default does
   * everywhere but iOS, and needs no render input staged: the web engine reads a `blob:` URL as it
   * is, which is why `withNativeRenderInputs` never calls either of the other two off a phone.
   */
  async pickAudioFile(): Promise<PickAudioFileResult> {
    throw coded('pickAudioFile is iOS only: a browser picks a sound through a file input', 'UNIMPLEMENTED');
  }

  async stageRenderInput(): Promise<StageRenderInputResult> {
    throw coded('stageRenderInput is for a native engine: the web engine reads a blob: URL as it is', 'UNIMPLEMENTED');
  }

  async releaseRenderInputs(): Promise<void> {
    throw coded('releaseRenderInputs is for a native engine: the web stages no render inputs', 'UNIMPLEMENTED');
  }

  async listSounds(): Promise<ListSoundsResult> {
    const sounds = await listSounds();
    return {
      sounds: sounds.map(sound => ({
        id: sound.id,
        uri: sound.uri,
        fileName: sound.fileName,
        durationMs: sound.durationMs,
        savedAt: sound.savedAt,
        ...(sound.sourceName ? { sourceName: sound.sourceName } : {}),
      })),
    };
  }

  async deleteSound(options: DeleteSoundOptions): Promise<void> {
    await deleteSound(required(options?.id, 'id'));
  }

  async startVoiceRecording(options?: StartVoiceRecordingOptions): Promise<void> {
    try {
      await startVoiceRecording(options?.batchId);
    } catch (error) {
      throw asVoiceError(error);
    }
  }

  async stopVoiceRecording(): Promise<VoiceRecordingResult> {
    try {
      return await stopVoiceRecording();
    } catch (error) {
      throw asVoiceError(error);
    }
  }

  capabilities(): Promise<CapabilitiesResult> {
    return webCapabilities();
  }

  async encodeSupport({ frames }: { frames: EncodeFrame[] }): Promise<{ frames: EncodeSupport[] }> {
    const answers = await Promise.all(
      (frames ?? []).map(async frame => {
        const { supported, reason } = await encodableAt(frame.width, frame.height, frame.fps);
        return { ...frame, supported, ...(reason ? { reason } : {}) };
      }),
    );
    return { frames: answers };
  }

  /**
   * A browser's own `env(safe-area-inset-*)` is already right, and it is LIVE besides, so the
   * editor's CSS fallback beats anything measured here once and handed back.
   *
   * This call exists because a native WebView gets `env()` wrong in both directions; a browser does
   * not, so the honest measurement is that the system bars cover none of it. `envSafeAreaInsets()`
   * in `host/defaults.ts` is the reading, for a host that wants the numbers anyway.
   */
  async systemInsets(): Promise<SystemInsetsResult> {
    return { top: 0, bottom: 0 };
  }

  /**
   * Copies every input into the post's own folder, so nothing the render or the upload depends on
   * can be revoked under it.
   *
   * On a phone this is about a `content://` grant dying with the Activity. In a browser it is about
   * a `blob:` URL dying with the DOCUMENT, which is the same problem one layer up and has the same
   * answer: take a copy now, under a name that outlives whoever minted the URL.
   *
   * The URIs handed back are `blob:` URLs, because that is what a caller can put straight into a
   * `<video>` or a `ComposeSpec`. The copy behind them is durable, and `jobDir` names the folder
   * `cleanup` deletes.
   */
  async prepareJob(options: PrepareJobOptions): Promise<PrepareJobResult> {
    const batchId = required(options?.batchId, 'batchId');
    const inputs = options?.inputs;
    if (!Array.isArray(inputs)) throw coded('inputs is required', 'invalid_spec');

    const prepared: PrepareJobResult['inputs'] = [];
    for (const [index, input] of inputs.entries()) {
      if (!input?.key || !input?.uri) {
        throw coded(`inputs[${index}] needs a key and a uri`, 'invalid_spec');
      }
      try {
        const blob = await resolve(input.uri);
        const name = `${safeSegment(input.key)}.${extensionOf(input.uri, extensionForType(blob.type))}`;
        const stored = await putFile(batchId, name, blob);
        prepared.push({ key: input.key, uri: stored.url });
      } catch (error) {
        throw coded(`could not take a copy of ${input.key}: ${describe(error)}`, 'unreadable_input');
      }
    }
    return { jobDir: fileUri(batchId, '').replace(/\/+$/, ''), inputs: prepared };
  }

  /** Deletes the folder and forgets its jobs. Idempotent. */
  async cleanup(options: CleanupOptions): Promise<void> {
    const batchId = required(options?.batchId, 'batchId');
    // Stops anything still rendering into the folder, forgets the records, and deletes the files.
    // A render that finished writing after the folder went would put its file back and leave it
    // there for good, which is why the order is not ours to choose.
    await cleanupBatch(batchId);
  }
}

/* -------------------------------------------------------------------------------------------- */

/** Keeps the native codes - `permission_denied`, `not_recording`, `already_recording`. */
function asVoiceError(error: unknown): Error {
  if (error instanceof VoiceError) return coded(error.message, error.code);
  return coded(describe(error), 'recording_failed');
}

/** The last segment of a URI, which for a picked file is the name the customer would recognise. */
function nameOf(uri: string): string {
  const path = uri.split('?')[0]?.split('#')[0] ?? '';
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
}

/** `holiday.mp4` as `holiday`: a sound is not a video, and `.mp4` on one reads as a mistake. */
function withoutExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * An `Error` carrying a `code`, which is what a Capacitor rejection looks like on the other side of
 * the bridge. `WebPlugin.unavailable()` makes one with a fixed code of its own; a host that
 * branches on `error.code` needs the real one.
 */
function coded(message: string, code: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function required(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw coded(`${name} is required`, 'invalid_spec');
  return value;
}

/** A last-resort extension for a blob whose URL carried none - a `blob:` URL never does. */
function extensionForType(mimeType: string): string {
  if (mimeType.startsWith('audio/')) return mimeType.includes('mp4') ? 'm4a' : 'webm';
  if (mimeType.startsWith('image/')) return mimeType.includes('png') ? 'png' : 'jpg';
  return 'mp4';
}
