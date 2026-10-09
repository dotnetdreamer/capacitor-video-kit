@preconcurrency import AVFoundation
import XCTest
@testable import CapacitorVideoKitCore

/// The audio effect layers on iOS: `audio.effects` read by `normaliseAudioEffectWindows`' rules, in
/// Android's order and words; the arithmetic `AudioEffectRunner` runs, held to the golden numbers the
/// TypeScript and Kotlin tests are held to; and renders that put the whole mix through a window,
/// through either engine, with its tail heard past the last sound.
final class AudioEffectWindowsTests: RenderTestCase {

    private static let rate = 48_000.0

    /// The megaphone at its defaults, exactly as the editor sends it (`SOUND_EFFECTS` in sound-effects.ts).
    private static let megaphone = SoundEffect(mono: true, ops: [
        .highpass(hz: 600, q: 0.7071067811865476),
        .highpass(hz: 600, q: 0.7071067811865476),
        .lowpass(hz: 5000, q: 0.7071067811865476),
        .peak(hz: 1800, q: 1, db: 6),
        .drive(db: 20, followMs: 300),
        .lowpass(hz: 3500, q: 0.7071067811865476),
        .lowpass(hz: 3500, q: 0.7071067811865476),
        .gain(db: -4),
    ])

    /// Slow + reverb's room at the middle of its sliders.
    private static let room = SoundEffect(mono: false, ops: [.reverb(decayMs: 3500, dampHz: 5500, wet: 0.5, dry: 0.8)])

    /// The same numbers as `audio-effect-windows.unit.test.ts` and `AudioEffectWindowsTest.kt`.
    private static let golden: [(Int, Double, Double)] = [
        (0, 0.0, 0.1438276618719101),
        (1199, 0.044410355389118195, -0.13618730008602142),
        (1200, -4.215013398939848e-15, -0.1438276618719101),
        (1201, -0.044400833547115326, -0.15132714807987213),
        (1500, -0.49185290932655334, -0.11205031722784042),
        (2000, 0.032768141478300095, 0.12249194085597992),
        (2640, -0.2707182765007019, -0.18519802391529083),
        (3000, 0.4564398229122162, 0.21684326231479645),
        (4000, 0.05051703006029129, -0.1985909789800644),
        (5000, -0.5568563342094421, -0.011580999940633774),
        (5500, 0.22359101474285126, 0.2720637321472168),
        (5999, 0.08727562427520752, -0.1298135370016098),
        (6000, 0.04416274279356003, -0.1372629702091217),
        (6500, -0.6737513542175293, -0.22825460135936737),
        (7000, 0.5595630407333374, 0.23166373372077942),
        (7199, -0.1436537653207779, 0.13226771354675293),
        (7200, -0.016098592430353165, 0.13931874930858612),
        (7700, -0.15952368080615997, 0.14356045424938202),
        (8000, 0.03796369954943657, -0.05775051191449165),
        (8160, 0.07709841430187225, 0.07709841430187225),
        (8500, -0.13546541333198547, 0.08452267944812775),
        (9000, 0.35746344923973083, 0.27276092767715454),
        (9119, -0.16030138731002808, -0.20032526552677155),
        (9120, -0.102406345307827, -0.1977843940258026),
        (9599, -0.3330191373825073, 0.15811549127101898),
    ]

    private static let goldenWindows = [
        AudioEffectWindow(startMs: 25, endMs: 125, speed: 0.8, effect: room),
        AudioEffectWindow(startMs: 150, endMs: 190, speed: 1, effect: megaphone),
    ]

    /// `STACKED_GOLDEN` in audio-effect-windows.unit.test.ts and `AudioEffectWindowsTest.kt`: on the same
    /// fragment, three windows in an order their times do not follow - the megaphone over 60..170 ms at
    /// the bottom, slow + reverb at 0.8x over 20..120 ms on it, and slow + reverb again at 0.7x over
    /// 40..100 ms on top.
    private static let stackedGolden: [(Int, Double, Double)] = [
        (0, 0.0, 0.1438276618719101),
        (959, -0.659309446811676, 0.046941254287958145),
        (960, -0.5706338882446289, 0.03839000314474106),
        (961, -0.4800061583518982, 0.029803428798913956),
        (1500, -0.6783002614974976, -0.03017522394657135),
        (1919, -0.4438980221748352, -0.07496683299541473),
        (1920, -0.45043906569480896, -0.06907276809215546),
        (1921, -0.4494432806968689, -0.06311457604169846),
        (2400, 0.38878923654556274, -0.09857215732336044),
        (2879, -0.2437334656715393, 0.02293088473379612),
        (2880, -0.2360772043466568, 0.019143102690577507),
        (3500, -0.18928048014640808, 0.03702017292380333),
        (4000, 0.010632151737809181, 0.03684902563691139),
        (4799, -0.08010885119438171, -0.035095661878585815),
        (4800, -0.0975487008690834, -0.04343155398964882),
        (5000, 0.11491679400205612, 0.09258368611335754),
        (5759, 0.14631494879722595, 0.08428686112165451),
        (5760, 0.12154743820428848, 0.05453965440392494),
        (6500, 0.1746111661195755, 0.07624474167823792),
        (7000, 0.24912786483764648, -0.013168036937713623),
        (8159, -0.8366613388061523, 0.033284276723861694),
        (8160, -0.7561161518096924, 0.02355377748608589),
        (8500, -0.21113882958889008, 0.07811340689659119),
        (9000, 0.14763520658016205, 0.23983116447925568),
        (9599, -0.020595934242010117, 0.1534087210893631),
    ]

    private static let stackedWindows = [
        AudioEffectWindow(startMs: 60, endMs: 170, speed: 1, effect: megaphone),
        AudioEffectWindow(startMs: 20, endMs: 120, speed: 0.8, effect: room),
        AudioEffectWindow(startMs: 40, endMs: 100, speed: 0.7, effect: room),
    ]

    /// The fragment the sound effects' golden tests use, a fifth of a second of it, interleaved.
    private static func fragment(_ frames: Int = 9600) -> [Double] {
        var out = [Double](repeating: 0, count: frames * 2)
        for i in 0..<frames {
            out[2 * i] = 0.6 * sin(2 * .pi * 440 * Double(i) / rate) + 0.2 * sin(2 * .pi * 3100 * Double(i) / rate)
            out[2 * i + 1] = 0.3 * sin(2 * .pi * 220 * Double(i) / rate + 0.5)
        }
        return out
    }

    private static func run(_ windows: [AudioEffectWindow], _ input: [Double], piece: Int = .max) -> [Double] {
        var samples = input
        let runner = AudioEffectRunner(windows: windows, sampleRate: rate, channels: 2)
        let frames = input.count / 2
        samples.withUnsafeMutableBufferPointer { buffer in
            var from = 0
            while from < frames {
                let count = min(piece, frames - from)
                runner.process(buffer.baseAddress! + from * 2, count: count)
                from += count
            }
        }
        return samples
    }

    // MARK: - The arithmetic

    func testMatchesTheGoldenNumbersEveryEngineIsHeldTo() {
        let out = Self.run(Self.goldenWindows, Self.fragment())
        for (i, l, r) in Self.golden {
            XCTAssertEqual(out[2 * i], l, accuracy: 5e-7, "left at \(i)")
            XCTAssertEqual(out[2 * i + 1], r, accuracy: 5e-7, "right at \(i)")
        }
    }

    func testComesOutTheSameWhetherHandedOverWholeOrInPieces() {
        let input = Self.fragment()
        let whole = Self.run(Self.goldenWindows, input)
        for piece in [1, 7, 4096] {
            XCTAssertEqual(Self.run(Self.goldenWindows, input, piece: piece), whole, "in pieces of \(piece)")
        }
    }

    func testStackedWindowsMatchTheGoldenNumbersEveryEngineIsHeldTo() {
        let out = Self.run(Self.stackedWindows, Self.fragment())
        for (i, l, r) in Self.stackedGolden {
            XCTAssertEqual(out[2 * i], l, accuracy: 5e-7, "left at \(i)")
            XCTAssertEqual(out[2 * i + 1], r, accuracy: 5e-7, "right at \(i)")
        }
    }

    func testStackedWindowsComeOutTheSameInPieces() {
        let input = Self.fragment()
        let whole = Self.run(Self.stackedWindows, input)
        for piece in [1, 7, 4096] {
            XCTAssertEqual(Self.run(Self.stackedWindows, input, piece: piece), whole, "in pieces of \(piece)")
        }
    }

    func testWindowsOverTheSameTimeStackALaterOneOnWhatAnEarlierOneMade() {
        let half = SoundEffect(mono: false, ops: [.gain(db: -6.020599913279624)])
        let flat = [Double](repeating: 0.8, count: Int(Self.rate) * 2)
        let out = Self.run([
            AudioEffectWindow(startMs: 100, endMs: 600, speed: 1, effect: half),
            AudioEffectWindow(startMs: 300, endMs: 500, speed: 1, effect: half),
        ], flat)
        XCTAssertEqual(out[2 * 9600], 0.4, accuracy: 5e-7)
        XCTAssertEqual(out[2 * 19200], 0.2, accuracy: 5e-7)
        XCTAssertEqual(out[2 * 26400], 0.4, accuracy: 5e-7)
    }

    func testLeavesEveryFrameOutsideAWindowAndItsTailAsItWas() {
        let input = Self.fragment(48_000)
        let out = Self.run([AudioEffectWindow(startMs: 200, endMs: 300, speed: 1, effect: SoundEffect(mono: false, ops: [.gain(db: -12)]))], input)
        let start = 2 * Int(frameAt(200, rate: Self.rate))
        let tailEnd = 2 * Int(frameAt(300 + 500, rate: Self.rate))
        XCTAssertEqual(Array(out[0..<start]), Array(input[0..<start]))
        XCTAssertEqual(Array(out[tailEnd...]), Array(input[tailEnd...]))
    }

    // MARK: - The wire

    /// A spec whose audio carries `effects`, with a sound on a lane so there is something to hear.
    private func spec(_ effects: Any?) -> [String: Any] {
        var audio: [String: Any] = ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](), "music": NSNull()]
        if let effects { audio["effects"] = effects }
        return TestSpecs.spec([TestSpecs.clip("a", file("a.mp4"), outMs: 2000)], ["audio": audio])
    }

    private let gain: [String: Any] = ["ops": [["op": "gain", "db": -6] as [String: Any]] as [Any]]

    private func assertRefused(_ effects: Any?, _ path: String, message: String? = nil, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try TestCalls.parse(spec(effects)), file: file, line: line) { error in
            let refusal = error as? SpecError
            XCTAssertEqual(refusal?.path, path, file: file, line: line)
            if let message { XCTAssertEqual(refusal?.message, message, file: file, line: line) }
        }
    }

    func testTheWindowsAreReadAsTheyWereSentAndOneThatChangesNothingIsLeftOff() throws {
        let effects = try TestCalls.parse(spec([
            ["startMs": -5, "endMs": 900, "speed": 0.1, "effect": gain] as [String: Any],
            ["startMs": 900, "endMs": 1000] as [String: Any],
            ["startMs": 1000, "endMs": 1500, "speed": 3, "effect": gain] as [String: Any],
        ])).audio.effects
        XCTAssertEqual(effects, [
            AudioEffectWindow(startMs: 0, endMs: 900, speed: 0.5, effect: SoundEffect(mono: false, ops: [.gain(db: -6)])),
            AudioEffectWindow(startMs: 1000, endMs: 1500, speed: 1, effect: SoundEffect(mono: false, ops: [.gain(db: -6)])),
        ])
        XCTAssertEqual(try TestCalls.parse(spec(nil)).audio.effects, [])
        XCTAssertEqual(try TestCalls.parse(spec(NSNull())).audio.effects, [])
    }

    func testAShapeNoEngineCouldPlayIsRefusedWithThePathThatBroke() {
        assertRefused("loud", "audio.effects")
        assertRefused(Array(repeating: ["startMs": 0, "endMs": 1, "effect": gain] as [String: Any], count: 51), "audio.effects",
                      message: "invalid_spec:audio.effects at most 50 windows")
        assertRefused(["one"], "audio.effects[0]")
        assertRefused([["endMs": 900, "effect": gain] as [String: Any]], "audio.effects[0].startMs")
        assertRefused([["startMs": 0, "effect": gain] as [String: Any]], "audio.effects[0].endMs")
        assertRefused([["startMs": 500, "endMs": 500, "effect": gain] as [String: Any]], "audio.effects[0].endMs")
        assertRefused([["startMs": 0, "endMs": 900, "speed": "slow", "effect": gain] as [String: Any]], "audio.effects[0].speed")
        assertRefused([["startMs": 0, "endMs": 900, "effect": "megaphone"] as [String: Any]], "audio.effects[0].effect")
        assertRefused([["startMs": 0, "endMs": 900, "effect": ["ops": [["op": "gain"] as [String: Any]] as [Any]] as [String: Any]] as [String: Any]],
                      "audio.effects[0].effect.ops[0].db")
        assertRefused([["startMs": 0, "endMs": 900, "effect": ["ops": Array(repeating: ["op": "gain", "db": 1] as [String: Any], count: 17)] as [String: Any]] as [String: Any]],
                      "audio.effects[0].effect.ops", message: "invalid_spec:audio.effects[0].effect.ops at most 16 steps")
        assertRefused([["startMs": 0, "endMs": 900, "effect": gain, "volume": 1, "layer": 2] as [String: Any]], "audio.effects[0].layer")
        assertRefused([["startMs": 0, "endMs": 900, "effect": gain] as [String: Any], ["startMs": 800, "endMs": "b"] as [String: Any]],
                      "audio.effects[1].endMs")
    }

    func testWindowsOverTheSameTimeStackInTheOrderTheyCame() throws {
        let effects = try TestCalls.parse(spec([
            ["startMs": 500, "endMs": 1000, "effect": gain] as [String: Any],
            ["startMs": 0, "endMs": 900, "speed": 0.8, "effect": gain] as [String: Any],
            ["startMs": 0, "endMs": 900, "speed": 0.8, "effect": gain] as [String: Any],
        ])).audio.effects
        XCTAssertEqual(effects.map(\.startMs), [500, 0, 0])
        XCTAssertEqual(effects.map(\.speed), [1, 0.8, 0.8])
    }

    // MARK: - The render

    /// A one-second silent video under a 440 Hz tone on a lane, `toneMs` long, with `effects` over it.
    private func render(_ effects: [[String: Any]], toneMs: Int64 = 2000, videoMs: Int64 = 2000, name: String,
                        engines: (first: RenderEngine.Type, fallback: RenderEngine.Type) = (WriterEngine.self, PresetEngine.self)) async throws -> URL {
        let video = try await TestMedia.video(file("v-\(name).mp4"), durationMs: videoMs, color: .red, audio: false)
        let tone = try Self.tone(file("tone-\(name).wav"), durationMs: toneMs)
        let sound: [String: Any] = ["uri": tone.absoluteString, "startMs": 0, "inMs": 0, "outMs": toneMs,
                                    "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]
        var audio: [String: Any] = ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](), "music": NSNull(), "musicTracks": [[sound]]]
        if !effects.isEmpty { audio["effects"] = effects }
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: videoMs)], ["audio": audio])
        let spec = try TestCalls.parse(options)
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        let built = try await CompositionBuilder.build(spec)
        let out = file("\(name).mp4")
        try? FileManager.default.removeItem(at: out)
        _ = try await Exporter.export(built, to: out, tmpDir: JobFolders.exportTmp(spec.batchId), spec: spec, engines: engines) { _ in }
        return out
    }

    /// A mono WAV of 440 Hz at a quarter of full scale.
    private static func tone(_ url: URL, durationMs: Int64, rate: Int = 44_100) throws -> URL {
        let count = rate * Int(durationMs) / 1000
        var data = Data()
        func text(_ s: String) { data.append(contentsOf: Array(s.utf8)) }
        func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { data.append(contentsOf: $0) } }
        text("RIFF"); u32(36 + count * 2); text("WAVE")
        text("fmt "); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        text("data"); u32(count * 2)
        for i in 0..<count {
            let sample = Int16(sin(2 * Double.pi * 440 * Double(i) / Double(rate)) * 8000)
            withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) }
        }
        try data.write(to: url)
        return url
    }

    private let quieter: [String: Any] = ["startMs": 600, "endMs": 1400, "effect": ["ops": [["op": "gain", "db": -12] as [String: Any]] as [Any]] as [String: Any]]

    /// The window takes the mix down a quarter where it is, and leaves it alone either side.
    func testARenderPutsTheMixThroughTheWindowAndNothingElse() async throws {
        let out = try await render([quieter], name: "window")
        let before = try await RobustnessSupport.rms(of: out, from: 0.2, to: 0.5)
        let inside = try await RobustnessSupport.rms(of: out, from: 0.75, to: 1.25)
        let after = try await RobustnessSupport.rms(of: out, from: 1.5, to: 1.8)
        XCTAssertGreaterThan(before, 0.05, "the tone should be heard before the window")
        XCTAssertEqual(inside / before, 0.25, accuracy: 0.03, "12 dB down inside: before \(before), inside \(inside)")
        XCTAssertEqual(after / before, 1, accuracy: 0.05, "back as it was after it: before \(before), after \(after)")
    }

    /// The preset engine - the fallback when the writer cannot take the output - renders the window too:
    /// the mix it encodes already went through it.
    func testTheFallbackEngineHearsTheWindowAsWell() async throws {
        let out = try await render([quieter], name: "fallback", engines: (RefusedWriter.self, PresetEngine.self))
        let before = try await RobustnessSupport.rms(of: out, from: 0.2, to: 0.5)
        let inside = try await RobustnessSupport.rms(of: out, from: 0.75, to: 1.25)
        XCTAssertEqual(inside / before, 0.25, accuracy: 0.03, "12 dB down inside: before \(before), inside \(inside)")
    }

    /// A room over the end of a short sound rings on after it, in a post that goes on silent: the mix
    /// runs to the end of the post.
    func testATailRingsOnPastTheLastSound() async throws {
        let room: [String: Any] = ["startMs": 200, "endMs": 600,
                                   "effect": ["ops": [["op": "reverb", "decayMs": 1500, "dampHz": 8000, "wet": 1, "dry": 1] as [String: Any]] as [Any]] as [String: Any]]
        let dry = try await render([], toneMs: 600, name: "dry")
        let wet = try await render([room], toneMs: 600, name: "wet")
        let silentAfter = try await RobustnessSupport.rms(of: dry, from: 0.8, to: 1.1)
        let ringing = try await RobustnessSupport.rms(of: wet, from: 0.8, to: 1.1)
        XCTAssertLessThan(silentAfter, 0.002, "with no room the post is silent after the sound")
        XCTAssertGreaterThan(ringing, 0.005, "the room should ring on after the sound: \(ringing)")
    }

    /// A post with no window builds exactly the composition it always did: its own tracks, its mix.
    func testAPostWithNoWindowKeepsItsOwnTracksAndMix() async throws {
        let video = try await TestMedia.video(file("v.mp4"), durationMs: 1000, color: .red, audio: false)
        let tone = try Self.tone(file("tone.wav"), durationMs: 1000)
        let sound: [String: Any] = ["uri": tone.absoluteString, "startMs": 0, "inMs": 0, "outMs": 1000,
                                    "volume": 0.5, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]
        func built(_ effects: [[String: Any]]) async throws -> BuiltComposition {
            var audio: [String: Any] = ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](), "music": sound]
            if !effects.isEmpty { audio["effects"] = effects }
            return try await RobustnessSupport.build(TestSpecs.spec([TestSpecs.clip("v", video, outMs: 1000)], ["audio": audio]))
        }
        let plain = try await built([])
        XCTAssertNotNil(plain.audioMix, "a sound at half its level keeps its mix parameters")
        let layered = try await built([["startMs": 200, "endMs": 800, "effect": gain]])
        XCTAssertNil(layered.audioMix, "the mix went into the file, levels and all")
        XCTAssertEqual(layered.composition.tracks(withMediaType: .audio).count, 1)
    }
}

/// A writer that refuses the output, as one does on a phone whose encoder will not take it.
private enum RefusedWriter: RenderEngine {
    static let name = "refused"
    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws {
        throw AVError(.unsupportedOutputSettings)
    }
}
