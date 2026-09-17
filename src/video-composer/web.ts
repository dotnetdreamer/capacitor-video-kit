import { WebPlugin } from '@capacitor/core';

import { describe, extensionOf, fileUri, putFile, resolve, safeSegment } from '../web-runtime/files';

import type {
  CapabilitiesResult,
  CleanupOptions,
  ComposeSpec,
  JobIdOptions,
  JobState,
  PrepareJobOptions,
  PrepareJobResult,
  ProbeOptions,
  ProbeResult,
  StartVoiceRecordingOptions,
  SystemInsetsResult,
  ThumbnailsOptions,
  ThumbnailsResult,
  VoiceRecordingResult,
} from './definitions';
import type { VideoComposerPlugin } from './plugin';
import { webCapabilities } from './web/capabilities';
import { cancelJob, cleanupPendingPost, jobState, startJob, sweepJobs } from './web/jobs';
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

  async startVoiceRecording(options?: StartVoiceRecordingOptions): Promise<void> {
    try {
      await startVoiceRecording(options?.pendingPostId);
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
    const pendingPostId = required(options?.pendingPostId, 'pendingPostId');
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
        const stored = await putFile(pendingPostId, name, blob);
        prepared.push({ key: input.key, uri: stored.url });
      } catch (error) {
        throw coded(`could not take a copy of ${input.key}: ${describe(error)}`, 'unreadable_input');
      }
    }
    return { jobDir: fileUri(pendingPostId, '').replace(/\/+$/, ''), inputs: prepared };
  }

  /** Deletes the folder and forgets its jobs. Idempotent. */
  async cleanup(options: CleanupOptions): Promise<void> {
    const pendingPostId = required(options?.pendingPostId, 'pendingPostId');
    // Stops anything still rendering into the folder, forgets the records, and deletes the files.
    // A render that finished writing after the folder went would put its file back and leave it
    // there for good, which is why the order is not ours to choose.
    await cleanupPendingPost(pendingPostId);
  }
}

/* -------------------------------------------------------------------------------------------- */

/** Keeps the native codes - `permission_denied`, `not_recording`, `already_recording`. */
function asVoiceError(error: unknown): Error {
  if (error instanceof VoiceError) return coded(error.message, error.code);
  return coded(describe(error), 'recording_failed');
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
