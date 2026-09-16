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
/// The parser guarantees `w > 0`, `h > 0` and `x + w <= 1`, `y + h <= 1`, so a consumer never has to
/// range check one. Doubles rather than CGFloat because everything on the wire is a Double here and
/// the conversion belongs at the one point of use.
struct ComposeRect: Sendable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
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
    /// Where the cropped picture is drawn on the OUTPUT frame. nil is the whole frame and `fit`
    /// then letterboxes as it always has; present, `fit` applies WITHIN this rectangle, which is
    /// the "frame" as far as contain and cover are concerned. nil for the same reason as `crop`.
    let rect: ComposeRect?
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
    /// Higher draws later, so on top. The base track is 0 and a tie breaks on spec order.
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

struct ComposeSpec: Sendable {
    let jobId: String
    let pendingPostId: String
    /// The BASE track. It starts at 0 and ITS length is the output's length.
    let clips: [ComposeClip]
    /// Extra layers drawn over `clips`, bottom to top by `z`. One running past the base is CUT, and
    /// one ending early leaves the base showing underneath.
    ///
    /// nil is a spec with no `tracks` key at all, which is every spec written before this feature
    /// and every spec a single-layer edit still sends. It stays nil rather than becoming an empty
    /// array for the same reason `ComposeClip.crop` stays nil: the builder asks this ONCE to decide
    /// whether it has two timelines to merge, and a default written here would put every spec ever
    /// sent onto the merging path. An empty array means the same thing and takes the same path; the
    /// two are told apart only because the wire tells them apart.
    let tracks: [ComposeTrack]?
    let output: ComposeOutput
    /// A bare array, exactly as `definitions.ts` declares it. There is no wrapper object with an
    /// `ops` key; one would fail to decode every spec the app actually sends.
    let filter: [FilterOp]
    let overlays: [ComposeOverlay]
    let audio: ComposeAudio
    let posterAtMs: Int64

    /// Output-timeline length in ms, rounded PER CLIP exactly as Android's RenderPlan does. Rounding
    /// once at the end instead would drift from the Android number by up to half a millisecond per
    /// clip, and these numbers end up in a `no_space` message both platforms are compared on.
    ///
    /// This is an UPPER BOUND: `CompositionBuilder` produces less whenever a clip's `outMs` runs
    /// past the real file and gets clamped. Use it for the disk estimate and the wall-clock budget,
    /// never for a `timeRange`.
    var totalOutputMs: Int64 {
        let sum = clips.reduce(Int64(0)) { acc, c in
            // The parser clamps speed to 0.25...4.0, so this cannot divide by zero. The isFinite
            // gate is still here because `Int64(Double.infinity)` traps rather than saturating, and
            // a trap inside a disk estimate would take the whole render down.
            let scaled = Double(c.outMs - c.inMs) / c.speed
            guard scaled.isFinite else { return acc }
            return acc + Int64(scaled.rounded(.toNearestOrAwayFromZero))
        }
        return max(1, sum)
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

    /// `detail` is only ever passed for the one Android exception that carries a custom message,
    /// `filter[i].op unknown op '<op>'`.
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
