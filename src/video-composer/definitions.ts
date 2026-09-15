/**
 * `choisy-video-composer` - the native video render engine.
 *
 * The contract is deliberately declarative: JS hands over a fully resolved `ComposeSpec` (every
 * time in milliseconds, every URI already pointing at a file the native side can open) and the
 * platform does ALL of the work - demux, decode, colour, overlays, audio mixing, encode, mux.
 * Nothing is rendered in the WebView, and no media bytes ever cross the bridge.
 *
 * Long-running calls do not hold a `PluginCall` open. `compose()` resolves with a `jobId` as soon
 * as the job is registered; the outcome arrives as a `completed` / `failed` event and can always
 * be re-read with `getState({ jobId })`. That is what lets a render survive the Activity being
 * destroyed while a foreground service keeps the process alive.
 */
import type { PluginListenerHandle } from '@capacitor/core';

/* -------------------------------------------------------------------------------------------- */
/* Compose spec                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** How a source frame is fitted into the output rectangle when the aspect ratios differ. */
export type ComposeFit = 'contain' | 'cover';

/**
 * One segment of the output timeline. Split and duplicate are expressed as two entries pointing at
 * the same `uri` with different `inMs`/`outMs`; reorder is simply the array order.
 */
export interface ComposeClip {
  /** Stable key from the edit manifest; echoed back on failures so JS can point at the clip. */
  key: string;
  /** `file://` (usually inside the job folder) or `content://`. */
  uri: string;
  /** Source-relative trim start. */
  inMs: number;
  /** Source-relative trim end; clamped natively to the probed duration. */
  outMs: number;
  /** 0.25..4. Pitch is preserved (D3). */
  speed: number;
  /** 0..1 (D10). */
  volume: number;
  /** Drops this clip's audio entirely, whatever `volume` says. */
  muted: boolean;
  fit: ComposeFit;
}

export interface ComposeOutput {
  /** Rounded down to an even number natively - H.264 encoders refuse odd dimensions. */
  width: number;
  height: number;
  /** Treated as a MAXIMUM frame rate: higher-rate sources are decimated, lower ones are left alone. */
  fps: number;
  /** Computed by the flow, never by the editor (D2). */
  videoBitrate: number;
  audioBitrate: number;
}

/**
 * A CSS Filter Effects operation, in gamma-encoded sRGB, applied in array order to the whole video.
 * Every engine folds the list into ONE 4x5 colour matrix, which is why the maths has to be the CSS
 * maths and not each platform's idea of "saturation" (D5).
 */
export type FilterOp =
  | { op: 'brightness'; amount: number }
  | { op: 'contrast'; amount: number }
  | { op: 'saturate'; amount: number }
  | { op: 'sepia'; amount: number }
  | { op: 'grayscale'; amount: number }
  | { op: 'hueRotate'; degrees: number }
  | { op: 'tint'; rgb: [number, number, number]; alpha: number };

/**
 * A pre-rasterised bitmap placed on the output frame for a time window. Text, emoji and stickers
 * are all rasterised by the caller at output pixel scale (D4), so the native engines never need
 * fonts, text layout or SVG - they place bitmaps and nothing else.
 */
export interface ComposeOverlay {
  id: string;
  /** `data:image/png;base64,...` at output scale. */
  png: string;
  /** Centre position, 0..1, TOP-LEFT origin with y pointing down (the web's coordinate system). */
  cx: number;
  cy: number;
  /** Size in OUTPUT pixels; the caller has already baked its own scale into the PNG. */
  wPx: number;
  hPx: number;
  /** CLOCKWISE degrees, matching CSS `rotate()`. Engines flip the sign where their frame is y-up. */
  rotationDeg: number;
  /** Visible while `startMs <= t < endMs`, on the OUTPUT timeline. */
  startMs: number;
  endMs: number;
  /** 0..1. */
  opacity: number;
}

export interface ComposeMusic {
  uri: string;
  /** Where the track starts on the OUTPUT timeline. */
  startMs: number;
  /** Trim inside the track itself. */
  inMs: number;
  outMs: number;
  /** 0..1. */
  volume: number;
  /** Repeat the trimmed section until the video ends. */
  loop: boolean;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface ComposeVoiceover {
  uri: string;
  /** Where this take starts on the OUTPUT timeline. */
  startMs: number;
  durationMs: number;
  /** 0..1. */
  volume: number;
}

export interface ComposeAudio {
  /** Mutes every clip's own sound; music and voiceovers are unaffected. */
  originalMuted: boolean;
  /** 0..1, multiplied into each clip's own `volume`. */
  originalVolume: number;
  music: ComposeMusic | null;
  voiceover: ComposeVoiceover[];
}

export interface ComposeSpec {
  /** Caller-generated; also the idempotency key - composing twice with one id starts one render. */
  jobId: string;
  /** Selects the job folder the output and any scratch files are written to. */
  pendingPostId: string;
  clips: ComposeClip[];
  output: ComposeOutput;
  /** Ordered; empty means "no colour work at all". */
  filter: FilterOp[];
  overlays: ComposeOverlay[];
  audio: ComposeAudio;
  /** Output-timeline time the poster frame is cut at. */
  posterAtMs: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Results, state and failures                                                                    */
/* -------------------------------------------------------------------------------------------- */

export interface ComposeResult {
  jobId: string;
  /** `file://` path of the finished MP4, inside the job folder. */
  uri: string;
  /** `file://` path of the poster JPEG, or `''` when no frame could be cut. */
  posterUri: string;
  durationMs: number;
  /** DISPLAY dimensions: the rotation flag in the container is already applied (C20). */
  width: number;
  height: number;
  bytes: number;
}

export type ComposeFailureCode =
  | 'unreadable_input'
  | 'encoder'
  | 'muxer'
  | 'interrupted'
  | 'cancelled'
  | 'no_space'
  | 'unsupported'
  | 'unknown';

export interface ComposeError {
  jobId: string;
  code: ComposeFailureCode;
  message: string;
  /** The platform's own error number, for the log. */
  nativeCode?: number;
  /** Set when the failure can be blamed on one clip. */
  clipKey?: string;
  /** Present on `no_space`, so JS can name a figure in the copy. */
  needBytes?: number;
}

export type JobStateName = 'pending' | 'rendering' | 'interrupted' | 'done' | 'failed';

export interface JobState {
  jobId: string;
  state: JobStateName;
  /** 0..1. */
  progress: number;
  result?: ComposeResult;
  error?: ComposeError;
}

/* -------------------------------------------------------------------------------------------- */
/* Other calls                                                                                    */
/* -------------------------------------------------------------------------------------------- */

export interface ProbeOptions {
  uri: string;
}

export interface ProbeResult {
  durationMs: number;
  /** DISPLAY dimensions (rotation applied). */
  width: number;
  height: number;
  /** The container's rotation flag in degrees (0/90/180/270), for the log. */
  rotation: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface ThumbnailsOptions {
  uri: string;
  /** Source-relative times. One output URI per entry, in the same order. */
  timesMs: number[];
  /** Longest edge of the produced JPEG. */
  maxHeight: number;
}

export interface ThumbnailsResult {
  /** `file://` JPEGs in a cache folder; same length and order as `timesMs`. */
  uris: string[];
}

export interface StartVoiceRecordingOptions {
  /**
   * When known, the take is written straight into the job folder. The editor usually has no pending
   * post yet, so the normal case is the cache folder and `prepareJob` moves the file in later.
   */
  pendingPostId?: string;
}

export interface VoiceRecordingResult {
  uri: string;
  durationMs: number;
}

export interface CapabilitiesResult {
  supported: boolean;
  /** Why not, when `supported` is false. */
  reason?: string;
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
  voiceRecording?: boolean;
}

export interface PrepareJobInput {
  /** Clip key, `music`, or `vo:<id>`. Echoed back with the relocated URI. */
  key: string;
  uri: string;
}

export interface PrepareJobOptions {
  pendingPostId: string;
  inputs: PrepareJobInput[];
}

export interface PrepareJobResult {
  /** `file://` of the job folder itself. */
  jobDir: string;
  inputs: PrepareJobInput[];
}

export interface CleanupOptions {
  pendingPostId: string;
}

export interface JobIdOptions {
  jobId: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Events                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export interface ComposeProgressEvent {
  jobId: string;
  /** 0..1. */
  progress: number;
}

export type ComposeCompletedEvent = ComposeResult;
export type ComposeFailedEvent = ComposeError;

/* -------------------------------------------------------------------------------------------- */
/* Plugin                                                                                         */
/* -------------------------------------------------------------------------------------------- */

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
