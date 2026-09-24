/**
 * `videokit-video-composer` - the native video render engine.
 *
 * The contract is deliberately declarative: JS hands over a fully resolved `ComposeSpec` (every
 * time in milliseconds, every URI already pointing at a file the native side can open) and the
 * platform does ALL of the work - demux, decode, colour, overlays, audio mixing, encode, mux.
 * Nothing is rendered in the WebView, and the render itself moves no media bytes across the bridge.
 * The one input that has to cross first is a `blob:` URL the page holds, which no native engine can
 * open: `withNativeRenderInputs` writes each out through `stageRenderInput` before the render and
 * deletes it after (see **Render inputs a page holds**, below).
 *
 * A file is opened by what it holds, not by what it is called. A render input written with no
 * extension - a blob staged from a type nothing names, or music an older host wrote out as
 * `render-input-<uuid>` - or with the wrong one renders on Android, whose Media3 reads the content,
 * and on iOS, which reads the first bytes and opens the file under a name that says what they are.
 *
 * A `file://` URI is best percent-encoded, as every URI the plugin hands out already is. iOS
 * decodes one that holds a `%` once and takes one that holds none literally, so a raw space, `#` or
 * `?` is part of the file's name there, where Android's `Uri` reads the last two as the start of a
 * fragment and a query. iOS also looks for a path into an app container the app no longer has - the
 * container's id can change across an update or a restore - at the same place in the current one,
 * before anything reports the file missing.
 *
 * Long-running calls do not hold a `PluginCall` open. `compose()` resolves with a `jobId` as soon
 * as the job is registered; the outcome arrives as a `completed` / `failed` event and can always
 * be re-read with `getState({ jobId })`. That is what lets a render survive the Activity being
 * destroyed while a foreground service keeps the process alive.
 *
 * iOS has no such service to offer a render. A backgrounded app is denied the GPU and the encoder,
 * and no background time gives them back, so leaving the app - Home, the lock button, a switch to
 * another app - stops every render there and reports it `interrupted` (see [ComposeFailureCode]).
 * What survives is the job record and its answer, exactly as on Android.
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
  /**
   * Source-relative trim end; clamped natively to the probed duration.
   *
   * A trim the clamp leaves empty - an in-point at or past the end of the footage, from a file that
   * turned out shorter than the manifest believed - is planned rather than refused: Android and the
   * web floor the clip at a millisecond past its in-point, and iOS holds the footage's last frame
   * for that long, silent. So the post renders with that clip all but gone, rather than failing on
   * it as `unreadable_input`.
   */
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
   * Every engine renders one - web, Android and iOS - on the base track, on a layer and as a
   * transition's outgoing side. A file that will not decode as a picture fails the render with
   * `unreadable_input`, naming the first clip that uses it. iOS draws a transparent picture over
   * black, because the H.264 it turns each picture into has no alpha.
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
  /**
   * Higher draws later, on top. The base track is 0. Ties break on array order.
   *
   * Required, and `toComposeSpec` always writes it. A hand-built spec that leaves it out is not
   * refused, and the engines do not fill it in alike: Android and iOS take the track's index in
   * `tracks` plus one, the web takes 0. Where no track has one the two come out the same, every
   * layer in array order above the base; a spec that gives some tracks a `z` and not others can
   * stack differently in a browser.
   */
  z: number;
  /** 0..1 over the whole track. Default 1. */
  opacity?: number;
}

export interface ComposeOutput {
  /** Rounded down to an even number natively - H.264 encoders refuse odd dimensions. */
  width: number;
  height: number;
  /**
   * The output frame rate, which the engines do not all read the same way.
   *
   * Android treats it as a MAXIMUM: Media3 decimates a higher-rate source to it and leaves a
   * lower-rate one alone, because nothing in Media3 can raise a rate. The web and iOS render a fixed
   * cadence of one frame every `1 / fps` seconds, drawing whatever frame each source has at that
   * moment, so a lower-rate source has its frames repeated: 24p footage in a 60 fps post is a 60 fps
   * file on those two and a 24 fps one on Android. The picture is the same judder a 24p video has on
   * a 60 Hz screen, and H.264 codes a repeated frame for almost nothing.
   */
  fps: number;
  /**
   * The average rate the video is encoded at, in bits per second. Computed by the flow, never by
   * the editor (D2).
   *
   * Every engine encodes at it, as a variable rate - the encoder spends less on a still shot and
   * more on a busy one - with a key frame at most every second on Android and iOS and every two
   * seconds on the web. The one exception is a retry: an encoder that refuses the request is given
   * one more attempt with settings it picks itself (Android's relaxed encoder, iOS's
   * `AVAssetExportSession` preset), and that file is the encoder's idea of the size, not this one.
   */
  videoBitrate: number;
  /**
   * The AAC rate, in bits per second. An encoder takes a fixed set of rates, so each native engine
   * moves this onto the nearest one it accepts - on iOS that is 64 to 320 kbps for stereo, at
   * 48 kHz - rather than failing the render over it.
   */
  audioBitrate: number;
  /**
   * The most bytes the finished file may have, rounded down to whole bytes. Absent, or anything that
   * does not round down to at least one byte - zero, a negative, a fraction under one, not a finite
   * number - is no ceiling at all, which is what every spec written before this key meant, rather
   * than a ceiling of 0 that would fail every render.
   *
   * It is the HOST's upload limit and not a property of the video, which is why the package sets
   * none of its own: one app posts to a server that refuses a file over 100 MB, and another builds
   * 4K for a different purpose entirely. The editor hands a host's `EditorOutputOptions.maxBytes` to
   * its render as `RenderRequest.maxBytes`, and `toComposeSpec` writes it here when the host passes it
   * on; a host that does not pass it on renders with no ceiling, whatever its quality sheet warned.
   *
   * Every engine holds the file to it the same way. While encoding it watches the output grow and
   * stops the moment it passes the ceiling, deleting what it wrote, rather than spend the rest of the
   * encode on a file the host cannot send. What each one watches is what it can read truthfully:
   * iOS measures the files its `AVAssetWriter` is writing a few times a second (`WriterEngine`);
   * Android adds up the encoded samples its muxer is handed and checks the sum on each progress poll,
   * because Media3's muxer leaves room ahead of the samples that makes the file being written read
   * larger than it will finish (`CountingMuxer`, `SizeCeiling`); and the web counts the packets its
   * encoders hand its muxer, or the recorder's chunks, after every frame, since neither has a file
   * until the end. The finished file is measured once more before `completed`, because a
   * container's index is written last and none of those counts saw it, and because a recorder that
   * hands over its media only when it stops, as Chromium's MP4 one does, is held by that check
   * alone. Either way the render fails `too_large`.
   *
   * Nothing is refused by estimate before the encode starts. The rate above is an average the
   * encoder may spend less than, and a still or dark post often comes in well under a budget the
   * arithmetic says it would break, so the only honest test is the file itself. That includes the
   * one retry an encoder that refused the request is given (see `videoBitrate`): its file is the
   * encoder's idea of the size, and iOS's export session is told the ceiling as its
   * `fileLengthLimit` besides.
   */
  maxBytes?: number;
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
  /**
   * 0..1, applied to the bitmap's ALPHA and never to its colour, once: a white layer at 0.5 over
   * black is mid grey on every engine, which is what the web renderer's `globalAlpha` draws.
   */
  opacity: number;
}

export interface ComposeMusic {
  uri: string;
  /** Where the track starts on the OUTPUT timeline. */
  startMs: number;
  /**
   * Trim inside the track itself. A trim that lies wholly past the end of the file - a replaced
   * sound, a stale duration - is not a failure: every engine renders the post without its music.
   * A file that will not open at all is another matter: it fails the render on Android and iOS,
   * and the web leaves the music out.
   */
  inMs: number;
  outMs: number;
  /** 0..1. */
  volume: number;
  /** Repeat the trimmed section until the video ends. */
  loop: boolean;
  /**
   * Up from silence at the start of the FIRST repetition, linear in amplitude at a slope of
   * `1 / fadeInMs`. A fade longer than that repetition stops short of the level rather than
   * steepening, and the next repetition starts at the level.
   */
  fadeInMs: number;
  /**
   * Down to silence at the end of the LAST repetition, at a slope of `1 / fadeOutMs`, starting
   * `fadeOutMs` before its end or at its start, whichever is later - so a last repetition shorter
   * than the fade ends above silence. That is Android's `planMusic` and the web's `fadeGain`, and
   * iOS draws the same ramps with one exception: music that plays once and whose two fades overlap
   * gives each at most half of its length, from silence to the level and back, where the other two
   * multiply the two curves.
   */
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
  /**
   * Selects the job folder the output and any scratch files are written to, the same folder
   * [PrepareJobOptions.batchId] copies the inputs into and [CleanupOptions.batchId] deletes.
   *
   * Refused as `invalid_spec:batchId` when it is empty, `.` or `..`, on every platform. A phone
   * makes a folder name of the id by turning every character outside `[A-Za-z0-9._-]` into `_`
   * and keeping dots, so those three are the only ids that would name the folder every job's
   * folder is in, or the one above it, rather than a folder of their own; the web refuses them too,
   * so that a spec is refused everywhere or nowhere. Any other id is fine, `../x` included, which
   * is the folder `.._x` like any other.
   */
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

/** Why a render ended without a video: the `code` of a `failed` event and of `JobState.error`. */
export type ComposeFailureCode =
  /** A file the render needed would not open or decode. `clipKey` names the clip when one can be blamed. */
  | 'unreadable_input'
  /** The encoder refused the request, or failed partway through it. */
  | 'encoder'
  /** The finished streams could not be written into a file. */
  | 'muxer'
  /**
   * Stopped from outside, by the platform, with nothing wrong with the post: the same spec
   * composed again can succeed. Android reports it when the foreground service's system budget runs
   * out, the web for a render its page was closed or reloaded in the middle of, and iOS whenever
   * the app is backgrounded mid render - Home, the lock button, a switch to another app - because a
   * backgrounded app is denied the GPU and the encoder and no background time gives them back.
   * Pulling down Control Centre or a call banner leaves the app in the foreground and the render
   * running. iOS reports AVFoundation's own interruptions the same way, the media services being
   * reset among them.
   *
   * Nothing restarts the render by itself. A host that still wants the video composes the same spec
   * again once the app is visible, under a NEW `jobId`: composing with the id of a job that already
   * exists answers with that job, interrupted as it is, rather than starting another.
   */
  | 'interrupted'
  /**
   * `cancel` was called. On Android and iOS that includes a cancel that lands while the file is
   * being closed, whose file is then deleted, so a render the host called off does not turn up as
   * `completed` a moment later.
   */
  | 'cancelled'
  /** The disk would not take the output. `needBytes` says how much it wanted. */
  | 'no_space'
  /**
   * The file would have been larger than [ComposeOutput.maxBytes], found while it was being written
   * or once it was finished, and it has been deleted. The message is `too_large max=<maxBytes>
   * bytes=<bytes>` on every engine. On a render stopped while it was being written, `bytes` is how
   * far it had got - the size of the file on iOS, the media bytes handed to the muxer on Android and
   * the web - and not the size a finished file would have had, which nobody knows without writing
   * it; on the finished-file check it is the finished file's size. The same spec will fail the same
   * way: a lower rate, a smaller frame or a shorter post is what fits.
   *
   * So `bytes` can read BELOW `max`, and a host must not take `bytes > max` as the test for this
   * code. It happens on iOS when a render has fallen back to the preset export session, which is
   * handed the ceiling as its `fileLengthLimit`: a session that meets that limit by stopping at it
   * hands back a file cut short, the render fails `too_large` because the ceiling is what cut it, and
   * `bytes` is the size the file stopped at, which is at or under the limit. The code is the answer;
   * the two numbers are for the log.
   */
  | 'too_large'
  /** Something this platform cannot do at all: a browser with no encoder, a format it has no decoder for. */
  | 'unsupported'
  /**
   * Everything else, with the platform's own words as `message`. On iOS this includes a render
   * whose progress has not moved for 90 seconds, which is stopped with the message `timeout`
   * because something under it has stopped answering; a render that keeps moving, however slowly,
   * is never stopped for time, and Android has no such watch at all.
   */
  | 'unknown';

export interface ComposeError {
  jobId: string;
  code: ComposeFailureCode;
  message: string;
  /** The platform's own error number, for the log. */
  nativeCode?: number;
  /**
   * Set when the failure can be blamed on one clip: the clip whose file would not open, or, for a
   * file that fails partway through the render, the base clip on screen when it did. The second is
   * Android's best guess, and iOS makes it the same way for `unreadable_input`; a decoder reads
   * ahead of the frame being drawn, the sound furthest, so it can name the clip before the damaged
   * one.
   */
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
   *
   * A name and never a path: on Android a `/` or `\` in it becomes `_`, and a name that is `.` or
   * `..` is `video.mp4`, rather than a folder somewhere else on the phone's shared storage.
   */
  fileName?: string;

  /**
   * A folder inside [directory], and the album a gallery app files the video under. Left out, the
   * video goes straight into the directory with nothing around it.
   *
   * Usually the app's name. A plain segment rather than a path: a separator in here is refused
   * with `invalid_spec`, because a nested folder is not something every platform can express - on
   * iOS this is an album in the photo library, which has no folders at all - and so is `.` or `..`,
   * which below Android 10 would name a folder on disk other than one of its own.
   *
   * On iOS the video is filed in the album only with FULL photo library access, because finding an
   * album and making one both need read access, and only when the host's `Info.plist` declares
   * `NSPhotoLibraryUsageDescription`, because iOS terminates an app that asks for read access
   * without it. When read access has never been asked about, the first save with an album asks for
   * it, and that one prompt settles adding as well: answering it with Don't Allow may refuse the
   * save too, with `permission_denied`, where a prompt for adding alone might have been allowed.
   * With add-only or limited access, or without the key, the video is saved to Recents and the
   * album is left out, with no error - a save is not lost over the folder it was to be filed in.
   */
  album?: string;

  /**
   * Defaults to `movies`. A value other than the two is refused with `invalid_spec` on Android and
   * iOS. iOS checks it and then has no use for it: the photo library has no folders.
   */
  directory?: GalleryDirectory;
}

export interface SaveToGalleryResult {
  /**
   * The gallery's own handle on the video, which is not a file path and is not worth parsing: a
   * `content://` row on Android, `ph://` followed by the new asset's local identifier on iOS, and
   * the URI the page was handed on the web, which learns nothing about where a download went.
   * Useful for a follow-up share, and for saying in a log where it went.
   */
  uri: string;
}

/** Why a save did not happen. Narrower than a render's, because far less can go wrong. */
export type SaveToGalleryFailureCode =
  /**
   * An option that cannot be honoured, refused before the file is looked at: no `uri`, a
   * `directory` other than `movies` or `dcim`, or an `album` with a separator in it. The web, which
   * ignores both options, refuses only the missing `uri`.
   */
  | 'invalid_spec'
  /** The person said no to the photo library, or the OS has it switched off for this app. */
  | 'permission_denied'
  /** No file at `uri`, or nothing that can be read as one. */
  | 'unreadable_input'
  /**
   * The disk would not take the video. Android recognises a full disk by the words of the error
   * rather than by its cause, and so reports a real `ENOSPC` as `unreadable_input`.
   */
  | 'no_space'
  /** A browser with no way to hand a file to the person. Web only. */
  | 'unsupported'
  /** Whatever else the platform refused the save for, in its own words as the message. */
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
   * Newest by what each platform keeps: the date a file was added on Android, and on iOS the
   * `creationDate` the Photos app sorts by, since PhotoKit has no public key for the date added.
   * A video downloaded today but shot last year is therefore at the top on Android and down the
   * list on iOS, with or without pictures.
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
  /**
   * What the gallery calls it, extension included. Empty when the platform keeps no name. On iOS
   * the name the item was taken under, `IMG_0042.MOV`, even once it has been edited in Photos -
   * which calls every edit `FullSizeRender` - with the extension of the format that is copied.
   */
  fileName: string;
  /** 0 when the library has not measured it yet; `probe` always can. Always 0 for a picture. */
  durationMs: number;
  /**
   * A picture rather than a video. Always present on Android and iOS, in a video-only list as well;
   * a host that meets an item without it reads it as a video.
   */
  kind?: 'video' | 'image';
}

export interface ListGalleryVideosResult {
  /** Newest first. */
  videos: GalleryVideo[];
  /**
   * How many items the list is drawn from in all - the library's videos, or its videos and
   * pictures together when `images` was set - which is what says whether there is another page.
   */
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
   * What to hand `probe`, `thumbnails` and `compose` for this video, or picture. The MediaStore URI
   * itself on Android; on iOS a copy in the app's own storage, because a photo library asset has no
   * path.
   *
   * The iOS copy is kept where a draft can go on pointing at it, in Application Support rather than
   * Caches: `videokit-gallery/<id>/original/<name>` for an item nobody has edited, whatever else
   * happens to it in Photos, and `videokit-gallery/<id>/<modification stamp>/<name>` for an edited
   * one, so an edit made later is a new copy rather than the old cut served again. A picture is
   * copied in the format it is stored in, a HEIC as a HEIC. The kit never deletes a copy on its own -
   * a draft may still name an older one - so a host that keeps drafts deletes them through
   * `releaseMedia` and `sweepMedia`. A copy an earlier version of the kit made, flat in
   * `videokit-gallery/`, is linked into its new place rather than copied again, so both paths keep
   * working.
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
   *
   * An id `compose` would refuse - empty, `.` or `..` (see [ComposeSpec.batchId]) - is the same as
   * none: the take goes into the cache folder, on every platform. Not refused, because the id only
   * says where the take is kept and the take is still wanted; and not filed under the folder a
   * phone would make of it, because that is some other batch's (`..` would be `__`'s).
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
  /**
   * The job folder the inputs are copied into. Refused as `invalid_spec` before anything is copied
   * when it is missing, `.` or `..` - `batchId is required`, or `batchId cannot be '.' or '..'` -
   * for the reason [ComposeSpec.batchId] gives.
   */
  batchId: string;
  inputs: PrepareJobInput[];
}

export interface PrepareJobResult {
  /** `file://` of the job folder itself. */
  jobDir: string;
  inputs: PrepareJobInput[];
}

export interface CleanupOptions {
  /**
   * The job folder to delete. Refused as `invalid_spec`, with nothing deleted, when it is missing,
   * `.` or `..`, in the words [PrepareJobOptions.batchId] gives: natively those name the folder
   * every post's folder is in, or the one above it.
   */
  batchId: string;
}

export interface JobIdOptions {
  jobId: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Keeping picked media                                                                           */
/* -------------------------------------------------------------------------------------------- */

/*
 * What a native picker hands over is good for the launch that asked for it, and both phones break
 * that promise on a later one, in opposite ways. Android's photo picker hands over a `content://`
 * URI and a read grant, and the grant belongs to the Activity that asked: when the process dies the
 * URI is still a perfectly good string, naming a video the app may no longer open. iOS hands over a
 * file of the app's own and no grant at all, because none is needed - but copied into
 * `Library/Caches`, the one folder the system empties by itself when space runs low, and does so
 * while the app is not running. Either way a draft that stored what the picker said came back to a
 * clip it could not open, and could not tell that clip from one the customer had deleted.
 *
 * So a host that keeps picks past a launch hands each one to `retainMedia` and stores the name it
 * answers, asks `checkMedia` before it calls a stored clip missing, and asks `requestMediaAccess`
 * once per pick for the right Android needs to go on reading. The other two are the cost of the iOS
 * answer: a retained copy is a whole video in a folder nothing empties, so `releaseMedia` deletes
 * the copies a host is done with and `sweepMedia` the ones nothing it keeps still names.
 *
 * The kit's own copies live in two folders under `Library/Application Support` on iOS:
 * `videokit-picked/`, where `retainMedia` moves a pick, and `videokit-gallery/`, where
 * `resolveGalleryVideo` copies a library item. Both calls that delete match a URI to a copy by its
 * path under Application Support rather than by the whole path, because the whole path names the
 * install's container, and a name stored before an update names a container the app no longer has
 * (see [CheckMediaResult.uri]). A list of names to KEEP is read in every form
 * [SweepMediaOptions.keep] lists, because a name misread there loses a clip for good; a list of names
 * to delete only as a file name, because a name misread there costs some space until the next sweep.
 */

export interface RetainMediaOptions {
  /** What the picker handed over: a `file://` URI or a bare absolute path on iOS, a `content://` URI on Android. */
  uri: string;
}

/** What a picked file is called from now on, and whether that name will still open in a later launch. */
export interface RetainMediaResult {
  /**
   * Use THIS from now on, and store it rather than what went in: on iOS a moved file answers with
   * its new `file://` name, and on Android a photo-picker URI answers with the MediaStore URI behind
   * it. Otherwise the URI as it came.
   */
  uri: string;
  /**
   * Whether retaining made `uri` outlive the process. False is not a failure and not a reason to
   * refuse the pick - the file opens for the rest of this launch either way - and for a picker's
   * own name it means a draft that keeps it will find the file missing on a later one, which a host
   * needs telling rather than finding out.
   *
   * On Android it answers what retaining DID, not whether the name will last, so a name that lasts
   * without help - a MediaStore URI, every [resolveGalleryVideo] answer among them, or a file in the
   * app's own storage - comes back as it came and `durable: false`, because neither of Android's
   * routes applies to it (`RetainedMedia.kt`). Such a name needs no retaining. iOS answers true for
   * its counterpart, a file already in the app's container.
   */
  durable: boolean;
}

export interface CheckMediaOptions {
  /** A name `retainMedia` answered, as a host stored it - possibly in an earlier install. */
  uri: string;
}

export interface CheckMediaResult {
  /** Whether the bytes can be read, which is the whole of "is the clip still there". */
  exists: boolean;
  /**
   * The name to open the file by in THIS install, which on iOS is not always the one stored.
   *
   * An iOS app's files live in a container folder, `.../Containers/Data/Application/<UUID>/`, and
   * the UUID is the install's rather than the app's: iOS moves the data into a folder with a new one
   * when the app is updated, restored or installed again over itself, and carries every file across.
   * A path written down before that names a folder that no longer exists, while the file it meant is
   * in the new one under the same name. So iOS looks there, and answers with that path when the file
   * is found, in the same form as the one given - a `file://` URI stays one and keeps its
   * percent-encoding. Anything else answers the URI as it came, so what a host then reports missing
   * is what it stored, and that includes a URL the local server plays the file by, which is not a
   * file name ([currentMediaUri] moves one of those). Android and the web always answer the URI as it
   * came.
   */
  uri: string;
}

export interface MediaAccessOptions {
  /**
   * The right to go on reading PICTURES as well as videos, for a host that let pictures onto the
   * timeline. Android 13 made that a permission of its own, `READ_MEDIA_IMAGES`, which the host
   * declares beside `READ_MEDIA_VIDEO`; the two are asked for together, in one prompt. Defaults to
   * false. Nothing on iOS or the web asks for anything either way.
   */
  images?: boolean;
}

export interface MediaAccessResult {
  /** Whether a retained name will still open once this process has gone. */
  granted: boolean;
}

export interface ReleaseMediaOptions {
  /**
   * Every name a host is done with, sorted or not: a URI that is not one of the kit's own copies is
   * ignored, so a host can hand over everything a deleted draft named without asking which of it
   * came from where.
   *
   * Read on iOS as a file name only - a `file://` URI, encoded or not, or a bare absolute path, moved
   * onto this install's container when it names an earlier one - and a name in any other form, such
   * as the URL the web view plays a copy by, is passed over. That leaves its copy to the next sweep,
   * which costs some space until then; reading a name to DELETE more loosely would be the one way
   * this call could take a copy nobody meant.
   */
  uris: string[];
  /**
   * Names still in use, whose copies stay even where `uris` names them as well.
   *
   * For a host deleting one draft of several. Two drafts can share one pick, so the copies a deleted
   * draft named are not all the host's to delete, and working out which are is where a clip another
   * draft still shows gets deleted. With this the host hands over everything the deleted draft named
   * in `uris` and everything its other drafts name here, and the kit takes the difference.
   *
   * Read on iOS as loosely as [SweepMediaOptions.keep], in every form listed there, so a copy the two
   * lists spell differently - the stored `file://` name in one, the URL the web view plays it by in
   * the other - is still one copy, and stays. Absent is empty, which deletes every copy `uris` names,
   * as the call did before this existed, and `null` is absent, as Capacitor's getters read a JSON
   * null on both phones: it names nothing to spare. Anything else must be an array, and is refused
   * with `invalid_spec` otherwise, because a host that put a name where the list belongs meant to
   * spare that copy, and read as absent it would delete exactly what it was there to keep. Android
   * and the web check it, and delete nothing either way.
   */
  keep?: string[];
}

export interface SweepMediaOptions {
  /**
   * Every name a host's saved state still uses. A copy one of these names is kept.
   *
   * iOS reads each name to the copy it means by where it points below the app's container, so a
   * name keeps its copy in every form a host is likely to have stored it in:
   *  - a `file://` URI, percent-encoded as the kit hands one out or written literally, and the same
   *    as `file://localhost/...` or as `file:/...` with one slash;
   *  - a bare absolute path;
   *  - either of those into an EARLIER install's container, which iOS replaces on an update or a
   *    restore (see [CheckMediaResult.uri]);
   *  - the URL Capacitor's local server plays the copy by, `capacitor://localhost/_capacitor_file_/...`
   *    under whatever scheme and host the app configured;
   *  - a path relative to Application Support, `videokit-picked/<name>` or `videokit-gallery/<id>/...`;
   *  - any of these with a query or a fragment after the path.
   *
   * Put shortly, whatever follows `Library/Application Support/videokit-picked/` or
   * `.../videokit-gallery/` in a name, decoded or as it stands, is a copy kept. A name read more ways
   * than it meant can only keep more, which is the side a sweep has to err on: a name misread here
   * loses a clip for good. A `content://` URI or a `blob:` URL can name no copy, and keeps nothing.
   */
  keep: string[];
  /**
   * Milliseconds since the epoch: only a copy made before this goes. A host passes the moment it
   * began gathering `keep`, so a clip picked while it was reading its drafts - dated after, because
   * `retainMedia` dates a copy as it moves it in - is spared even though no draft names it yet.
   */
  before: number;
}

export interface SweepMediaResult {
  /** How many files went. Always 0 on Android and the web, which keep no copies. */
  removed: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Picking a sound file                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** What [pickAudioFile] answers: a copy of the sound somebody chose, or that they chose none. */
export interface PickAudioFileResult {
  /**
   * True when the picker was closed without a choice, and every other field is then absent. A
   * cancel is an answer rather than a failure, as it is for every picker a host hands the editor.
   */
  cancelled: boolean;
  /**
   * `file://` of the kit's copy, `tmp/videokit-audio/<uuid>.<ext>` with the extension the chosen
   * file had. For reading once, straight away, through Capacitor's local server: the copy is not
   * the kit's to keep (see [pickAudioFile]).
   */
  uri?: string;
  /** The chosen file's own name, extension included, which is what a Sound sheet prints. */
  fileName?: string;
  /**
   * The MIME type iOS knows the file's type by (`UTType.preferredMIMEType`), absent when it knows
   * none. A response from the local server carries no type, and a `Blob` made from one is typed
   * with this, so a render later names its staged copy after it (`withNativeRenderInputs`).
   */
  mimeType?: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Render inputs a page holds                                                                     */
/* -------------------------------------------------------------------------------------------- */

/*
 * A native engine opens files, and a page holds some of what a post is made of as `blob:` URLs,
 * which live in the WebView's memory where neither engine can reach: a sound from the browser's
 * sound library, a track the editor's default picker read in (see [pickAudioFile]). So each is
 * written out as a file of the kit's own before a render, and deleted after it.
 *
 * `stageRenderInput` writes a chunk of base64 per call rather than the whole file at once: a sound
 * the browser extracted is a WAV of about ten megabytes a minute, and as one message it would be
 * held whole, a third bigger, as a string on each side of the bridge. `releaseRenderInputs` deletes
 * what it wrote, and `withNativeRenderInputs` calls it the moment its render has settled, whichever
 * way. Both touch only one folder of the kit's: `tmp/videokit-render-inputs/` on iOS and
 * `cacheDir/videokit-render-inputs/` on Android.
 *
 * A file nobody released - its app killed mid render, or its page reloaded before the render
 * settled, which loses the page that would have released it - is deleted when the plugin next loads,
 * once it is a day old. The plugin loads once per bridge, as the bridge registers it and before the
 * bridge loads its page (iOS `VideoComposerPlugin.load`, Android `VideoComposerPlugin.load`), and a
 * web view reload does not load it again: a reload only resets the bridge it has. In an app with one
 * bridge that is once a launch, so a leftover goes on the first launch a day or more after it was
 * written, and iOS may empty `tmp` sooner while the app is not running. Not sooner than a day,
 * because a bridge can be built again in a process whose render is still reading its inputs - on
 * Android, an Activity made again while the render's foreground service keeps the process - and a
 * day is long past any render.
 *
 * `withNativeRenderInputs`, from `capacitor-video-kit`, is all of this for a whole `ComposeSpec`,
 * and the two calls are public for a host that stages something the spec does not name.
 */

export interface StageRenderInputOptions {
  /**
   * The next bytes of the file, as base64 with no `data:` prefix. Any length; each call is decoded
   * on its own, so a chunk need not end on a multiple of three bytes. `withNativeRenderInputs` sends
   * 1 MiB of bytes per call.
   */
  data: string;
  /**
   * Absent starts a NEW file. Present, the bytes are appended to the file an earlier call answered
   * with, which must be in the render-input folder and still there: a name anywhere else is refused
   * with `invalid_spec`, so this call can never write into a file it did not make, and so is one
   * already released, because a file that lost its first chunk would open as a broken sound.
   */
  uri?: string;
  /**
   * The extension a new file is named with: `wav`, `m4a`. A leading dot is taken as well, and
   * anything but one to sixteen letters and digits after it is refused with `invalid_spec` rather
   * than cleaned, because it becomes part of a path. Checked on every call, used only on the first:
   * the name is settled once the file exists.
   *
   * A name that says what the file holds is the better default rather than a requirement: Android's
   * Media3 reads the content whatever the name, and iOS's `RenderInputs` reads the first bytes and
   * opens a file under a name that says what they are. Absent or empty, the file has no extension.
   */
  extension?: string;
}

export interface StageRenderInputResult {
  /** `file://` of the staged file, the same on every append to it. What the spec names it by. */
  uri: string;
}

export interface ReleaseRenderInputsOptions {
  /**
   * The files [stageRenderInput] answered with. A name outside the render-input folder is ignored,
   * whatever it names, and so is one already gone.
   */
  uris: string[];
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
