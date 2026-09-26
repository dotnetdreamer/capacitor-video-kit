import CoreMedia
import Foundation

/// The validated value model the whole render pipeline compiles against.
///
/// Nothing in here is a picture of the wire. `ComposeSpecParser` owns that job and hands back these
/// types with every clamp already applied, so a consumer never has to ask "has this been clamped
/// yet" and never re-clamps a second time with slightly different bounds. Every type is a struct or
/// enum of value types, which makes `Sendable` free; it is declared anyway because the spec crosses
/// into a `Task.detached` and the day the package flips to the Swift 6 language mode a missing
/// conformance stops being a warning.

/// How a source frame is fitted into the output rectangle when the aspect ratios differ.
enum Fit: String, Sendable { case contain, cover }

/// A rectangle in normalised coordinates: 0...1 with a TOP-LEFT origin and y pointing DOWN, which
/// is the web's system and the one `ComposeOverlay.cx/cy` already uses. Core Image is y-UP, so
/// `Placement` is the one place these get flipped, exactly as `OverlayBitmap` is for an overlay.
///
/// For a CROP the parser guarantees `w > 0`, `h > 0` and `x + w <= 1`, `y + h <= 1`, so a consumer
/// never has to range check one. A `ComposePlacement` is finite and positive but sits where it
/// likes; see there. Doubles rather than CGFloat because everything on the wire is a Double here
/// and the conversion belongs at the one point of use.
struct ComposeRect: Sendable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

/// Where a clip's picture is drawn: a rectangle that may also be TURNED.
///
/// The four numbers are a `ComposeRect`'s and are finite and positive like one, but they do not sit
/// inside the frame and are not meant to. A picture may be drawn off the edge of the output, and a
/// customer who drags a video half off the canvas is asking for exactly that - the frame cuts the
/// overhang off, here as in the preview. What the parser guarantees instead is that the rectangle
/// keeps a strip of itself on the frame, `MIN_ON_FRAME` wide, and that neither side is larger than
/// `MAX_PLACEMENT_SIZE` of the frame.
///
/// What is new is the angle, and it is the angle
/// `ComposeOverlay.rotationDeg` already carries in every respect that matters: CLOCKWISE degrees as
/// CSS `rotate()` means them, about the rectangle's CENTRE, and NOT clamped, because a caller may
/// legitimately send 720 and sin/cos reduce it.
///
/// nil is upright, which is what every spec written before this field means. It stays nil rather
/// than becoming a 0 for the same reason `ComposeClip.crop` stays nil: the builder asks this ONCE,
/// when the plan is built, to decide whether a rotation belongs in the transform at all, and a 0
/// written here would put a rotation nobody asked for into every one of those specs.
struct ComposePlacement: Sendable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let rotationDeg: Double?

    /// The four numbers on their own, for the placement maths, which resolves a rectangle into
    /// output pixels and knows nothing about angles. The turn is applied to the result of that, in
    /// pixels: applied to these normalised fractions instead it would shear a square window into a
    /// rhombus on any frame that is not square.
    var bounds: ComposeRect { ComposeRect(x: x, y: y, w: w, h: h) }
}

struct ComposeClip: Sendable {
    /// The SEGMENT id from the edit manifest, not the host clip key. It is echoed back verbatim as
    /// `clipKey` on a failure and JS maps it back to its own clip with `hostKeyForSegment`.
    let key: String
    let uri: String
    let inMs: Int64
    let outMs: Int64
    let speed: Double          // already clamped 0.25...4.0
    let volume: Double         // already clamped 0...1
    let muted: Bool
    let fit: Fit
    /// The part of the ORIENTED source frame to keep, as a fraction of it. Applied BEFORE `fit`, so
    /// `fit` measures the cropped picture and not the original.
    ///
    /// nil is the whole frame, which is what every spec written before this field meant. It stays
    /// nil rather than being filled in with a 0,0,1,1 default on the way through the parser: nil is
    /// exactly what the compositor's fast path tests for, and a default written here would quietly
    /// take every one of those specs off it.
    let crop: ComposeRect?
    /// Where the cropped picture is drawn on the OUTPUT frame, and at what angle. nil is the whole
    /// frame upright and `fit` then letterboxes as it always has; present, `fit` applies WITHIN this
    /// rectangle, which is the "frame" as far as contain and cover are concerned. nil for the same
    /// reason as `crop`.
    ///
    /// The order every engine agrees on: orient the source, CROP to `crop`, fit the result into this
    /// rectangle with `fit`, TURN that fitted rectangle about its own centre by `rotationDeg`, then
    /// the colour matrix, then the overlays. The fit is measured BEFORE the turn, in the upright
    /// rectangle, so the picture keeps its size as the customer spins it instead of swelling to fill
    /// a growing bounding box.
    let rect: ComposePlacement?
    /// A transition INTO this clip from the one before it on the BASE track, or nil for a cut.
    ///
    /// Only ever set on a base clip from the second on. The parser never reads the key on the first
    /// base clip, on a layer's clips or on a transition's own `from`, which is where `definitions.ts`
    /// says an engine ignores it. nil for the reason `crop` is nil: a post without transitions is
    /// what the builder tests for, once, to keep the single-timeline path it has always taken.
    let transitionIn: ComposeTransition?
    /// `uri` is a PICTURE rather than a video: one frame, turned upright by its EXIF orientation and
    /// held for `outMs - inMs` of output time. false is a video, which is every spec written before
    /// this field.
    ///
    /// The parser has already made a picture silent at 1x - `speed` is 1 and `muted` is true
    /// whatever the wire said - so the builder reads its timing and its sound off the fields it
    /// reads for any clip, which is how Android's `parseClip` arranges it too. The one question
    /// left for this flag is where the frame comes from: `PictureStills` turns each picture into a
    /// short still-frame video before the composition is laid, and from there on it is footage like
    /// any other, cropped, fitted, placed and transitioned by code that never asks what it was.
    let image: Bool
}

/// How one base clip gives way to the next: `ComposeTransition` in `definitions.ts`, whose doc
/// comments are the drawing contract every engine implements and are not repeated here.
///
/// The spec arrives LOWERED, so this engine does no arithmetic for the overlap. The outgoing clip's
/// `outMs` already stops where this clip starts, and `from` is the part it gave up - the same clip,
/// trimmed to its last moments, with its own sound, speed and framing - drawn UNDER this clip from
/// this clip's first frame, for its own length. The base track stays the flat sequence
/// `CompositionBuilder` has always laid, and all a transition adds is its tail, on one extra track.
///
/// A class rather than a struct only because it holds a `ComposeClip` and a `ComposeClip` holds one
/// of these, and two structs that contain each other have no size. Every property is a `let` of a
/// Sendable type, so the conformance is checked by the compiler rather than promised.
final class ComposeTransition: Sendable {
    /// The catalogue id, `dissolve` or `slide-left`, for a log line and nothing else. Nothing in this
    /// engine draws differently for it: it draws `curves` and `mask`, which is how a transition the
    /// catalogue gains tomorrow reaches every engine as numbers without a line of native code.
    let kind: String
    /// The outgoing clip's last moments, drawn under this clip while the transition runs.
    let from: ComposeClip
    /// The shape the incoming side is revealed through. nil reveals it everywhere at once.
    let mask: ComposeTransitionMask?
    /// What the outgoing side's `tint` channel moves it towards. Black when the wire left it out,
    /// which is the contract's default, resolved here so the compositor never has to ask.
    let fromTint: ComposeRGB
    /// The same for the incoming side.
    let toTint: ComposeRGB
    let curves: ComposeTransitionCurves

    init(kind: String, from: ComposeClip, mask: ComposeTransitionMask?,
         fromTint: ComposeRGB, toTint: ComposeRGB, curves: ComposeTransitionCurves) {
        self.kind = kind
        self.from = from
        self.mask = mask
        self.fromTint = fromTint
        self.toTint = toTint
        self.curves = curves
    }
}

/// The shape a mask reveals the incoming side through, with every default already filled in and
/// every number already held to its range by the parser. `TransitionMath.maskMeasure` is where the
/// shapes are defined; see `ComposeTransitionMask` in `definitions.ts` for the same in prose.
struct ComposeTransitionMask: Sendable {
    enum Shape: String, Sendable { case linear, circle, diamond, clock, blinds, split }

    let shape: Shape
    /// The way a `linear` edge travels, and the direction `blinds` and `split` measure along, in
    /// y-DOWN degrees. Not clamped: cos and sin reduce any angle.
    let angleDeg: Double
    /// `blinds` only: how many slats, 1...64.
    let count: Int
    /// Softness of the edge in the shape's own 0...1 units, 0.0005...0.5.
    let feather: Double
    /// Reveals the incoming side OUTSIDE the shape instead of inside it.
    let invert: Bool
}

/// Every channel a transition moves, each sampled at evenly spaced moments of its window. The parser
/// guarantees every curve present has the same length, 2...121, and that every sample is finite and
/// inside its channel's range. An absent curve holds its neutral value for the whole window.
struct ComposeTransitionCurves: Sendable {
    /// How much of the incoming side is drawn, 0...1. Neutral 1.
    let alpha: [Double]?
    /// How far the mask is open, 0...1. Neutral 1.
    let reveal: [Double]?
    let from: ComposeTransitionSideCurves?
    let to: ComposeTransitionSideCurves?
}

/// One side's channels, in the order `TransitionSide` lists them. See `TransitionSide` for what
/// each one does and `TransitionRender.side` for the order they are applied in.
struct ComposeTransitionSideCurves: Sendable {
    let x: [Double]?
    let y: [Double]?
    let scale: [Double]?
    let rotation: [Double]?
    let blur: [Double]?
    let pixelate: [Double]?
    let split: [Double]?
    let gain: [Double]?
    let tint: [Double]?
}

/// A colour as three 0...1 channels in gamma-encoded sRGB, the space every blend in this engine
/// happens in.
struct ComposeRGB: Sendable {
    let r: Double
    let g: Double
    let b: Double

    static let black = ComposeRGB(r: 0, g: 0, b: 0)
}

/// One extra layer of video over `ComposeSpec.clips`, drawn in its clips' own rectangles.
///
/// Its clips are a flat SEQUENCE like the base track's: they play one after another and never
/// overlap EACH OTHER. Overlap happens BETWEEN tracks, which is the whole reason a track exists
/// rather than a start time on the clip - one track maps exactly onto one
/// `AVMutableCompositionTrack`, and a composition track holds segments that do not overlap, so any
/// other reading would have to be packed into several tracks in here and the packing is precisely
/// the thing two engines could quietly disagree about.
///
/// Where a layer sits on the frame is not a property of the track: it is each clip's own `rect`,
/// which this engine already draws. A layout preset is a pair of rectangles and nothing more.
struct ComposeTrack: Sendable {
    /// The layer's id from the manifest. Nothing in the render reads it; it is carried and checked
    /// so that a spec which cannot name its own layers fails at the parser rather than later.
    let id: String
    /// Never empty: the parser rejects a layer with nothing on it.
    let clips: [ComposeClip]
    /// Where this layer's FIRST clip lands on the OUTPUT timeline. Before that instant the layer
    /// contributes nothing at all - not a black frame, nothing - and the base shows through.
    let startMs: Int64
    /// Higher draws later, so on top. The base track is 0 and a tie breaks on spec order. It is the
    /// whole of the ordering now that a post may hold fifteen of these: with one layer z was
    /// reliably 1 and nothing depended on reading it. A track that arrived without one carries its
    /// index in `tracks` plus one, Android's default.
    let z: Int
    /// 0...1 over the whole layer, already clamped, multiplied into whatever each clip carries.
    let opacity: Double
}

struct ComposeOutput: Sendable {
    let width: Int             // already rounded down to even
    let height: Int            // already rounded down to even
    let fps: Int
    let videoBitrate: Int
    let audioBitrate: Int
    /// The most bytes the finished file may have, or nil for no ceiling at all. It is the host's
    /// upload limit - choisy's server refuses a file over 100 MB, lighsnip has none - and the kit
    /// holds the render to it rather than pick one of its own: the writer stops once its file grows
    /// past it, the preset session is told it, and `Exporter` checks the finished file against it.
    /// Rounded down to a whole byte, because a file has no fraction of one.
    let maxBytes: Int64?
}

/// A CSS Filter Effects operation in gamma-encoded sRGB. The list is folded into one 3x3 plus bias
/// by `ColorMatrix.fold`, which is why the amounts stay raw scalars here rather than being turned
/// into anything platform shaped.
enum FilterOp: Sendable {
    case brightness(Double)
    case contrast(Double)
    case saturate(Double)
    case sepia(Double)
    case grayscale(Double)
    case hueRotate(Double)                              // degrees
    case tint(r: Int, g: Int, b: Int, alpha: Double)    // channels 0...255, alpha 0...1
}

struct ComposeOverlay: Sendable {
    let id: String
    /// The whole data URL, still base64. It is decoded once in `OverlayBitmap`, at plan build time,
    /// never per frame.
    let png: String
    /// Centre position 0...1 with a TOP-LEFT origin and y pointing DOWN, the web's coordinate
    /// system. Core Image is y-up, so `OverlayBitmap` is the one place that flips it.
    let cx: Double
    let cy: Double
    let wPx: Int
    let hPx: Int
    /// CLOCKWISE, as CSS `rotate()`. Not clamped: a caller may legitimately send 720 or -45.
    let rotationDeg: Double
    let startMs: Int64
    let endMs: Int64
    let opacity: Double        // 0...1
    /// How the layer MOVES - `ComposeOverlayMotion` in `definitions.ts`, which is the contract - or
    /// nil for a layer that stands still, which is every overlay of every spec written before layers
    /// moved and what the parser makes of a motion that moves nothing. nil is decided HERE, once, and
    /// `OverlayBitmap` then places the layer by exactly the arithmetic it always has.
    ///
    /// A `var` with a default, and declared LAST, so the memberwise initialiser takes it as an
    /// optional last argument and every overlay built without one is built exactly as it was.
    var motion: ComposeOverlayMotion? = nil
}

/// A layer's moves, LOWERED to keys by JS (`compileOverlayMotion` in `src/editor/motion.ts`), as the
/// parser leaves them: `atMs` finite and non-decreasing, 1...`ComposeSpecParser.maxOverlayMotionKeys`
/// of them, and every channel present as long as `atMs`, each value already clamped - and a channel
/// that never leaves its neutral value left out as nil, so reading it costs nothing.
///
/// Doubles and milliseconds for the camera's reasons (`ComposeCameraKey`): nothing downstream needs a
/// `CMTime`, and a hand-built time multiplied into microseconds could overflow.
struct ComposeOverlayMotion: Sendable {
    /// Output-timeline milliseconds.
    let atMs: [Double]
    /// Offset of the centre, a fraction of the output WIDTH, positive right. nil holds 0.
    let x: [Double]?
    /// The same, a fraction of the output HEIGHT, positive DOWN - the wire's y, flipped only where
    /// the layer is placed in Core Image's y-up space (`OverlayBitmap.placement`). nil holds 0.
    let y: [Double]?
    /// Size about the centre, multiplying `wPx`/`hPx`. nil holds 1.
    let scale: [Double]?
    /// CLOCKWISE degrees added to `rotationDeg`. nil holds 0.
    let rotation: [Double]?
    /// Multiplied into `opacity`. nil holds 1.
    let opacity: [Double]?
}

struct ComposeMusic: Sendable {
    let uri: String
    let startMs: Int64
    let inMs: Int64
    /// Often far past the real end of the file: JS sends 3,600,000 when it could not read the track
    /// length. `CompositionBuilder` clamps it to the source, so a huge value here is normal input
    /// and not an error.
    let outMs: Int64
    let volume: Double
    let loop: Bool
    let fadeInMs: Int64
    let fadeOutMs: Int64
}

struct ComposeVoiceover: Sendable {
    let uri: String
    let startMs: Int64
    let durationMs: Int64
    let volume: Double
}

struct ComposeAudio: Sendable {
    let originalMuted: Bool
    let originalVolume: Double
    let music: ComposeMusic?
    let voiceover: [ComposeVoiceover]
}

/// One key of a camera track, as the parser leaves it: ALREADY CLAMPED, `scale` to
/// 1...`ComposeSpecParser.maxCameraScale` and `cx`/`cy` to `0.5 / scale ... 1 - 0.5 / scale`, so at
/// scale 1 the centre is exactly 0.5 and the visible area is always inside the frame. `atMs` is
/// output-timeline milliseconds, finite and never less than the key before it.
///
/// A Double and not an Int64 of microseconds on purpose: nothing downstream needs a `CMTime`, and a
/// hand-built time multiplied into microseconds could overflow where a Double comparison cannot.
struct ComposeCameraKey: Sendable {
    let atMs: Double
    let scale: Double
    /// The point brought to the frame's centre, 0..1 of the output width, left to right.
    let cx: Double
    /// The same, 0..1 of the output height, TOP to bottom - the wire's y-down, flipped only where
    /// the camera becomes a Core Image transform (`CameraMath.transform`).
    let cy: Double
}

struct ComposeSpec: Sendable {
    let jobId: String
    let batchId: String
    /// The BASE track. It starts at 0, and its length is the output's length unless `durationMs`
    /// asks for more.
    let clips: [ComposeClip]
    /// How long the output runs, when that is MORE than the base track adds up to. 0 - what every
    /// spec written before this key said, and what a spec carrying no tail still says - means "as
    /// long as the base track".
    ///
    /// Past the base track's last frame the picture is BLACK, which is not a new kind of frame for
    /// this engine to make: `merged` already hands every instant where no layer has a clip an
    /// instruction with no layers in it, and `EditCompositor.render` starts each frame on black.
    let durationMs: Int64
    /// Extra layers drawn over `clips`, bottom to top by `z`. One running past the base is CUT, and
    /// one ending early leaves the base showing underneath.
    ///
    /// nil is a spec with no `tracks` key at all, which is every spec written before this feature
    /// and every spec a single-layer edit still sends. It stays nil rather than becoming an empty
    /// array for the same reason `ComposeClip.crop` stays nil: the builder asks this ONCE to decide
    /// whether it has more than one timeline to merge, and a default written here would put every
    /// spec ever sent onto the merging path. An empty array means the same thing and takes the same
    /// path; the two are told apart only because the wire tells them apart.
    let tracks: [ComposeTrack]?
    let output: ComposeOutput
    /// A bare array, exactly as `definitions.ts` declares it. There is no wrapper object with an
    /// `ops` key; one would fail to decode every spec the app actually sends.
    let filter: [FilterOp]
    let overlays: [ComposeOverlay]
    let audio: ComposeAudio
    let posterAtMs: Int64
    /// The zooms of the post, compiled by JS into a camera moving over every VIDEO layer - see
    /// `ComposeCamera` in `definitions.ts`, which is the contract - one entry per key, in time order.
    ///
    /// nil is a spec with no `camera` key, which is every spec written before zoom existed, and ALSO
    /// a camera that never magnifies: the parser drops that one, because a camera held at the whole
    /// frame is the same picture as no camera, and keeping it would put every frame of the post onto
    /// the camera's arithmetic for nothing. It stays an optional rather than an empty array for the
    /// reason `tracks` does: `RenderPlan` asks it ONCE whether there is a camera at all.
    ///
    /// Declared LAST, so the memberwise initialiser gains it as its last argument.
    let camera: [ComposeCameraKey]?

    /// Output-timeline length in ms, rounded PER CLIP exactly as Android's RenderPlan does. Rounding
    /// once at the end instead would drift from the Android number by up to half a millisecond per
    /// clip, and these numbers end up in a `no_space` message both platforms are compared on.
    ///
    /// This is an UPPER BOUND: `CompositionBuilder` produces less whenever a clip's `outMs` runs
    /// past the real file and gets clamped. It has two uses: the disk estimate in `JobRegistry`,
    /// where running long is the safe direction, and the clip placement `ErrorMapping.blamedClip`
    /// repeats when it names the clip a failed export was on. It is never a `timeRange`, which is
    /// `BuiltComposition.totalMs`, and there is no wall-clock budget for it to set: a render is
    /// stopped only when it stops moving (`StallWatch`).
    ///
    /// Transitions need nothing here. The overlap is already taken out of `clips` before the spec
    /// leaves the editor - each outgoing clip stops where the next one starts - and a transition's
    /// `from` is drawn UNDER the incoming clip rather than after it, so it adds no length of its own.
    /// Summing `clips` as they arrive is the post's length with every transition in it.
    var totalOutputMs: Int64 {
        let sum = clips.reduce(Int64(0)) { acc, c in
            // The parser clamps speed to 0.25...4.0, so this cannot divide by zero. The isFinite
            // gate is still here because `Int64(Double.infinity)` traps rather than saturating, and
            // a trap inside a disk estimate would take the whole render down.
            let scaled = Double(c.outMs - c.inMs) / c.speed
            guard scaled.isFinite else { return acc }
            return acc + Int64(scaled.rounded(.toNearestOrAwayFromZero))
        }
        // The tail counts: it is output that has to be written, encoded and fitted on disk like any
        // other, even though nothing decodes for it.
        return max(1, max(sum, durationMs))
    }

    /// Every clip the render lays, wherever it sits: the base track, the outgoing side each
    /// transition draws under its clip, and each layer's clips. `PictureStills` finds the pictures
    /// among them.
    var everyClip: [ComposeClip] {
        clips + clips.compactMap { $0.transitionIn?.from } + (tracks ?? []).flatMap { $0.clips }
    }

    /// The name of every file the render opens, as the spec gives it: `everyClip`'s, the music's and
    /// each voiceover take's. `RetainedMedia.sweep` keeps what a render in progress reads through
    /// `JobRegistry.liveInputURIs`.
    var inputURIs: [String] {
        everyClip.map(\.uri) + (audio.music.map { [$0.uri] } ?? []) + audio.voiceover.map(\.uri)
    }
}

/// Mirrors Kotlin `ProbedInput`. Only the pre-flight uses it: it is what turns "this clip has no
/// video track" into a failure that can name the clip, before a single codec is opened.
struct ProbedInput: Sendable {
    let durationMs: Int64
    let hasAudio: Bool
    let hasVideo: Bool
}

/// Mirrors Kotlin `SpecException`. `message` is verbatim what `call.reject` sends, so the format is
/// Android's: `invalid_spec:clips[0].uri`, no space after the colon and bracketed indices. Do not be
/// tempted to build it from a `DecodingError`'s `codingPath`: Capacitor's `JSValueDecoder` builds a
/// path and then constructs the nested decoder without it, so every nested error arrives with an
/// empty path and the message would read `invalid_spec:` and nothing else.
struct SpecError: Error, LocalizedError {
    let path: String
    let message: String

    /// `detail` is only ever passed for the three Android exceptions that carry a custom message:
    /// `filter[i].op unknown op '<op>'`, the video track cap, and `tracks[i].clips track '<id>' has
    /// no clips`. All three are compared literally by the port tests, so the wording here is
    /// Android's wording and not a paraphrase of it.
    init(_ path: String, _ detail: String? = nil) {
        self.path = path
        self.message = detail ?? "invalid_spec:\(path)"
    }

    var errorDescription: String? { message }
}

// The module's only two time helpers. Declared HERE and nowhere else: one module, one definition,
// and every caller uses them unqualified. Timescale 1000 is exact for integer milliseconds, so a
// composition edge can never drift from the JS timeline the way a 600 or 44100 scale would.
func ms(_ v: Int64) -> CMTime { CMTime(value: v, timescale: 1000) }

/// Floors, because every use converts a source duration into a bound we must not exceed. Rounding
/// up here would let `insertTimeRange` ask for one millisecond that is not in the file, which
/// AVFoundation accepts silently and then renders as a black tail.
func msOf(_ t: CMTime) -> Int64 {
    CMTimeConvertScale(t, timescale: 1000, method: .roundTowardZero).value
}
