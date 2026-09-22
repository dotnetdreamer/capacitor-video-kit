/**
 * The `VideoComposer` plugin's call surface.
 *
 * It is a file of its own rather than part of `definitions.ts` for one reason: it is the only thing
 * in the composer's contract that names a Capacitor type, and `definitions.ts` is reached by
 * `@capacitor-video-kit/core/editor`, which a web editor imports with no Capacitor anywhere in its tree.
 * Keeping the two apart is what lets that entry point's declarations resolve on their own.
 */
import type { PluginListenerHandle } from '@capacitor/core';

import type {
  CapabilitiesResult,
  DeleteSoundOptions,
  EncodeFrame,
  EncodeSupport,
  ExtractAudioOptions,
  ExtractAudioResult,
  ListSoundsResult,
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
  SaveToGalleryOptions,
  SaveToGalleryResult,
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

  /**
   * Pulls a video's audio track out into a file of its own and, by default, keeps it in the sound
   * library. Rejects `unreadable_input` for a video that cannot be opened and `no_space` when the
   * disk would not take the copy; a video with no sound in it resolves with `hasAudio: false`.
   */
  extractAudio(options: ExtractAudioOptions): Promise<ExtractAudioResult>;

  /**
   * Every sound kept by [extractAudio], newest first.
   *
   * The library IS the folder: each sound is a file and a small record beside it, so nothing can
   * drift apart the way a list held in the WebView and files held natively would. A record whose
   * file has gone is dropped on the way out rather than reported.
   */
  listSounds(): Promise<ListSoundsResult>;

  /** Deletes one kept sound and its file. Silent about an id that is already gone. */
  deleteSound(options: DeleteSoundOptions): Promise<void>;

  /**
   * Copies a finished video out of the app and into the device's own gallery.
   *
   * The far end of [compose], and the reason it lives here rather than in each host: a render
   * lands in the app's private storage, where no gallery app can see it and nobody holding the
   * phone can reach it - so an app that stops at `compose` has produced a video only it can open,
   * which to a customer is the same as producing none. Every host was therefore writing this, and
   * getting it wrong the same way, because the obvious answers are the broken ones. Copying into
   * the app's external media directory puts the video somewhere Android deletes on uninstall, and
   * announcing it with `ACTION_MEDIA_SCANNER_SCAN_FILE` uses a broadcast that has been a no-op
   * since API 29. What this does instead is a MediaStore insert on Android and a
   * `PHAssetCreationRequest` on iOS, which are the two things the platforms actually index.
   *
   * Customise it through [SaveToGalleryOptions]: which of the two media folders, which album
   * inside it, and what the video is called once it is there. A host that wants none of that can
   * still do its own thing - the editor never calls this, only an app does.
   *
   * Asks for the photo library on iOS, and for storage on Android below API 29; from API 29 the
   * insert is scoped and needs no permission at all. Rejects with a [SaveToGalleryFailureCode].
   */
  saveToGallery(options: SaveToGalleryOptions): Promise<SaveToGalleryResult>;

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
