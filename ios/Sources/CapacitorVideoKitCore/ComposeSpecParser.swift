import Capacitor
import Foundation

/// Turns a `CAPPluginCall` into a validated `ComposeSpec`, or throws the exact `SpecError` Android
/// would have thrown for the same payload.
///
/// Two phases, because Android's parser is two things at once and splitting them is what makes both
/// testable. DECODE produces DTOs that mirror the wire: it applies the cheap local clamps, tolerates
/// every scalar the way org.json does, and only fails on a shape it cannot walk. VALIDATE then
/// walks the decoded tree in Android's exact order, throws the first `SpecError`, and returns the
/// fully clamped value types the renderer consumes.
///
/// The check ORDER is load bearing. The tests compare message strings literally, so a spec that is
/// wrong in two places has to name the same field on both platforms. Android's order is: `jobId`,
/// `batchId`, the `clips` array, each clip (and, from the second clip on, straight after that clip's
/// own fields, its `transitionIn`), the `tracks` count, each track and its own clips, `output`, each
/// filter op, the `overlays` count, each overlay, `audio.music`, each voiceover, `camera`,
/// `posterAtMs`.
/// `output` sitting in the middle of that is why `OutputDTO` decodes leniently and why everything
/// after it holds its first error instead of throwing it (see `heldError`).
///
/// Inside a `transitionIn` the order is Android's `parseTransitionIn`: `kind`, `from` (read by the
/// one clip reader, so its failures are a clip's), `curves`, `mask`, `fromTint`, `toTint`. Inside
/// `curves` it is `alpha`, `reveal`, then each side's channels in `TransitionSide` order followed by
/// that side's unknown keys, then the unknown keys of `curves` itself, and last the check that every
/// curve is as long as the first one read. The one place the two cannot agree is a level carrying
/// SEVERAL unknown keys: see `firstUnknownKey`.
enum ComposeSpecParser {
    static let maxOverlays = 30
    /// `MAX_CAMERA_KEYS` and `MAX_CAMERA_SCALE` from `definitions.ts`. A camera with more keys is
    /// REFUSED rather than truncated - a truncated camera would hold its last surviving key for the
    /// rest of the post - and a key magnifying more is clamped, as every other out-of-range value is.
    static let maxCameraKeys = 20000
    static let maxCameraScale: Double = 8
    /// Every curve of a transition has the same number of samples, and this many at the least and
    /// at the most. Two is a straight line from start to end; 121 is three times what the editor
    /// sends, room for a finer catalogue without letting a spec carry a curve of any length at all.
    static let minCurveSamples = 2
    static let maxCurveSamples = 121
    /// `MAX_VIDEO_TRACKS` from the manifest, the BASE track INCLUDED, so at most fifteen entries in
    /// `tracks`. It is NOT a decoder budget: this parser feeds the export, which composites offline
    /// with nothing racing a frame deadline, and the live preview keeps a budget of its own that is
    /// a different number in a different file. The ceiling is here only so that an absurd spec meets
    /// a readable refusal instead of a device running out of codecs halfway through a render.
    static let maxVideoTracks = 16
    static let minSpeed = 0.25
    static let maxSpeed = 4.0
    static let pngDataURLPrefix = "data:image/png;base64,"

    /// Decodes with `call.decode(_:)` and then validates. Throws `SpecError` and nothing else.
    ///
    /// Never a `JSONSerialization` round trip of `call.options`. Each overlay's `png` is a base64
    /// data URL at output scale, so thirty of them are tens of megabytes of `String`; serialising
    /// them into a `Data` and parsing them back triples the peak footprint at exactly the moment
    /// the renderer is about to allocate bitmaps. A round trip also fails the WHOLE object for one
    /// non-finite number, with no field name to report.
    static func parse(_ call: CAPPluginCall) throws -> ComposeSpec {
        let dto: ComposeSpecDTO
        do {
            dto = try call.decode(ComposeSpecDTO.self)
        } catch let e as SpecError {
            throw e
        } catch let e as FilterParseError {
            // Belt and braces: every filter element is already converted to a SpecError with its
            // real index inside the container loop, so this can only fire if the root itself were a
            // filter op, which the wire cannot express.
            throw e.specError(index: 0)
        } catch {
            // `options` was not an object at all, which Android sees as a spec with no clips.
            throw SpecError("clips")
        }
        return try validate(dto)
    }

    private static func validate(_ d: ComposeSpecDTO) throws -> ComposeSpec {
        guard let o = d.output else { throw SpecError("output") }
        if o.width <= 0 { throw SpecError("output.width") }
        if o.height <= 0 { throw SpecError("output.height") }
        if o.fps <= 0 { throw SpecError("output.fps") }
        if o.videoBitrate <= 0 { throw SpecError("output.videoBitrate") }
        if o.audioBitrate <= 0 { throw SpecError("output.audioBitrate") }

        // Everything the decoder found wrong AFTER `output` was held back so that these five checks
        // could run first. This is the point in Android's order where those errors surface.
        if let held = d.heldError { throw held }

        // `transitions` runs beside `clips` one for one, nil wherever a clip has none - which is
        // always the first clip, and every clip of a post nobody put a transition in.
        let clips = zip(d.clips, d.transitions).map { c, t in clip(c, transitionIn: t.map(transition)) }

        // `map` on the OPTIONAL, so a spec that carried no `tracks` key still carries none here.
        // Absence has to survive the parser intact: it is what the builder tests to keep the
        // single-layer path a single-layer edit has always taken.
        let tracks = d.tracks.map { list in
            list.map { t in
                ComposeTrack(id: t.id,
                             clips: t.clips.map { clip($0) },
                             startMs: t.startMs,
                             z: t.z,
                             opacity: clamp01(t.opacity))
            }
        }

        // The even rounding is Kotlin's `width and 1.inv()`. It runs AFTER the `> 0` test, because
        // masking first would turn a 1 into a 0 and report the wrong field.
        let output = ComposeOutput(width: o.width & ~1,
                                   height: o.height & ~1,
                                   fps: o.fps,
                                   videoBitrate: o.videoBitrate,
                                   audioBitrate: o.audioBitrate)

        let overlays = d.overlays.map { o in
            ComposeOverlay(id: o.id,
                           png: o.png,
                           cx: clamp01(o.cx),
                           cy: clamp01(o.cy),
                           wPx: o.wPx,
                           hPx: o.hPx,
                           rotationDeg: o.rotationDeg,
                           startMs: o.startMs,
                           endMs: o.endMs,
                           opacity: clamp01(o.opacity))
        }

        let music = d.audio.music.map { m in
            ComposeMusic(uri: m.uri,
                         startMs: m.startMs,
                         inMs: m.inMs,
                         outMs: m.outMs,
                         volume: clamp01(m.volume),
                         loop: m.loop,
                         fadeInMs: m.fadeInMs,
                         fadeOutMs: m.fadeOutMs)
        }

        let voiceover = d.audio.voiceover.map { v in
            ComposeVoiceover(uri: v.uri,
                             startMs: v.startMs,
                             durationMs: v.durationMs,
                             volume: clamp01(v.volume))
        }

        let audio = ComposeAudio(originalMuted: d.audio.originalMuted,
                                 originalVolume: clamp01(d.audio.originalVolume),
                                 music: music,
                                 voiceover: voiceover)

        return ComposeSpec(jobId: d.jobId,
                           batchId: d.batchId,
                           clips: clips,
                           durationMs: d.durationMs,
                           tracks: tracks,
                           output: output,
                           filter: d.filter,
                           overlays: overlays,
                           audio: audio,
                           posterAtMs: d.posterAtMs,
                           camera: d.camera.flatMap(cameraKeys))
    }

    /// A decoded camera with `normaliseCamera`'s clamps applied, key by key - or nil when it moves
    /// nothing at all, which is the absent path. Every shape rule (lengths, the key cap, finite and
    /// non-decreasing times) was already enforced by `CameraDTO`, where an error can still be held
    /// behind `output`'s; all that is left here is the clamping, which cannot fail.
    ///
    /// Dropping a camera that never magnifies is the contract's rule, not a shortcut: it is what
    /// makes a spec whose zooms were all deleted take exactly the path a spec with no `camera` key
    /// takes, on this engine and on the other two.
    private static func cameraKeys(_ c: CameraDTO) -> [ComposeCameraKey]? {
        let n = c.atMs.count
        guard n > 0 else { return nil }
        var keys: [ComposeCameraKey] = []
        keys.reserveCapacity(n)
        var moves = false
        for i in 0..<n {
            let pose = CameraMath.clamped(scale: c.scale[i], cx: c.cx[i], cy: c.cy[i])
            if !CameraMath.isIdentity(pose) { moves = true }
            keys.append(ComposeCameraKey(atMs: c.atMs[i], scale: pose.scale, cx: pose.cx, cy: pose.cy))
        }
        return moves ? keys : nil
    }

    /// One decoded clip with its clamps applied. Shared by the base track and every extra layer,
    /// because a clip on the second layer is the same kind of thing as one on the first: the day
    /// the two are read differently is the day one half of a split screen renders differently from
    /// the other.
    ///
    /// `transitionIn` is the one thing a base clip may carry that a layer's may not, which is why it
    /// is handed in rather than read off the DTO: `ClipDTO` never reads the key at all.
    private static func clip(_ c: ClipDTO, transitionIn: ComposeTransition? = nil) -> ComposeClip {
        ComposeClip(key: c.key,
                    uri: c.uri,
                    inMs: c.inMs,
                    outMs: c.outMs,
                    speed: clamp(c.speed, minSpeed, maxSpeed),
                    volume: clamp01(c.volume),
                    muted: c.muted,
                    // Only the exact string "cover" selects cover. A typo, or "COVER", silently
                    // renders contain, exactly as Android's `== "cover"` test does. Rejecting it
                    // would fail specs the Android build accepts.
                    fit: c.fit == Fit.cover.rawValue ? .cover : .contain,
                    crop: clampRect(c.crop),
                    rect: clampPlacement(c.rect),
                    transitionIn: transitionIn)
    }

    /// A decoded transition as the value the builder consumes. Every curve sample, mask number and
    /// tint channel was already clamped where it was read, so all that is left is to resolve the two
    /// tints' default and run `from` through the same clamps as any other clip.
    private static func transition(_ t: TransitionDTO) -> ComposeTransition {
        ComposeTransition(kind: t.kind,
                          from: clip(t.from),
                          mask: t.mask.map {
                              ComposeTransitionMask(shape: $0.shape,
                                                    angleDeg: $0.angleDeg,
                                                    count: $0.count,
                                                    feather: $0.feather,
                                                    invert: $0.invert)
                          },
                          fromTint: rgb(t.fromTint),
                          toTint: rgb(t.toTint),
                          curves: ComposeTransitionCurves(alpha: t.curves.alpha,
                                                          reveal: t.curves.reveal,
                                                          from: t.curves.from.map(side),
                                                          to: t.curves.to.map(side)))
    }

    private static func side(_ s: SideCurvesDTO) -> ComposeTransitionSideCurves {
        ComposeTransitionSideCurves(x: s.x, y: s.y, scale: s.scale, rotation: s.rotation,
                                    blur: s.blur, pixelate: s.pixelate, split: s.split,
                                    gain: s.gain, tint: s.tint)
    }

    /// Absent is black, the contract's default for both tints.
    private static func rgb(_ v: [Double]?) -> ComposeRGB {
        guard let v, v.count == 3 else { return .black }
        return ComposeRGB(r: v[0], g: v[1], b: v[2])
    }
}

// MARK: - Clamps

/// `min`/`max` in this order also swallow a NaN, because every comparison against NaN is false and
/// the first argument wins. The lenient readers below already reject non-finite numbers, so this is
/// only the second line of defence, but it is the one that keeps a NaN out of a `CMTime`.
private func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }
private func clamp01(_ v: Double) -> Double { clamp(v, 0, 1) }

/// Pulls a decoded CROP into the unit square. `w` and `h` were already rejected if they were not
/// positive, which is the split this parser draws everywhere: a shape error is thrown, a value that
/// is merely out of range is clamped. A placement is not pulled inside anything; see
/// `clampPlacement`, which is where a picture is allowed to hang off the frame.
///
/// The order is x and y first, then w and h against whatever room is left, so a rectangle that
/// overhangs the right edge keeps its position and loses its overhang rather than sliding back
/// inwards. Reversing it would silently move a crop the customer placed.
///
/// An ABSENT rectangle stays absent. The renderer tests these two optionals for nil to decide
/// whether a clip needs the new geometry at all, so substituting a 0,0,1,1 here would put every
/// spec ever written onto the reframing path for no reason.
private func clampRect(_ r: RectDTO?) -> ComposeRect? {
    guard let r else { return nil }
    let x = clamp01(r.x)
    let y = clamp01(r.y)
    // A degenerate x of exactly 1 leaves no room and takes w to 0. That is a rectangle with no
    // picture in it rather than an error, and `Placement` already answers a zero-sized source with
    // a black frame, which is the same thing both engines do for a clip that contributes nothing.
    return ComposeRect(x: x, y: y, w: min(r.w, 1 - x), h: min(r.h, 1 - y))
}

/// The same four numbers through a DIFFERENT clamp, with the angle carried across untouched.
///
/// Different because a placement is not a crop. A crop names the part of a source frame that is
/// kept and there is nothing outside that frame to name, so `clampRect` pulls one inside; a
/// placement says where the picture is DRAWN, and a customer who drags a video off the side of the
/// canvas means the overhang to be cut off by the output frame. Pulling it inside would slide that
/// video back on screen and quietly rearrange the post.
///
/// What is held is a STRIP of it on the frame, `MIN_ON_FRAME` wide, and nothing else: a video can be
/// pushed until only that strip is showing and no further, which is far enough to frame a shot along
/// an edge and not so far that the picture is gone and cannot be picked up again.
/// `MAX_PLACEMENT_SIZE` caps the size for a reason of the renderer's own - a clip on an extra layer
/// is drawn into a texture of its rectangle's own size. Both rules are `normalisePlacement`'s in the
/// TypeScript, to the arithmetic: this parser, the Android one and the browser's reader have to
/// agree or the same post is a different picture per engine.
///
/// The angle is deliberately NOT clamped and NOT wrapped into a single turn: 720 is a legal spec and
/// sin/cos reduce it. Nor does the clamp extend to it, because a turned rectangle legitimately puts
/// its corners outside the frame and the frame is what crops them.
private func clampPlacement(_ r: RectDTO?) -> ComposePlacement? {
    guard let r else { return nil }
    let w = min(r.w, MAX_PLACEMENT_SIZE)
    let h = min(r.h, MAX_PLACEMENT_SIZE)
    return ComposePlacement(
        x: clamp(r.x, nearEdge(w), farEdge(w)),
        y: clamp(r.y, nearEdge(h), farEdge(h)),
        w: w,
        h: h,
        rotationDeg: r.rotationDeg)
}

/// How far a placement of this size may run in one axis, as its own leading edge. A rectangle
/// SMALLER than `MIN_ON_FRAME` keeps all of itself on the frame: it cannot leave a twelfth of the
/// frame behind.
private func nearEdge(_ size: Double) -> Double { min(size, MIN_ON_FRAME) - size }

private func farEdge(_ size: Double) -> Double { 1 - min(size, MIN_ON_FRAME) }

/// How much of a placement has to stay ON the frame, as a fraction of it. The only limit left on
/// where a video may be put, and the same number as `MIN_ON_FRAME` in the TypeScript.
private let MIN_ON_FRAME: Double = 1.0 / 12.0

/// The largest a clip's placement rectangle may be, as a multiple of the output frame. Twice a
/// 1080x1920 output is 2160x3840, which every renderer here can hold as a single layer; the same
/// number as `MAX_PLACEMENT_SIZE` in the TypeScript, where a customer's gesture meets it first.
private let MAX_PLACEMENT_SIZE: Double = 2

// MARK: - org.json-lenient readers

/// org.json's `optInt` / `optLong` TRUNCATE a JSON double toward zero rather than failing, and
/// `optDouble` falls back to its default for anything non numeric. Reproducing that here is what
/// makes a hand built spec behave identically on both platforms; `Decodable`'s own strictness would
/// reject values the Android build quietly accepts.
///
/// None of these throw. A shape error is the only thing a DTO initialiser is allowed to fail on,
/// and it reports the field itself.
private extension KeyedDecodingContainer {

    /// Present, non-null, numeric and finite, else nil.
    ///
    /// Reading through `Double` rather than `Int` is deliberate: Capacitor coerces every JS number
    /// to an `NSNumber`, and `NSNumber(1500.5) as? Int` fails while org.json would have given 1500.
    func number(_ key: Key) -> Double? {
        guard let v = try? decodeIfPresent(Double.self, forKey: key), v.isFinite else { return nil }
        return v
    }

    func double(_ key: Key, _ fallback: Double) -> Double { number(key) ?? fallback }

    func int(_ key: Key, _ fallback: Int) -> Int {
        guard let v = number(key), v > -2_147_483_648, v < 2_147_483_648 else { return fallback }
        return Int(v.rounded(.towardZero))
    }

    func long(_ key: Key, _ fallback: Int64) -> Int64 {
        // The bounds are loose on purpose: they only have to keep the conversion out of the range
        // where `Int64(Double)` traps, and no real timeline is anywhere near them.
        guard let v = number(key), v > -9.2e18, v < 9.2e18 else { return fallback }
        return Int64(v.rounded(.towardZero))
    }

    func flag(_ key: Key, _ fallback: Bool) -> Bool {
        guard let v = try? decodeIfPresent(Bool.self, forKey: key) else { return fallback }
        return v
    }

    /// org.json `optString` semantics for our purposes: "" for missing, null or non-string. The
    /// empty string is then what every required-field check tests, so a missing key and a blank one
    /// report the same path, as they do on Android.
    func string(_ key: Key) -> String {
        guard let v = try? decodeIfPresent(String.self, forKey: key) else { return "" }
        return v
    }

    /// Android's `has(...)` presence test. An explicit `null` counts as ABSENT here, which is the
    /// one place we are deliberately kinder than org.json: `has` is true for a null but `optDouble`
    /// then returns the fallback anyway, so treating null as missing matches the practical intent
    /// and keeps `amount: null` from becoming a silent 1.0.
    func has(_ key: Key) -> Bool {
        guard contains(key) else { return false }
        return (try? decodeNil(forKey: key)) == false
    }

    /// `crop` and `rect` are the same shape with the same failures, so they share one reader.
    /// `name` is the field's own name and is spliced in front of the leaf path the rectangle threw,
    /// which is how `w` becomes `crop.w` before the clip loop turns it into `clips[0].crop.w`.
    ///
    /// Sharing the reader means a `rotationDeg` is READABLE on a crop as well, and `clampRect` drops
    /// it there. Turning the region sampled out of the source is a different operation on different
    /// pixels, one neither engine performs and the builder never asks for.
    ///
    /// Absent, or explicitly null, is nil and stays nil all the way to the renderer. So is a value
    /// that is present but not an object at all: Android's `optJSONObject` returns null for a
    /// number or a string there, and a null rectangle means the whole frame, so this is the one
    /// rectangle failure that is deliberately not an error.
    func rect(_ key: Key, _ name: String) throws -> RectDTO? {
        guard has(key) else { return nil }
        do {
            return try decode(RectDTO.self, forKey: key)
        } catch let e as SpecError {
            throw SpecError("\(name)\(e.path.isEmpty ? "" : ".\(e.path)")")
        } catch {
            return nil
        }
    }

    /// An object-valued key of a transition: absent, or explicitly null, is nil; anything that IS
    /// there and is not an object fails with the key's own name, and a failure inside it is spliced
    /// behind that name the way `rect` splices one.
    ///
    /// Stricter than `rect` on purpose. A rectangle that is not an object means the whole frame,
    /// which is a sensible thing for it to mean, while a transition, a mask or a curve set that is not
    /// an object means nothing at all - drawing a cut or a mask-less reveal in its place would render
    /// a post nobody asked for without a word.
    func object<T: Decodable>(_ key: Key, _ name: String, _ type: T.Type) throws -> T? {
        guard has(key) else { return nil }
        do {
            return try decode(T.self, forKey: key)
        } catch let e as SpecError {
            throw SpecError("\(name)\(e.path.isEmpty ? "" : ".\(e.path)")")
        } catch {
            // Capacitor's decoder throws a `DecodingError` when the value is not an object.
            throw SpecError(name)
        }
    }

    /// `object`, for a key that must be there: a transition's `from` and its `curves`.
    func requiredObject<T: Decodable>(_ key: Key, _ name: String, _ type: T.Type) throws -> T {
        guard let value = try object(key, name, type) else { throw SpecError(name) }
        return value
    }

    /// One transition curve: 2...121 finite numbers, each held to `range`. Android's `readCurve`.
    ///
    /// Absent, or null, is nil: the channel holds its neutral value for the whole window. Anything
    /// else that is not such an array - a number, an object, too few samples or too many, an array
    /// holding a string or a null - fails with the curve's own path, because a curve with a hole in
    /// it has no sensible reading. Whether the curves agree about their LENGTH is not this reader's
    /// question: every curve read is appended to `read`, and `CurvesDTO` asks it once, last, of all
    /// of them together, which is where Android asks it.
    func curve(_ key: Key, _ path: String, _ range: ClosedRange<Double>,
               _ read: inout [(path: String, count: Int)]) throws -> [Double]? {
        guard has(key) else { return nil }
        guard var list = try? nestedUnkeyedContainer(forKey: key),
              let count = list.count,
              count >= ComposeSpecParser.minCurveSamples,
              count <= ComposeSpecParser.maxCurveSamples else { throw SpecError(path) }
        var values: [Double] = []
        values.reserveCapacity(count)
        while !list.isAtEnd {
            // Capacitor's container advances past an element even when decoding it throws, but
            // nothing here relies on that: the first bad element ends the read.
            guard let v = try? list.decode(Double.self), v.isFinite else { throw SpecError(path) }
            values.append(min(range.upperBound, max(range.lowerBound, v)))
        }
        read.append((path: path, count: values.count))
        return values
    }

    /// `fromTint` / `toTint`: exactly three finite numbers, each held to 0...1. Absent, or null, is
    /// nil and becomes black; anything else fails with the key's own name. Exactly three and not "at
    /// least three" as a filter's `rgb` is read, because nothing sends a fourth here and a fourth is
    /// far more likely an alpha somebody expected to be honoured than a number to be ignored.
    func rgb(_ key: Key, _ path: String) throws -> [Double]? {
        guard has(key) else { return nil }
        guard var list = try? nestedUnkeyedContainer(forKey: key), list.count == 3 else {
            throw SpecError(path)
        }
        var rgb: [Double] = []
        while !list.isAtEnd {
            guard let v = try? list.decode(Double.self), v.isFinite else { throw SpecError(path) }
            rgb.append(min(1, max(0, v)))
        }
        return rgb
    }
}

/// A coding key for any name at all, so that a container can list keys this parser does not know.
/// Only the two levels of a transition's `curves` ask, because only there is an unknown key an
/// error: a channel spelt wrong would otherwise hold its neutral value in silence and the post would
/// render a transition that is not the one the customer picked.
private struct AnyKey: CodingKey {
    let stringValue: String
    init?(stringValue: String) { self.stringValue = stringValue }
    var intValue: Int? { nil }
    init?(intValue: Int) { return nil }
}

/// The alphabetically first key of `c` that is not one of `known`, or nil.
///
/// Android reports the first unknown key in the order the object was written, because its org.json
/// keeps that order. Nothing here can: the object crossed the bridge as a Swift dictionary, which
/// keeps none. So a spec carrying ONE unknown key at a level - the only kind a caller makes by
/// accident - reports the same path on both platforms, and one carrying several reports the
/// alphabetically first here, which at least names the same key every time the spec is sent.
private func firstUnknownKey(_ c: KeyedDecodingContainer<AnyKey>, known: [String]) -> String? {
    c.allKeys.map(\.stringValue).filter { !known.contains($0) }.sorted().first
}

// MARK: - Wire DTOs

/// A faithful picture of the wire, nothing more. Every one of these is private to this file: no
/// other file in the module ever sees a DTO, only the validated `ComposeSpec`.
private struct ComposeSpecDTO: Decodable {
    let jobId: String
    let batchId: String
    let clips: [ClipDTO]
    /// One per entry of `clips`, in step with it: each base clip's `transitionIn`, or nil. The first
    /// is always nil, because the first clip's key is never read.
    let transitions: [TransitionDTO?]
    /// nil for a spec with no `tracks` key, which is not the same thing as an empty array and is
    /// carried all the way to `ComposeSpec.tracks` as itself.
    let tracks: [TrackDTO]?
    let output: OutputDTO?
    let filter: [FilterOp]
    let overlays: [OverlayDTO]
    let audio: AudioDTO
    let posterAtMs: Int64
    /// 0 for a spec with no `durationMs` key, which is every spec written before the tail existed
    /// and every spec a post nobody has stretched still sends.
    let durationMs: Int64

    /// nil for a spec with no `camera` key, or an explicit null. Shape-checked but NOT yet clamped:
    /// `validate` clamps it, and drops it when it never magnifies.
    let camera: CameraDTO?

    /// The first error found in `filter`, `overlays`, `audio` or `camera`, held rather than thrown
    /// so that `validate` can run the `output` checks in front of it. Decoding stops at that first error,
    /// which is what makes "the first one held" and "the first one Android reports" the same error.
    let heldError: SpecError?

    private enum K: String, CodingKey {
        case jobId, batchId, clips, tracks, output, filter, overlays, audio, posterAtMs, durationMs, camera
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: K.self) else { throw SpecError("clips") }

        jobId = c.string(.jobId)
        batchId = c.string(.batchId)
        if jobId.isEmpty { throw SpecError("jobId") }
        if batchId.isEmpty { throw SpecError("batchId") }

        // Missing, not an array, and empty all report the bare `clips` path.
        guard var clipArray = try? c.nestedUnkeyedContainer(forKey: .clips), (clipArray.count ?? 0) > 0 else {
            throw SpecError("clips")
        }
        var decodedClips: [ClipDTO] = []
        var decodedTransitions: [TransitionDTO?] = []
        while !clipArray.isAtEnd {
            // `currentIndex` is read BEFORE the decode because `UnkeyedContainer.decode` advances it
            // in a `defer`, so a throw would otherwise report the next element's index.
            let i = clipArray.currentIndex
            do {
                if i == 0 {
                    // The plain clip reader, so a `transitionIn` on the first clip is not even
                    // looked at: there is nothing before it to come from, and `definitions.ts` has
                    // an engine ignore one there rather than fail it.
                    decodedClips.append(try clipArray.decode(ClipDTO.self))
                    decodedTransitions.append(nil)
                } else {
                    let base = try clipArray.decode(BaseClipDTO.self)
                    decodedClips.append(base.clip)
                    decodedTransitions.append(base.transitionIn)
                }
            } catch let e as SpecError {
                // An element cannot see its own index, so it throws the leaf path and the parent
                // splices the index in.
                throw SpecError("clips[\(i)]\(e.path.isEmpty ? "" : ".\(e.path)")")
            } catch {
                // Not an object at all. Android's `optJSONObject(i)` returns null and reports the
                // element itself with no field.
                throw SpecError("clips[\(i)]")
            }
        }
        clips = decodedClips
        transitions = decodedTransitions

        // Read between `clips` and `output`, where it sits on the wire, and thrown at once rather
        // than held back: a layer's clips are the same kind of thing as the base track's, so a bad
        // one earns the same treatment as a bad base clip.
        //
        // A `tracks` that is present but is not an array at all reads as ABSENT, which is what
        // Android's `optJSONArray` answers for it. Absent is a legal spec here, unlike `clips`, so
        // there is nothing to report and nothing a caller could act on.
        var decodedTracks: [TrackDTO]?
        if var trackArray = try? c.nestedUnkeyedContainer(forKey: .tracks) {
            // The COUNT before a single track is parsed, exactly as the overlays' cap is, so a spec
            // sending three layers whose first is also broken reports the cap and not the layer.
            // The cap counts the base track, which is why it is one fewer here.
            // Refused rather than truncated, and Android's wording to the character: a caller
            // asking for four layers believes it is getting four, and the port tests compare these
            // messages literally.
            if (trackArray.count ?? 0) > ComposeSpecParser.maxVideoTracks - 1 {
                throw SpecError(
                    "tracks",
                    "invalid_spec:tracks at most \(ComposeSpecParser.maxVideoTracks - 1) extra video tracks"
                )
            }
            var decoded: [TrackDTO] = []
            while !trackArray.isAtEnd {
                let i = trackArray.currentIndex
                do {
                    decoded.append(try trackArray.decode(TrackDTO.self))
                } catch let e as SpecError {
                    throw SpecError("tracks[\(i)]\(e.path.isEmpty ? "" : ".\(e.path)")")
                } catch {
                    throw SpecError("tracks[\(i)]")
                }
            }
            decodedTracks = decoded
        }
        tracks = decodedTracks

        // nil also covers "present but not an object". `validate` turns it into `output`.
        output = try? c.decode(OutputDTO.self, forKey: .output)

        var held: SpecError?

        var ops: [FilterOp] = []
        if var f = try? c.nestedUnkeyedContainer(forKey: .filter) {
            while !f.isAtEnd {
                let i = f.currentIndex
                do {
                    ops.append(try f.decode(FilterOp.self))
                } catch let e as FilterParseError {
                    held = e.specError(index: i)
                    break
                } catch let e as SpecError {
                    held = e
                    break
                } catch {
                    held = SpecError("filter[\(i)]")
                    break
                }
            }
        }
        filter = ops

        var decodedOverlays: [OverlayDTO] = []
        if held == nil, var o = try? c.nestedUnkeyedContainer(forKey: .overlays) {
            // The COUNT is checked before a single overlay is parsed, so 31 overlays whose first
            // one is broken reports `overlays`, not `overlays[0]`.
            if (o.count ?? 0) > ComposeSpecParser.maxOverlays {
                held = SpecError("overlays")
            } else {
                while !o.isAtEnd {
                    let i = o.currentIndex
                    do {
                        decodedOverlays.append(try o.decode(OverlayDTO.self))
                    } catch let e as SpecError {
                        held = SpecError("overlays[\(i)]\(e.path.isEmpty ? "" : ".\(e.path)")")
                        break
                    } catch {
                        held = SpecError("overlays[\(i)]")
                        break
                    }
                }
            }
        }
        overlays = decodedOverlays

        var decodedAudio = AudioDTO.empty
        if held == nil {
            do {
                if let a = try c.decodeIfPresent(AudioDTO.self, forKey: .audio) { decodedAudio = a }
            } catch let e as SpecError {
                held = e
            } catch {
                // A missing `audio`, a null one, or one that is not an object at all are all the
                // same tolerated default on Android. There is no `audio` path in the catalogue.
            }
        }
        audio = decodedAudio

        // Last, after the voiceovers, where Android's `parseCamera` reads it, and HELD like
        // everything else past `output`, so a spec that is wrong in both `output` and `camera` names
        // `output` on both platforms. Absent, or null, is no camera. Present but not an object fails
        // as `camera` - the transitions' rule and not the rectangles' - because a mangled camera
        // means nothing, and rendering the post unzoomed in its place would ship a video nobody
        // asked for without a word.
        //
        // Decoded directly rather than through `object`: `CameraDTO` throws Android's two custom
        // messages, and `object` rebuilds every error from its path alone, which would drop them.
        var decodedCamera: CameraDTO?
        if held == nil && c.has(.camera) {
            do {
                decodedCamera = try c.decode(CameraDTO.self, forKey: .camera)
            } catch let e as SpecError {
                held = e
            } catch {
                // Capacitor's decoder throws a `DecodingError` when the value is not an object.
                held = SpecError("camera")
            }
        }
        camera = decodedCamera

        heldError = held
        posterAtMs = max(0, c.long(.posterAtMs, 0))
        durationMs = max(0, c.long(.durationMs, 0))
    }
}

/// `camera`: four PARALLEL arrays, `atMs`, `scale`, `cx` and `cy`, exactly as `ComposeCamera` puts
/// them on the wire. `normaliseCamera` in `src/editor/camera.ts` is the rule book; Android's
/// `parseCamera` is the order and the wording, and this is its shape half, check for check.
/// `ComposeSpecParser.cameraKeys` is its clamping half.
///
/// - `atMs` absent or null: no camera. `atMs` present but not an array: `camera.atMs`.
/// - `atMs` empty: no camera.
/// - `scale`, `cx` or `cy` not an array exactly as long as `atMs`: `camera`, with Android's message.
/// - more than `maxCameraKeys` keys: `camera`, with Android's message - refused, never truncated.
///   Checked AFTER the lengths, as Android does, and before a single element is read.
/// - a time that is not a finite number, or that is less than the one before it:
///   `camera.atMs[i]`. Equal times are legal - they are a step.
/// - a `scale`, `cx` or `cy` element that is not a finite number is NOT refused: it is carried as
///   NaN, and `CameraMath.clamped` reads NaN as the whole frame, which is what `clampView` does.
///
/// Full paths are thrown from here, not leaf paths: there is exactly one camera, so nothing above
/// has an index to splice in.
private struct CameraDTO: Decodable {
    let atMs: [Double]
    let scale: [Double]
    let cx: [Double]
    let cy: [Double]

    private enum K: String, CodingKey {
        case atMs, scale, cx, cy
    }

    init(from decoder: Decoder) throws {
        // Not an object throws a DecodingError here, which the caller reports as `camera`.
        let c = try decoder.container(keyedBy: K.self)
        guard c.has(.atMs) else {
            atMs = []
            scale = []
            cx = []
            cy = []
            return
        }
        guard var timeList = try? c.nestedUnkeyedContainer(forKey: .atMs),
              let n = timeList.count else { throw SpecError("camera.atMs") }
        guard n > 0 else {
            atMs = []
            scale = []
            cx = []
            cy = []
            return
        }
        // Every length before any element, so a camera that is wrong in both its lengths and its
        // key count reports the lengths, as Android does.
        guard var scaleList = CameraDTO.list(c, .scale), scaleList.count == n,
              var cxList = CameraDTO.list(c, .cx), cxList.count == n,
              var cyList = CameraDTO.list(c, .cy), cyList.count == n else {
            throw SpecError("camera", "invalid_spec:camera atMs, scale, cx and cy must all have the same length")
        }
        if n > ComposeSpecParser.maxCameraKeys {
            throw SpecError("camera", "invalid_spec:camera at most \(ComposeSpecParser.maxCameraKeys) keys")
        }
        let times = CameraDTO.numbers(&timeList, n)
        for i in 0..<n {
            // NaN fails `isFinite`, so a time that was not a number at all stops here too.
            guard times[i].isFinite else { throw SpecError("camera.atMs[\(i)]") }
            if i > 0 && times[i] < times[i - 1] { throw SpecError("camera.atMs[\(i)]") }
        }
        atMs = times
        scale = CameraDTO.numbers(&scaleList, n)
        cx = CameraDTO.numbers(&cxList, n)
        cy = CameraDTO.numbers(&cyList, n)
    }

    /// The array under `key`, not yet read, or nil when it is absent, null or not an array.
    private static func list(_ c: KeyedDecodingContainer<K>, _ key: K) -> UnkeyedDecodingContainer? {
        guard c.has(key) else { return nil }
        return try? c.nestedUnkeyedContainer(forKey: key)
    }

    /// Exactly `n` numbers out of `list`, each a finite Double or NaN for anything else - a null,
    /// a string, an object, or an element missing off the end.
    ///
    /// The loop is bounded by `n` and not by `isAtEnd`: the elements are read with `try?`, and a
    /// container that failed to step past a bad element must not spin here for ever, nor hand back
    /// fewer numbers than the other three arrays and send an index out of range downstream.
    private static func numbers(_ list: inout UnkeyedDecodingContainer, _ n: Int) -> [Double] {
        var out: [Double] = []
        out.reserveCapacity(n)
        for _ in 0..<n {
            if !list.isAtEnd, let v = try? list.decode(Double.self), v.isFinite {
                out.append(v)
            } else {
                out.append(Double.nan)
            }
        }
        return out
    }
}

private struct ClipDTO: Decodable {
    let key: String
    let uri: String
    let inMs: Int64
    let outMs: Int64
    let speed: Double
    let volume: Double
    let muted: Bool
    let fit: String
    /// Raw, not yet clamped: `validate` does that, in the same pass that clamps speed and volume.
    let crop: RectDTO?
    let rect: RectDTO?

    private enum K: String, CodingKey {
        case key, uri, inMs, outMs, speed, volume, muted, fit, crop, rect
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)   // an element that is not an object throws here
        key = c.string(.key)
        if key.isEmpty { throw SpecError("key") }
        uri = c.string(.uri)
        if uri.isEmpty { throw SpecError("uri") }
        // The -1 fallback is what makes a MISSING `inMs` report `inMs` rather than passing as 0.
        inMs = c.long(.inMs, -1)
        if inMs < 0 { throw SpecError("inMs") }
        outMs = c.long(.outMs, -1)
        // Any `outMs > inMs` is legal. There is deliberately no 300 ms minimum: the JS producer only
        // guarantees `inMs + 100`, so a 100 ms segment is reachable and Android renders it.
        if outMs <= inMs { throw SpecError("outMs") }
        speed = c.double(.speed, 1)
        volume = c.double(.volume, 1)
        muted = c.flag(.muted, false)
        fit = c.string(.fit)
        // Last, and in wire order, so that a clip which is wrong in both an old field and a new one
        // still reports the old field. Nothing before this line has changed meaning.
        crop = try c.rect(.crop, "crop")
        rect = try c.rect(.rect, "rect")
    }
}

/// A base clip from the second on: the clip, read by the one reader every clip goes through, and
/// then its `transitionIn`.
///
/// The element is read twice - once as a clip, once for the single key only a base clip may carry -
/// rather than `ClipDTO` learning the key. `ClipDTO` also reads a layer's clips and a transition's
/// own `from`, and in both places the key is to be ignored without being read, which a reader that
/// knew about it would have to be told not to do. Capacitor's decoder hands out a fresh container
/// every time one is asked for, so reading an element twice costs a second dictionary lookup.
private struct BaseClipDTO: Decodable {
    let clip: ClipDTO
    let transitionIn: TransitionDTO?

    private enum K: String, CodingKey { case transitionIn }

    init(from decoder: Decoder) throws {
        // The clip's own fields first, so a clip that is wrong both in an old field and in its
        // transition reports the old field, exactly as a clip wrong in `outMs` and `crop` does.
        clip = try ClipDTO(from: decoder)
        let c = try decoder.container(keyedBy: K.self)
        transitionIn = try c.object(.transitionIn, "transitionIn", TransitionDTO.self)
    }
}

/// `ComposeClip.transitionIn` on the wire. Throws leaf paths - `kind`, `from.outMs`, `curves.to.x`,
/// `mask.shape` - and `BaseClipDTO` and the clip loop splice `clips[i].transitionIn.` in front.
///
/// `kind` has to be there and is otherwise taken on trust. Nothing in this engine draws differently
/// for it, so an id this build has never heard of is a transition drawn from its numbers exactly
/// like any other, and refusing it would make every catalogue addition a native release.
private struct TransitionDTO: Decodable {
    let kind: String
    let from: ClipDTO
    let curves: CurvesDTO
    let mask: MaskDTO?
    /// Already held to 0...1, three channels exactly, or nil for black.
    let fromTint: [Double]?
    let toTint: [Double]?

    private enum K: String, CodingKey { case kind, from, curves, mask, fromTint, toTint }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        kind = c.string(.kind)
        if kind.isEmpty { throw SpecError("kind") }
        // The same reader as every other clip, so a bad tail reports the clip field that is bad,
        // `from.outMs`, rather than a vaguer `from`.
        from = try c.requiredObject(.from, "from", ClipDTO.self)
        curves = try c.requiredObject(.curves, "curves", CurvesDTO.self)
        mask = try c.object(.mask, "mask", MaskDTO.self)
        fromTint = try c.rgb(.fromTint, "fromTint")
        toTint = try c.rgb(.toTint, "toTint")
    }
}

/// `ComposeTransitionCurves` on the wire, with every sample held to its channel's range.
///
/// The ranges are wide enough for anything the catalogue does - a zoom to 2.6, a spin through 180
/// degrees, a flash to a gain of 6 - and narrow enough that a hand-built spec cannot ask for a blur
/// the size of the frame or a scale that turns one pixel into the whole render.
private struct CurvesDTO: Decodable {
    let alpha: [Double]?
    let reveal: [Double]?
    let from: SideCurvesDTO?
    let to: SideCurvesDTO?

    private enum K: String, CodingKey, CaseIterable { case alpha, reveal, from, to }

    /// Android's `parseCurves`, in its order: `alpha`, `reveal`, each side (its channels, then its
    /// unknown keys), then the unknown keys of this object, and LAST the lengths - every curve read
    /// against the first one read, the first that disagrees reported by its own path.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        var read: [(path: String, count: Int)] = []
        alpha = try c.curve(.alpha, "alpha", 0...1, &read)
        reveal = try c.curve(.reveal, "reveal", 0...1, &read)
        from = try SideCurvesDTO.read(c, .from, "from", &read)
        to = try SideCurvesDTO.read(c, .to, "to", &read)
        let all = try decoder.container(keyedBy: AnyKey.self)
        if let unknown = firstUnknownKey(all, known: K.allCases.map(\.rawValue)) { throw SpecError(unknown) }
        if let first = read.first, let odd = read.first(where: { $0.count != first.count }) {
            throw SpecError(odd.path)
        }
    }
}

/// `ComposeTransitionSideCurves` on the wire. Not `Decodable`, because every curve it reads joins
/// the list the lengths are checked against at the end, and a `Decodable` initialiser takes nothing
/// but its decoder.
private struct SideCurvesDTO {
    let x: [Double]?
    let y: [Double]?
    let scale: [Double]?
    let rotation: [Double]?
    let blur: [Double]?
    let pixelate: [Double]?
    let split: [Double]?
    let gain: [Double]?
    let tint: [Double]?

    enum K: String, CodingKey, CaseIterable {
        case x, y, scale, rotation, blur, pixelate, split, gain, tint
    }

    /// One side, `from` or `to`, out of the curves object `c`: Android's `parseSideCurves`. `name`
    /// is the side's own name and is the front of every path this throws, so a bad channel reads
    /// `from.blur`. Absent, or null, is nil; anything else that is not an object fails as `name`.
    static func read<P: CodingKey>(_ c: KeyedDecodingContainer<P>, _ key: P, _ name: String,
                                   _ read: inout [(path: String, count: Int)]) throws -> SideCurvesDTO? {
        guard c.has(key) else { return nil }
        guard let s = try? c.nestedContainer(keyedBy: K.self, forKey: key),
              let all = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: key) else {
            throw SpecError(name)
        }
        // `TransitionSide` order, which is also the order the paths are checked in. One statement
        // per channel, so the order is on the page rather than left to argument evaluation.
        let x = try s.curve(.x, "\(name).x", -4...4, &read)
        let y = try s.curve(.y, "\(name).y", -4...4, &read)
        let scale = try s.curve(.scale, "\(name).scale", 0.01...20, &read)
        let rotation = try s.curve(.rotation, "\(name).rotation", -3600...3600, &read)
        let blur = try s.curve(.blur, "\(name).blur", 0...0.5, &read)
        let pixelate = try s.curve(.pixelate, "\(name).pixelate", 0...0.5, &read)
        let split = try s.curve(.split, "\(name).split", -0.5...0.5, &read)
        let gain = try s.curve(.gain, "\(name).gain", 0...10, &read)
        let tint = try s.curve(.tint, "\(name).tint", 0...1, &read)
        // The side's unknown keys AFTER its channels, as Android checks them.
        if let unknown = firstUnknownKey(all, known: K.allCases.map(\.rawValue)) {
            throw SpecError("\(name).\(unknown)")
        }
        return SideCurvesDTO(x: x, y: y, scale: scale, rotation: rotation, blur: blur,
                             pixelate: pixelate, split: split, gain: gain, tint: tint)
    }
}

/// `ComposeTransitionMask` on the wire. The shape is the only thing that can be wrong; everything
/// else is a value, defaulted when it is missing or not a number and clamped when it is out of range,
/// on the line this file draws everywhere.
private struct MaskDTO: Decodable {
    let shape: ComposeTransitionMask.Shape
    let angleDeg: Double
    let count: Int
    let feather: Double
    let invert: Bool

    private enum K: String, CodingKey { case shape, angleDeg, count, feather, invert }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        // An unknown shape is refused rather than drawn as some other one: the engine would have to
        // guess which reveal was meant, and a guess is a different transition from the one picked.
        guard let shape = ComposeTransitionMask.Shape(rawValue: c.string(.shape)) else {
            throw SpecError("shape")
        }
        self.shape = shape
        angleDeg = c.double(.angleDeg, 0)
        // Held to a slat count a frame can show, then rounded half up as `Math.round` rounds it in
        // `maskMeasure` and as Android rounds it - clamped FIRST, so a huge count cannot overflow the
        // conversion.
        count = Int((min(64, max(1, c.double(.count, 1))) + 0.5).rounded(.down))
        feather = min(0.5, max(0.0005, c.double(.feather, 0.01)))
        invert = c.flag(.invert, false)
    }
}

/// `ComposeClip.crop` and `ComposeClip.rect` on the wire. Normalised 0...1, TOP-LEFT origin, y down.
///
/// It throws the leaf path only (`w`, `h`), because a rectangle cannot see which field it hangs off
/// any more than a clip can see its own index; the container's `rect` reader splices the name in.
private struct RectDTO: Decodable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    /// Raw and unclamped. nil is upright, and only `clampPlacement` keeps it: on a crop it is
    /// dropped.
    let rotationDeg: Double?

    private enum K: String, CodingKey { case x, y, w, h, rotationDeg }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        // `double` reads through `number`, which answers nil for a missing key, a null, a string and
        // for NaN or an infinity alike, so the 0 fallback is what every non-finite value collapses
        // to. For x and y that 0 is the sane default and is clamped anyway; for w and h it fails the
        // test below, which is how "the rectangle has no size" and "the rectangle is not a number"
        // end up reporting the same field, exactly as `wPx` does for an overlay.
        x = c.double(.x, 0)
        y = c.double(.y, 0)
        w = c.double(.w, 0)
        if w <= 0 { throw SpecError("w") }
        h = c.double(.h, 0)
        if h <= 0 { throw SpecError("h") }
        // `number` rather than `double`, because absent has to stay absent all the way to the plan:
        // it is what the builder tests to leave the rotation out of the transform entirely. That
        // also drops a NaN or an infinity to upright rather than carrying one into a CGAffineTransform.
        rotationDeg = c.number(.rotationDeg)
    }
}

/// `ComposeTrack` on the wire. Its clips decode exactly as the base track's do and throw the same
/// leaf paths, which this splices an index into before the container splices the layer's own: a bad
/// clip on a layer reads `tracks[0].clips[1].outMs`.
private struct TrackDTO: Decodable {
    let id: String
    let clips: [ClipDTO]
    let startMs: Int64
    let z: Int
    let opacity: Double

    private enum K: String, CodingKey { case id, clips, startMs, z, opacity }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = c.string(.id)
        if id.isEmpty { throw SpecError("id") }

        // Missing, not an array, and empty all report the bare `clips` path, exactly as the base
        // track's do. An empty layer draws nothing and the editor drops it rather than carrying it
        // around, so one arriving here is a manifest that was already wrong.
        guard var array = try? c.nestedUnkeyedContainer(forKey: .clips), (array.count ?? 0) > 0 else {
            throw SpecError("clips")
        }
        var decoded: [ClipDTO] = []
        while !array.isAtEnd {
            let i = array.currentIndex
            do {
                decoded.append(try array.decode(ClipDTO.self))
            } catch let e as SpecError {
                throw SpecError("clips[\(i)]\(e.path.isEmpty ? "" : ".\(e.path)")")
            } catch {
                throw SpecError("clips[\(i)]")
            }
        }
        clips = decoded

        // Clamped to zero rather than rejected, which is not this file's instinct for a timeline
        // that has been got wrong but IS what Android does, and parity beats instinct here: this
        // parser exists to throw the exact error Android throws for the same payload, and an error
        // Android never throws is a spec one phone posts and the other refuses.
        startMs = max(0, c.long(.startMs, 0))

        // Clamped, in this file's usual direction for a value that is merely out of range. Zero is
        // the base track's own z and a tie breaks on spec order with the base first, so a negative
        // one lands the layer immediately above the base rather than underneath it, where nothing
        // may go: the base is the bottom of the frame.
        z = max(0, c.int(.z, 0))
        opacity = c.double(.opacity, 1)
    }
}

private struct OutputDTO: Decodable {
    let width: Int
    let height: Int
    let fps: Int
    let videoBitrate: Int
    let audioBitrate: Int

    private enum K: String, CodingKey { case width, height, fps, videoBitrate, audioBitrate }

    /// Deliberately total: every field falls back to 0 and the rejection happens in `validate`, so
    /// that a bad clip is still reported before a zero width.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        width = c.int(.width, 0)
        height = c.int(.height, 0)
        fps = c.int(.fps, 0)
        videoBitrate = c.int(.videoBitrate, 0)
        audioBitrate = c.int(.audioBitrate, 0)
    }
}

private struct OverlayDTO: Decodable {
    let id: String
    let png: String
    let cx: Double
    let cy: Double
    let wPx: Int
    let hPx: Int
    let rotationDeg: Double
    let startMs: Int64
    let endMs: Int64
    let opacity: Double

    private enum K: String, CodingKey {
        case id, png, cx, cy, wPx, hPx, rotationDeg, startMs, endMs, opacity
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = c.string(.id)
        if id.isEmpty { throw SpecError("id") }
        png = c.string(.png)
        // The strict prefix test, not a search for the "base64," marker: the decoder later splits on
        // that marker, so a data URL carrying parameters between the mime type and `base64,` would
        // pass the split and fail here, which is the side we want to fail on.
        if !png.hasPrefix(ComposeSpecParser.pngDataURLPrefix) { throw SpecError("png") }
        wPx = c.int(.wPx, 0)
        if wPx <= 0 { throw SpecError("wPx") }
        hPx = c.int(.hPx, 0)
        if hPx <= 0 { throw SpecError("hPx") }
        // `startMs` is clamped BEFORE the comparison, which is why `startMs: -100, endMs: 0` reports
        // `endMs` and not `startMs`.
        startMs = max(0, c.long(.startMs, 0))
        endMs = c.long(.endMs, 0)
        if endMs <= startMs { throw SpecError("endMs") }
        cx = c.double(.cx, 0.5)
        cy = c.double(.cy, 0.5)
        rotationDeg = c.double(.rotationDeg, 0)
        opacity = c.double(.opacity, 1)
    }
}

private struct MusicDTO: Decodable {
    let uri: String
    let startMs: Int64
    let inMs: Int64
    let outMs: Int64
    let volume: Double
    let loop: Bool
    let fadeInMs: Int64
    let fadeOutMs: Int64

    private enum K: String, CodingKey {
        case uri, startMs, inMs, outMs, volume, loop, fadeInMs, fadeOutMs
    }

    /// Throws the full `audio.music.*` path itself: there is no index to splice in, so there is
    /// nothing for the parent to add.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        uri = c.string(.uri)
        if uri.isEmpty { throw SpecError("audio.music.uri") }
        inMs = max(0, c.long(.inMs, 0))
        outMs = c.long(.outMs, 0)
        if outMs <= inMs { throw SpecError("audio.music.outMs") }
        startMs = max(0, c.long(.startMs, 0))
        volume = c.double(.volume, 1)
        loop = c.flag(.loop, false)
        fadeInMs = max(0, c.long(.fadeInMs, 0))
        fadeOutMs = max(0, c.long(.fadeOutMs, 0))
    }
}

private struct VoiceDTO: Decodable {
    let uri: String
    let startMs: Int64
    let durationMs: Int64
    let volume: Double

    private enum K: String, CodingKey { case uri, startMs, durationMs, volume }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        uri = c.string(.uri)
        if uri.isEmpty { throw SpecError("uri") }
        durationMs = c.long(.durationMs, 0)
        if durationMs <= 0 { throw SpecError("durationMs") }
        startMs = max(0, c.long(.startMs, 0))
        volume = c.double(.volume, 1)
    }
}

private struct AudioDTO: Decodable {
    let originalMuted: Bool
    let originalVolume: Double
    let music: MusicDTO?
    let voiceover: [VoiceDTO]

    static let empty = AudioDTO(originalMuted: false, originalVolume: 1, music: nil, voiceover: [])

    private enum K: String, CodingKey { case originalMuted, originalVolume, music, voiceover }

    private init(originalMuted: Bool, originalVolume: Double, music: MusicDTO?, voiceover: [VoiceDTO]) {
        self.originalMuted = originalMuted
        self.originalVolume = originalVolume
        self.music = music
        self.voiceover = voiceover
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        // `decodeIfPresent`, never `decode`: JS writes `music: null` explicitly when there is no
        // track rather than omitting the key, and Capacitor's `decodeNil(forKey:)` reports both a
        // missing key and an `NSNull` as nil. A plain `decode` would throw on every spec without
        // music, which is most of them.
        music = try c.decodeIfPresent(MusicDTO.self, forKey: .music)

        var takes: [VoiceDTO] = []
        if var v = try? c.nestedUnkeyedContainer(forKey: .voiceover) {
            while !v.isAtEnd {
                let i = v.currentIndex
                do {
                    takes.append(try v.decode(VoiceDTO.self))
                } catch let e as SpecError {
                    throw SpecError("audio.voiceover[\(i)]\(e.path.isEmpty ? "" : ".\(e.path)")")
                } catch {
                    throw SpecError("audio.voiceover[\(i)]")
                }
            }
        }
        voiceover = takes

        originalMuted = c.flag(.originalMuted, false)
        originalVolume = c.double(.originalVolume, 1)
    }
}

// MARK: - FilterOp

/// A filter element cannot see its own index either, and unlike the other elements its three
/// failures land on three different paths, so it carries the reason rather than a leaf path.
private enum FilterParseError: Error {
    case missingAmount
    case badRGB
    case unknownOp(String)

    func specError(index i: Int) -> SpecError {
        switch self {
        case .missingAmount:
            return SpecError("filter[\(i)].amount")
        case .badRGB:
            return SpecError("filter[\(i)].rgb")
        case .unknownOp(let op):
            // The only exception in the whole parser with a message that is not just the path. An
            // absent `op` key reads as "", so the message is literally `unknown op ''`.
            return SpecError("filter[\(i)].op", "invalid_spec:filter[\(i)].op unknown op '\(op)'")
        }
    }
}

extension FilterOp: Decodable {
    private enum K: String, CodingKey { case op, amount, degrees, rgb, alpha }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let op = c.string(.op)

        // Presence is checked, then the value is read leniently: Android throws only when the key is
        // absent, and takes 1.0 for a present but non numeric one.
        func amount() throws -> Double {
            guard c.has(.amount) else { throw FilterParseError.missingAmount }
            return c.double(.amount, 1)
        }

        switch op {
        case "brightness":
            self = .brightness(max(0, try amount()))
        case "contrast":
            self = .contrast(max(0, try amount()))
        case "saturate":
            self = .saturate(max(0, try amount()))
        case "sepia":
            self = .sepia(clamp01(try amount()))
        case "grayscale":
            self = .grayscale(clamp01(try amount()))
        case "hueRotate":
            // No presence check and no clamp: a missing `degrees` is 0, which is a no-op, and any
            // angle is meaningful.
            self = .hueRotate(c.double(.degrees, 0))
        case "tint":
            // `>= 3`, not `== 3`. A four element array is accepted and the fourth is ignored, which
            // is what org.json's indexed reads do.
            guard let rgb = try? c.decode([Double].self, forKey: .rgb), rgb.count >= 3 else {
                throw FilterParseError.badRGB
            }
            // Alpha defaults to 0, not 1. A tint with no alpha is then a no-op, which is the safe
            // direction to be wrong in: the opposite default would repaint the whole video.
            self = .tint(r: FilterOp.channel(rgb[0]),
                         g: FilterOp.channel(rgb[1]),
                         b: FilterOp.channel(rgb[2]),
                         alpha: clamp01(c.double(.alpha, 0)))
        default:
            throw FilterParseError.unknownOp(op)
        }
    }

    /// Clamped in Double space and only then converted: `Int(1e300)` traps, and a hand written spec
    /// is exactly the place a number like that turns up.
    private static func channel(_ v: Double) -> Int {
        guard v.isFinite else { return 0 }
        return Int(min(255, max(0, v)).rounded(.towardZero))
    }
}
