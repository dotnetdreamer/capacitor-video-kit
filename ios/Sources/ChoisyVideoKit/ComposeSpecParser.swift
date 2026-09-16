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
/// `pendingPostId`, the `clips` array, each clip, `output`, each filter op, the `overlays` count,
/// each overlay, `audio.music`, each voiceover, `posterAtMs`. `output` sitting in the middle of that
/// is why `OutputDTO` decodes leniently and why everything after it holds its first error instead of
/// throwing it (see `heldError`).
enum ComposeSpecParser {
    static let maxOverlays = 30
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

        let clips = d.clips.map { c in
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
                        fit: c.fit == Fit.cover.rawValue ? .cover : .contain)
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
                           pendingPostId: d.pendingPostId,
                           clips: clips,
                           output: output,
                           filter: d.filter,
                           overlays: overlays,
                           audio: audio,
                           posterAtMs: d.posterAtMs)
    }
}

// MARK: - Clamps

/// `min`/`max` in this order also swallow a NaN, because every comparison against NaN is false and
/// the first argument wins. The lenient readers below already reject non-finite numbers, so this is
/// only the second line of defence, but it is the one that keeps a NaN out of a `CMTime`.
private func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }
private func clamp01(_ v: Double) -> Double { clamp(v, 0, 1) }

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
}

// MARK: - Wire DTOs

/// A faithful picture of the wire, nothing more. Every one of these is private to this file: no
/// other file in the module ever sees a DTO, only the validated `ComposeSpec`.
private struct ComposeSpecDTO: Decodable {
    let jobId: String
    let pendingPostId: String
    let clips: [ClipDTO]
    let output: OutputDTO?
    let filter: [FilterOp]
    let overlays: [OverlayDTO]
    let audio: AudioDTO
    let posterAtMs: Int64

    /// The first error found in `filter`, `overlays` or `audio`, held rather than thrown so that
    /// `validate` can run the `output` checks in front of it. Decoding stops at that first error,
    /// which is what makes "the first one held" and "the first one Android reports" the same error.
    let heldError: SpecError?

    private enum K: String, CodingKey {
        case jobId, pendingPostId, clips, output, filter, overlays, audio, posterAtMs
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: K.self) else { throw SpecError("clips") }

        jobId = c.string(.jobId)
        pendingPostId = c.string(.pendingPostId)
        if jobId.isEmpty { throw SpecError("jobId") }
        if pendingPostId.isEmpty { throw SpecError("pendingPostId") }

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

    private enum K: String, CodingKey { case key, uri, inMs, outMs, speed, volume, muted, fit }

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
