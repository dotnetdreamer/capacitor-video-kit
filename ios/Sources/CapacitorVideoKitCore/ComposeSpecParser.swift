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
/// `batchId`, the `clips` array, each clip, the `tracks` count, each track and its own clips,
/// `output`, each filter op, the `overlays` count, each overlay, `audio.music`, each voiceover,
/// `posterAtMs`. `output` sitting in the middle of that is why `OutputDTO` decodes leniently and why
/// everything after it holds its first error instead of throwing it (see `heldError`).
enum ComposeSpecParser {
    static let maxOverlays = 30
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

        let clips = d.clips.map(clip)

        // `map` on the OPTIONAL, so a spec that carried no `tracks` key still carries none here.
        // Absence has to survive the parser intact: it is what the builder tests to keep the
        // single-layer path a single-layer edit has always taken.
        let tracks = d.tracks.map { list in
            list.map { t in
                ComposeTrack(id: t.id,
                             clips: t.clips.map(clip),
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
                           posterAtMs: d.posterAtMs)
    }

    /// One decoded clip with its clamps applied. Shared by the base track and every extra layer,
    /// because a clip on the second layer is the same kind of thing as one on the first: the day
    /// the two are read differently is the day one half of a split screen renders differently from
    /// the other.
    private static func clip(_ c: ClipDTO) -> ComposeClip {
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
                    rect: clampPlacement(c.rect))
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
}

// MARK: - Wire DTOs

/// A faithful picture of the wire, nothing more. Every one of these is private to this file: no
/// other file in the module ever sees a DTO, only the validated `ComposeSpec`.
private struct ComposeSpecDTO: Decodable {
    let jobId: String
    let batchId: String
    let clips: [ClipDTO]
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

    /// The first error found in `filter`, `overlays` or `audio`, held rather than thrown so that
    /// `validate` can run the `output` checks in front of it. Decoding stops at that first error,
    /// which is what makes "the first one held" and "the first one Android reports" the same error.
    let heldError: SpecError?

    private enum K: String, CodingKey {
        case jobId, batchId, clips, tracks, output, filter, overlays, audio, posterAtMs, durationMs
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
        while !clipArray.isAtEnd {
            // `currentIndex` is read BEFORE the decode because `UnkeyedContainer.decode` advances it
            // in a `defer`, so a throw would otherwise report the next element's index.
            let i = clipArray.currentIndex
            do {
                decodedClips.append(try clipArray.decode(ClipDTO.self))
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

        heldError = held
        posterAtMs = max(0, c.long(.posterAtMs, 0))
        durationMs = max(0, c.long(.durationMs, 0))
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
