/**
 * The `VideoComposer` plugin's call surface.
 *
 * It is a file of its own rather than part of `definitions.ts` for one reason: it is the only thing
 * in the composer's contract that names a Capacitor type, and `definitions.ts` is reached by
 * `choisy-video-kit/editor`, which a web editor imports with no Capacitor anywhere in its tree.
 * Keeping the two apart is what lets that entry point's declarations resolve on their own.
 */
import type { PluginListenerHandle } from '@capacitor/core';

import type {
  CapabilitiesResult,
  EncodeFrame,
  EncodeSupport,
  CleanupOptions,
  ComposeCompletedEvent,
  ComposeFailedEvent,
  ComposeProgressEvent,
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

export interface VideoComposerPlugin {
  /**
   * Starts a render and resolves immediately with the job id. The outcome arrives as a `completed`
   * or `failed` event; both are retained until consumed, and `getState` can always be asked instead.
   */
  compose(spec: ComposeSpec): Promise<{ jobId: string }>;

  /** Stops a running render and emits `failed` with code `cancelled`. Safe on unknown ids. */
  cancel(options: JobIdOptions): Promise<void>;

  /** Rejects with `job_not_found` when the process has been restarted since `compose`. */
  getState(options: JobIdOptions): Promise<JobState>;

  probe(options: ProbeOptions): Promise<ProbeResult>;

  thumbnails(options: ThumbnailsOptions): Promise<ThumbnailsResult>;

  /** Asks for the microphone permission when needed. Rejects `already_recording` / `permission_denied`. */
  startVoiceRecording(options?: StartVoiceRecordingOptions): Promise<void>;

  /** Rejects `not_recording`, or `recording_failed` when the take captured nothing. */
  stopVoiceRecording(): Promise<VoiceRecordingResult>;

  capabilities(): Promise<CapabilitiesResult>;

  /**
   * Which of these frames this platform can actually encode, asked all at once.
   *
   * It exists because a resolution ladder is a promise an editor cannot keep on its own: a phone
   * from four years ago has no 4K encoder, a browser without WebCodecs has whatever `MediaRecorder`
   * will take, and the honest answer differs per device rather than per platform. An editor asks
   * before it offers, so a customer is never given a choice that fails at the last step - after the
   * editing, which is the worst moment to find out.
   *
   * One call for the whole ladder rather than one per rung: every implementation probes the same
   * encoder for all of them, and the answers are cached for the life of the process because they
   * cannot change while the app is running.
   *
   * Never rejects for an unsupported frame. A frame nothing can encode is a `supported: false` row
   * with a reason on it, which is an answer; a rejection would be the plugin saying it could not
   * find out, and there is no such case.
   */
  encodeSupport(options: { frames: EncodeFrame[] }): Promise<{ frames: EncodeSupport[] }>;

  /**
   * How much of the WebView the system bars cover, for a full-screen editor laying tools along the
   * bottom edge. Measured, so it is 0 wherever the WebView already sits clear of the bars.
   */
  systemInsets(): Promise<SystemInsetsResult>;

  /**
   * Moves (when the file is ours) or copies (when it is not) every input into the job folder, so
   * nothing the render or the upload depends on can be revoked or garbage-collected under it.
   */
  prepareJob(options: PrepareJobOptions): Promise<PrepareJobResult>;

  /** Deletes the job folder and forgets its jobs. Idempotent. */
  cleanup(options: CleanupOptions): Promise<void>;

  addListener(
    eventName: 'progress',
    listener: (event: ComposeProgressEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'completed',
    listener: (event: ComposeCompletedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'failed',
    listener: (event: ComposeFailedEvent) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}
