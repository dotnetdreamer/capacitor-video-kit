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
 *
 * The `VideoComposerPlugin` interface itself lives next door in `plugin.ts`, and only because it is
 * the one thing here that names a Capacitor type. This file is reached by `choisy-video-kit/editor`
 * for `ComposeSpec` and `FilterOp`, and a web host that imports that entry point has no
 * `@capacitor/core` to resolve, so a single `import type` here becomes a TS2307 inside its
 * `node_modules` the moment it compiles without `skipLibCheck`.
 */

/* -------------------------------------------------------------------------------------------- */
/* Compose spec                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** How a source frame is fitted into the output rectangle when the aspect ratios differ. */
export type ComposeFit = 'contain' | 'cover';

/** A rectangle in normalised coordinates: TOP-LEFT origin, y down - the same system
    ComposeOverlay.cx/cy already uses. A crop is inside 0..1 and a [ComposePlacement] need not be. */
export interface ComposeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a clip's picture is drawn: a rectangle that may also be TURNED.
 *
 * `rotationDeg` is `ComposeOverlay.rotationDeg` in every respect that matters to an engine - the
 * same clockwise degrees CSS `rotate()` means, the same sign flip where a platform's frame is y-up,
 * the same position at the end of the placement maths - so a layer turns with the transform each
 * engine already builds for a sticker.
 *
 * It turns about the rectangle's CENTRE, computed in OUTPUT PIXELS. The centre because that is the
 * only origin a drag survives; output pixels because normalised space is stretched by the frame,
 * and an angle applied in 0..1 coordinates shears a square window into a rhombus on a 720x1280
 * post. An engine therefore resolves the rectangle to pixels first and turns it there, which is
 * also what the preview's CSS does.
 *
 * `fit` is measured BEFORE the turn, in the upright rectangle, and the fitted result is turned as
 * one piece. The picture keeps its size while it is turned, `contain` and `cover` mean what they
 * mean with no angle at all, and `cover` still clips to the rectangle in the rectangle's own turned
 * frame. Fitting into the turned rectangle's bounding box instead would make the video swell and
 * shrink as it turns.
 *
 * Absent is upright, and the builder never writes a `rotationDeg` of 0: a missing key is what tells
 * an engine there is no turn to make, exactly as a missing `rect` tells it there is no placement.
 *
 * The four numbers are FINITE and positive, and that is all. A placement is not held inside the
 * frame the way a crop is held inside its source: a picture may be drawn off the edge of the
 * output, because a customer dragging a video half off the canvas is asking for the overhang to be
 * cut off there. Every engine already cuts at the output frame, so this costs none of them a line.
 * What each parser does guarantee is the pair of rules `normalisePlacement` states: the rectangle's
 * CENTRE is on the frame, and neither side is larger than `MAX_PLACEMENT_SIZE` of it.
 */
export interface ComposePlacement extends ComposeRect {
  /** CLOCKWISE degrees about the rectangle's CENTRE, matching CSS `rotate()`. Absent is upright. */
  rotationDeg?: number;
}

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
  /**
   * The part of the ORIENTED source frame to keep, as a fraction of it. Absent is the whole frame,
   * which is what every spec written before this field meant. Applied BEFORE `fit`, so `fit`
   * measures the cropped picture, not the original.
   */
  crop?: ComposeRect;
  /**
   * Where the cropped picture is drawn on the output frame, and at what angle. Absent is the whole
   * frame the right way up, and `fit` then letterboxes exactly as today. Present, `fit` applies
   * WITHIN this rectangle: the rectangle is the "frame" as far as contain and cover are concerned.
   *
   * The order every engine has to agree on is: orient the source frame, CROP it to `crop`, fit the
   * result into `rect` with `fit`, TURN that fitted rectangle about its own centre by
   * `rect.rotationDeg`, then the colour matrix, then the overlays. Absent crop and absent rect
   * together are exactly the old path, and each engine is expected to take that path unchanged
   * rather than fold the new maths into the old - checked once when the plan is built, never per
   * frame. A `rect` with no `rotationDeg` is the version-3 path in the same way, with no rotation
   * in the transform at all.
   *
   * `crop` is a plain `ComposeRect` and carries no angle. The two fields are the same shape and
   * every parser reads them with one reader, so a `rotationDeg` arriving on a `crop` is to be
   * IGNORED rather than acted on: turning the region sampled out of the source is a different
   * operation on different pixels, and the builder never emits one there.
   */
  rect?: ComposePlacement;
}

/**
 * One extra layer of video. Its own clips are a flat SEQUENCE, exactly like [ComposeSpec.clips]:
 * they play one after another and never overlap EACH OTHER. Overlap happens BETWEEN tracks, and
 * that is the whole reason tracks exist rather than a start time on the clip - one track maps 1:1
 * onto an `EditedMediaItemSequence` on Android and onto one `AVMutableCompositionTrack` on iOS, and
 * both of those hold items that do not overlap. Packing overlapping clips into sequences would
 * otherwise have to happen inside each engine, where two manifests that look the same to a customer
 * could pack differently and quietly disagree about which clip fixes the output's length.
 *
 * A layer's clips are placed by their own [ComposeClip.rect], which is how split screen, picture in
 * picture and any free arrangement of several videos are all expressed: no new geometry, a layout
 * preset or a drag simply writes rectangles.
 */
export interface ComposeTrack {
  /** Stable id from the manifest; echoed on a failure alongside `clipKey`. */
  id: string;
  /** A flat SEQUENCE like [ComposeSpec.clips]: these never overlap EACH OTHER. */
  clips: ComposeClip[];
  /** Where this track's first clip lands on the OUTPUT timeline. Default 0. */
  startMs?: number;
  /** Higher draws later, on top. The base track is 0. Ties break on array order. */
  z: number;
  /** 0..1 over the whole track. Default 1. */
  opacity?: number;
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
  /**
   * The BASE track. It always starts at 0 and ITS length is the output's length: a track in
   * [ComposeSpec.tracks] running past it is CUT, and one ending early leaves the base showing
   * underneath.
   */
  clips: ComposeClip[];
  /**
   * Extra video layers drawn over `clips`, bottom to top by `z`. Absent or empty is exactly today,
   * and every engine is expected to decide that ONCE when it builds its plan rather than per frame
   * - the same discipline `crop` and `rect` ask for. At most `MAX_VIDEO_TRACKS` layers including
   * the base, so at most `MAX_VIDEO_TRACKS - 1` entries here; a spec with more is rejected rather
   * than truncated.
   *
   * That cap is not a decoder budget. A render composites offline, where nothing is racing a frame
   * deadline, so an engine has no structural reason to stop at two and is expected to draw every
   * layer it is given. The cap is there so that an absurd spec fails with a sentence a developer
   * can read instead of an out-of-memory kill, and the number a device can actually PLAY at once is
   * the live preview's business, not this contract's.
   *
   * A secondary track's clips contribute audio exactly as base clips do, through their own
   * `volume`/`muted` and the spec-level `originalMuted`/`originalVolume`.
   */
  tracks?: ComposeTrack[];
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
  /**
   * Cuts the frame that is actually at each time instead of the nearest KEYFRAME. Off by default,
   * because it costs what it is worth: a keyframe seek is a jump, while a precise one decodes every
   * frame from the keyframe before the time asked for. Cameras write a keyframe every one or two
   * seconds, so without this a filmstrip at one frame per second shows each frame once or twice
   * over, and with it a whole strip costs roughly one decode of the clip.
   */
  precise?: boolean;
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

export interface SystemInsetsResult {
  /** CSS pixels of the WebView covered by the status bar. */
  top: number;
  /** CSS pixels of the WebView covered by the navigation bar. */
  bottom: number;
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
