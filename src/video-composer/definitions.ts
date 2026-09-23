/**
 * `videokit-video-composer` - the native video render engine.
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
 * the one thing here that names a Capacitor type. This file is reached by `capacitor-video-kit/editor`
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
 * What each parser does guarantee is the pair of rules `normalisePlacement` states: a strip of the
 * rectangle `MIN_ON_FRAME` wide is on the frame, and neither side is larger than
 * `MAX_PLACEMENT_SIZE` of it.
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
  /**
   * A transition INTO this clip from the one before it on the BASE track. Absent is a cut, and
   * absence is every spec written before this field. It is ignored on the first base clip and on
   * every clip of a [ComposeTrack].
   */
  transitionIn?: ComposeTransition;
  /**
   * `uri` is a PICTURE (JPEG, PNG, WebP, HEIC where the platform decodes it), not a video. Absent
   * is a video, which is every spec written before this field.
   *
   * A picture is one frame held for `outMs - inMs` of output time, oriented by its EXIF data like
   * any photo. It has no sound and no speed: an engine renders it silent at 1x whatever `muted`,
   * `volume` and `speed` say, and never clamps its trim against a probed duration, because a still
   * has none. `toComposeSpec` sends one with `inMs` of 0, speed 1 and `muted` set, so an engine that
   * reads those fields as it would for a video gets the same answer. Crop, fit, `rect` and
   * transitions apply to it exactly as they do to a video frame.
   *
   * Supported by the web and Android engines. iOS does not render pictures yet and fails such a
   * spec with `unreadable_input`, naming the clip.
   */
  image?: boolean;
}

/**
 * How one base clip gives way to the next.
 *
 * TIMING. The transition overlaps the two clips. The spec is lowered before it gets here, so an
 * engine does no arithmetic for it: the outgoing clip's `outMs` ALREADY stops where this clip
 * starts, and the part it gave up is [from] - a clip in its own right, the outgoing clip's last
 * moments, with every field the outgoing clip has. The base track therefore stays the flat,
 * non-overlapping sequence it has always been, and [from] is drawn UNDER this clip for its own
 * length, `(from.outMs - from.inMs) / from.speed`, starting where this clip starts. An engine that
 * ignores the field renders a cut and a video of exactly the right length.
 *
 * A clip's own `transitionIn` and the next clip's never overlap on the output timeline: each is
 * held to half of either clip, so one extra sequence holds every [from] of a post.
 *
 * DRAWING, at output time `t` of the window: progress `p = clamp((t - start) / length, 0, 1)`, and
 * every curve read at `p` by straight-line interpolation between the two samples either side
 * (`x = p * (n - 1)`, `i = min(floor(x), n - 2)`, `v = c[i] + (c[i + 1] - c[i]) * (x - i)`). Each
 * side is its clip's WHOLE output frame - the picture cropped, fitted, placed, turned and graded
 * exactly as it would be with no transition, over black - and for output pixel `q` (y down):
 *
 *   1. the side samples its frame at `s = C + R(-rotation) * (q - C - (x * W, y * H)) / scale`, with
 *      `C` the frame centre and the turn clockwise in output pixels. Where `s` is outside the frame
 *      the side is transparent;
 *   2. `pixelate > 0` snaps `s` to the centre of its cell, `pixelate * min(W, H)` wide, the cells
 *      laid out from `C`;
 *   3. the colour at `s`, blurred by a Gaussian of sigma `blur * min(W, H)` with the frame's edges
 *      clamped. `split` reads red at `s + (split * W, 0)` and blue at `s - (split * W, 0)`;
 *   4. `rgb = min(rgb * gain, 1)`, then `rgb = mix(rgb, tint colour, tint)`;
 *   5. the outgoing side is drawn over black, and the incoming side over that at an alpha of
 *      `alpha * mask(q, reveal)` - the mask being 1 when there is none.
 *
 * Extra tracks and overlays are then drawn over the result exactly as they are over any frame.
 */
export interface ComposeTransition {
  /**
   * The catalogue id, `dissolve` or `slide-left`. For a failure message and a log line: an engine
   * draws [curves] and [mask] and must never branch on this.
   */
  kind: string;
  /** The outgoing clip's last moments, drawn under this clip while the transition runs. */
  from: ComposeClip;
  /** The shape the incoming side is revealed through. Absent reveals it everywhere at once. */
  mask?: ComposeTransitionMask;
  /** What [ComposeTransitionSideCurves.tint] moves the outgoing side towards, 0..1 RGB. Absent is black. */
  fromTint?: [number, number, number];
  /** The same for the incoming side. */
  toTint?: [number, number, number];
  curves: ComposeTransitionCurves;
}

/**
 * The shape a mask reveals the incoming side through. Each shape measures a pixel `u`, 0..1 across
 * the frame, in output PIXELS; with `fw = clamp(feather, 0.0005, 0.5)` and
 * `r = reveal * (1 + 2 * fw) - fw`, the mask is `1 - smoothstep(r - fw, r + fw, u)`, and `1 - that`
 * when `invert` is set. `d = (cos angleDeg, sin angleDeg)` (y down), `v = q - C`, and
 * `L = |W cos| + |H sin|`:
 *
 *  - `linear`: `dot(v, d) / L + 0.5` - the edge travels along `d`;
 *  - `circle`: `|v| / |(W / 2, H / 2)|`;
 *  - `diamond`: `(|v.x| + |v.y|) / (W / 2 + H / 2)`;
 *  - `clock`: the clockwise turn from twelve o'clock, `atan2(v.x, -v.y) / 2pi`, wrapped into 0..1;
 *  - `blinds`: `fract((dot(v, d) / L + 0.5) * count)`;
 *  - `split`: `|dot(v, d)| / (L / 2)` - two edges opening from the centre line.
 */
export interface ComposeTransitionMask {
  shape: 'linear' | 'circle' | 'diamond' | 'clock' | 'blinds' | 'split';
  /** Default 0. */
  angleDeg?: number;
  /** `blinds` only. Default 1. */
  count?: number;
  /** Softness of the edge in `u` units. Default 0.01. */
  feather?: number;
  /** Default false. */
  invert?: boolean;
}

/**
 * Every channel a transition moves, each sampled at evenly spaced moments of its window, the first
 * at the start and the last at the end. Every curve present has the same length, 2 to 121 samples.
 * A channel that is absent holds its neutral value for the whole window.
 */
export interface ComposeTransitionCurves {
  /** How much of the incoming side is drawn, 0..1. Neutral 1. */
  alpha?: number[];
  /** How far the mask is open, 0..1. Neutral 1. */
  reveal?: number[];
  from?: ComposeTransitionSideCurves;
  to?: ComposeTransitionSideCurves;
}

/** One side's channels. See [ComposeTransition] for the order they are applied in. */
export interface ComposeTransitionSideCurves {
  /** Offset, a fraction of the output width, positive right. Neutral 0. */
  x?: number[];
  /** Offset, a fraction of the output height, positive down. Neutral 0. */
  y?: number[];
  /** Size about the frame centre. Neutral 1. */
  scale?: number[];
  /** Clockwise degrees about the frame centre. Neutral 0. */
  rotation?: number[];
  /** Gaussian sigma, a fraction of the shorter side. Neutral 0. */
  blur?: number[];
  /** Mosaic cell, a fraction of the shorter side. Neutral 0. */
  pixelate?: number[];
  /** Red right and blue left by this fraction of the width. Neutral 0. */
  split?: number[];
  /** Colour multiplier. Neutral 1. */
  gain?: number[];
  /** 0..1 towards the side's tint colour. Neutral 0. */
  tint?: number[];
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
  batchId: string;
  /**
   * The BASE track. It always starts at 0, and its length is the output's length unless
   * [ComposeSpec.durationMs] asks for more: a track in [ComposeSpec.tracks] running past the OUTPUT
   * is CUT, and one ending early leaves whatever is under it showing.
   */
  clips: ComposeClip[];
  /**
   * How long the output runs, when that is MORE than the base track adds up to. Absent, 0, or any
   * value at or below the base track means "as long as the base track", which is what every spec
   * written before this key meant and what a spec carrying no tail still means.
   *
   * Past the base track's last frame the picture is BLACK. That is not a new kind of frame for any
   * engine to learn: it is exactly what each already draws wherever a layer outlasts what is under
   * it, and the only thing this key changes is that there is now somewhere past the base track for
   * such a moment to exist. Everything else measured against the output - a layer's cut, the music,
   * a voiceover, the poster - is measured against this longer number, unchanged in every other way.
   *
   * An engine that does not honour it renders the base track's length, which is a shorter video than
   * was asked for rather than a wrong one.
   */
  durationMs?: number;
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

export type ComposeFailureCode = 'unreadable_input' | 'encoder' | 'muxer' | 'interrupted' | 'cancelled' | 'no_space' | 'unsupported' | 'unknown';

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

/**
 * A video whose audio track is wanted on its own, and where the result should be kept.
 *
 * The extraction is a REMUX wherever the platform can manage one - the compressed audio is lifted
 * out of the video's container and dropped into an `.m4a` untouched - so it costs a copy of a few
 * megabytes rather than a decode and re-encode of a whole file. iOS re-encodes because
 * `AVAssetExportSession` is the only door it offers to an audio-only file, and a browser has no
 * demuxer a page can reach at all and decodes to WAV (see `web-runtime/sounds`).
 */
export interface ExtractAudioOptions {
  /** `file://` or `content://`. The video to take the sound out of. */
  uri: string;
  /**
   * What the file is called in the library. The source's own name without its extension by default,
   * which is what an editor showing the result wants to print anyway.
   */
  fileName?: string;
  /**
   * True keeps the result for good, in the app's own storage, where nothing sweeps it - which is
   * what a sound library is. False puts it in the cache beside the filmstrip frames, for a caller
   * that only wants the audio for this edit.
   *
   * Defaults to true, because keeping it is the only reason this call exists.
   */
  keep?: boolean;
}

/**
 * The extracted track, or `null` fields on a video with no audio in it.
 *
 * A silent video is not a failure - it is the commonest reason an extraction produces nothing, and
 * a rejection would have the caller showing "something went wrong" for a perfectly good file. So
 * `hasAudio` answers it and the caller says so plainly.
 */
export interface ExtractAudioResult {
  /** False when the video carries no audio track; every other field is then absent. */
  hasAudio: boolean;
  /** The stable id of the kept sound, which is what `deleteSound` names. Absent when `keep` is false. */
  id?: string;
  /** `file://` to the produced audio file. */
  uri?: string;
  fileName?: string;
  /** 0 when the track plays but reports no finite length. */
  durationMs?: number;
  /** Milliseconds since the epoch, as the library recorded it. */
  savedAt?: number;
}

/** One kept sound, as the library reports it. */
export interface SavedSoundResult {
  id: string;
  uri: string;
  fileName: string;
  durationMs: number;
  savedAt: number;
  /** The video it came out of, when the extraction recorded one. */
  sourceName?: string;
}

export interface ListSoundsResult {
  /** Newest first. */
  sounds: SavedSoundResult[];
}

export interface DeleteSoundOptions {
  id: string;
}

/**
 * Which of the device's own media folders a saved video goes into.
 *
 * Two, because those are the two a gallery app looks in and they mean different things to the
 * person holding the phone: `dcim` is where the camera puts things, `movies` is where everything
 * else does. An app that wants its exports sitting beside the customer's own recordings picks
 * `dcim`; one that wants them filed apart leaves the default.
 *
 * Deliberately not a free path. A gallery indexes a handful of directories and nothing else, so a
 * string here would let a caller write somewhere nothing ever looks - which is the exact failure
 * this whole call exists to prevent.
 */
export type GalleryDirectory = 'movies' | 'dcim';

/** Where a finished video should land, and what it should be called once it is there. */
export interface SaveToGalleryOptions {
  /** The video to save: `file://` or an absolute path, as `compose` hands one back. */
  uri: string;

  /**
   * What the video is called in the gallery, EXTENSION INCLUDED - the platforms file it by that
   * name and a gallery prints it. Defaults to the source file's own name.
   */
  fileName?: string;

  /**
   * A folder inside [directory], and the album a gallery app files the video under. Left out, the
   * video goes straight into the directory with nothing around it.
   *
   * Usually the app's name. A plain segment rather than a path: a separator in here is refused,
   * because a nested folder is not something every platform can express - on iOS this is an album
   * in the photo library, which has no folders at all.
   */
  album?: string;

  /** Defaults to `movies`. */
  directory?: GalleryDirectory;
}

export interface SaveToGalleryResult {
  /**
   * The gallery's own handle on the video, which is not a file path and is not worth parsing: a
   * `content://` row on Android, a `ph://` local identifier on iOS, and the object URL the page was
   * handed on the web. Useful for a follow-up share, and for saying in a log where it went.
   */
  uri: string;
}

/** Why a save did not happen. Narrower than a render's, because far less can go wrong. */
export type SaveToGalleryFailureCode =
  /** The person said no to the photo library, or the OS has it switched off for this app. */
  | 'permission_denied'
  /** No file at `uri`, or nothing that can be read as one. */
  | 'unreadable_input'
  /** The disk would not take the copy. */
  | 'no_space'
  /** A browser with no way to hand a file to the person, which is the only web failure. */
  | 'unsupported'
  | 'unknown';

/**
 * How much of the device's video library a host may read.
 *
 * `limited` is the person having chosen a few videos rather than all of them - iOS's "Select Photos"
 * and Android 14's "Select photos and videos". The library calls work there, and simply list fewer.
 * `unsupported` is a platform with no library to read: a browser.
 */
export type GalleryAccess = 'granted' | 'limited' | 'denied' | 'unsupported';

export interface GalleryAccessResult {
  access: GalleryAccess;
}

export interface GalleryAccessOptions {
  /**
   * Ask to read the device's PICTURES as well as its videos, for a host that lists both (see
   * [ListGalleryVideosOptions.images]). On Android 13 and later that is a second permission,
   * `READ_MEDIA_IMAGES`, which the host declares beside `READ_MEDIA_VIDEO`; the two are asked for
   * together, in one prompt. Defaults to false. iOS's photo library grant already covers both.
   */
  images?: boolean;
}

export interface ListGalleryVideosOptions {
  /** How many of the newest to skip. Defaults to 0. */
  offset?: number;
  /** How many to answer with. Defaults to 60, and never more than 500. */
  limit?: number;
  /**
   * List the device's pictures among its videos, newest first together, each one marked with
   * [GalleryVideo.kind]. Defaults to false, which is the video library alone.
   *
   * Android only for now; iOS answers with its videos whatever this says.
   */
  images?: boolean;
}

/** One video - or picture, when they were asked for - in the device's own library. */
export interface GalleryVideo {
  /**
   * The library's handle on it, for [galleryThumbnail] and [resolveGalleryVideo] and nothing else:
   * a `content://` row on Android, a `PHAsset` local identifier on iOS. Not a file - hand
   * [resolveGalleryVideo]'s answer to the rest of the plugin, not this.
   */
  id: string;
  /** What the gallery calls it, extension included. Empty when the platform keeps no name. */
  fileName: string;
  /** 0 when the library has not measured it yet; `probe` always can. Always 0 for a picture. */
  durationMs: number;
  /** A picture rather than a video. Absent is a video, which is every item of a video-only list. */
  kind?: 'video' | 'image';
}

export interface ListGalleryVideosResult {
  /** Newest first. */
  videos: GalleryVideo[];
  /** How many videos the library holds in all, which is what says whether there is another page. */
  total: number;
}

export interface GalleryThumbnailOptions {
  id: string;
  /** The longest edge of the frame, in pixels. Defaults to 384. */
  maxSize?: number;
}

export interface GalleryThumbnailResult {
  /** A `file://` JPEG in a cache folder. */
  uri: string;
}

export interface ResolveGalleryVideoOptions {
  id: string;
}

export interface ResolveGalleryVideoResult {
  /**
   * What to hand `probe`, `thumbnails` and `compose` for this video. The MediaStore URI itself on
   * Android; on iOS a copy in the app's own storage, because a photo library asset has no path.
   */
  uri: string;
  fileName: string;
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
   * When known, the take is written straight into the job folder. The editor usually has no batch
   * yet, so the normal case is the cache folder and `prepareJob` moves the file in later.
   */
  batchId?: string;
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

/** One frame an editor would like to offer: the size and the rate, with no bitrate decided yet. */
export interface EncodeFrame {
  width: number;
  height: number;
  fps: number;
}

/**
 * Whether this platform can encode that frame, and a sentence for a customer when it cannot.
 *
 * `reason` is written to be SHOWN. A resolution that is greyed out with nothing beside it reads as
 * a bug in the app, and "4K is more than this phone's encoder can take" reads as the truth, which
 * is a better thing for someone to be told before they spend a minute editing.
 */
export interface EncodeSupport extends EncodeFrame {
  supported: boolean;
  reason?: string;
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
  batchId: string;
  inputs: PrepareJobInput[];
}

export interface PrepareJobResult {
  /** `file://` of the job folder itself. */
  jobDir: string;
  inputs: PrepareJobInput[];
}

export interface CleanupOptions {
  batchId: string;
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
