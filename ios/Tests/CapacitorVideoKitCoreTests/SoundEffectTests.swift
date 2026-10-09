import AVFoundation
import XCTest
@testable import CapacitorVideoKitCore

/// A sound's effect on iOS: the wire read by `normaliseSoundEffect`'s rules in Android's order and
/// words, the arithmetic `SoundEffectChain` runs, and a render that plays a sound through the tap. The
/// same cases as `sound-effects.unit.test.ts` and Android's `SoundEffectTest` - the golden fragment
/// included, which all three engines are held to, to the same tolerance.
final class SoundEffectTests: RenderTestCase {

    /// The megaphone exactly as the editor sends it (`SOUND_EFFECTS` in sound-effects.ts).
    private let megaphone: [String: Any] = [
        "mono": true,
        "ops": [
            ["op": "highpass", "hz": 600, "q": 0.7071067811865476] as [String: Any],
            ["op": "highpass", "hz": 600, "q": 0.7071067811865476] as [String: Any],
            ["op": "lowpass", "hz": 5000, "q": 0.7071067811865476] as [String: Any],
            ["op": "peak", "hz": 1800, "q": 1, "db": 6] as [String: Any],
            ["op": "drive", "db": 20, "followMs": 300] as [String: Any],
            ["op": "lowpass", "hz": 3500, "q": 0.7071067811865476] as [String: Any],
            ["op": "lowpass", "hz": 3500, "q": 0.7071067811865476] as [String: Any],
            ["op": "gain", "db": -4] as [String: Any],
        ] as [Any],
    ]

    /// A spec whose one sound carries `effect`, as the post's music or on a lane.
    private func spec(_ effect: Any?, onLane: Bool = false) -> [String: Any] {
        var sound: [String: Any] = ["uri": file("m.m4a").absoluteString, "startMs": 0, "inMs": 0, "outMs": 5000,
                                    "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]
        if let effect { sound["effect"] = effect }
        let audio: [String: Any] = onLane
            ? ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](), "music": NSNull(), "musicTracks": [[sound]]]
            : ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](), "music": sound]
        return TestSpecs.spec([TestSpecs.clip("a", file("a.mp4"), outMs: 2000)], ["audio": audio])
    }

    private func effectOf(_ effect: Any?) throws -> SoundEffect? {
        try TestCalls.parse(spec(effect)).audio.music?.effect
    }

    private func assertRefused(_ effect: Any?, _ path: String, message: String? = nil, onLane: Bool = false,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try TestCalls.parse(spec(effect, onLane: onLane)), file: file, line: line) { error in
            let refusal = error as? SpecError
            XCTAssertEqual(refusal?.path, path, file: file, line: line)
            if let message { XCTAssertEqual(refusal?.message, message, file: file, line: line) }
        }
    }

    // MARK: - The wire

    func testTheMegaphoneTheEditorSendsIsReadAsItWasSent() throws {
        let effect = try XCTUnwrap(try effectOf(megaphone))
        XCTAssertTrue(effect.mono)
        XCTAssertEqual(effect.ops.count, 8)
        XCTAssertEqual(effect.ops[0], .highpass(hz: 600, q: 0.7071067811865476))
        XCTAssertEqual(effect.ops[4], .drive(db: 20, followMs: 300))
        XCTAssertEqual(effect.ops[7], .gain(db: -4))
        // On a lane too, where the sound is read by the same code under another path.
        XCTAssertEqual(try TestCalls.parse(spec(megaphone, onLane: true)).audio.musicTracks[0][0].effect, effect)
    }

    func testNoEffectAndOneThatDoesNothingIsNone() throws {
        XCTAssertNil(try effectOf(nil))
        XCTAssertNil(try effectOf(NSNull()))
        XCTAssertNil(try effectOf([String: Any]()))
        XCTAssertNil(try effectOf(["ops": [Any]()]))
        XCTAssertEqual(try effectOf(["mono": true]), SoundEffect(mono: true, ops: []))
    }

    func testAShapeNoEngineCouldPlayIsRefusedWithThePathThatBroke() {
        let p = "audio.music.effect"
        assertRefused("megaphone", p)
        assertRefused(["mono": "yes", "ops": [Any]()] as [String: Any], "\(p).mono")
        assertRefused(["ops": [String: Any]()], "\(p).ops")
        assertRefused(["ops": [Any](), "wet": 0.5] as [String: Any], "\(p).wet")
        // The alphabetically first of several, as Android and the browser name it.
        assertRefused(["zeta": 1, "ops": [Any](), "alpha": 2] as [String: Any], "\(p).alpha")
        assertRefused(["ops": [7]], "\(p).ops[0]")
        assertRefused(["ops": [["op": "reverb"] as [String: Any]]], "\(p).ops[0].op")
        assertRefused(["ops": [["op": "gain", "db": 1] as [String: Any], ["op": "lowpass", "q": 1] as [String: Any]] as [Any]], "\(p).ops[1].hz")
        assertRefused(["ops": [["op": "lowpass", "hz": "600", "q": 1] as [String: Any]]], "\(p).ops[0].hz")
        assertRefused(["ops": [["op": "peak", "hz": 1000, "q": 1] as [String: Any]]], "\(p).ops[0].db")
        assertRefused(["ops": [["op": "drive", "db": 6, "followMs": "slow"] as [String: Any]]], "\(p).ops[0].followMs")
        assertRefused(["ops": [["op": "gain", "db": 1, "hz": 10] as [String: Any]]], "\(p).ops[0].hz")
        let many = (0...SoundEffect.maxOps).map { _ in ["op": "gain", "db": 0] as [String: Any] }
        assertRefused(["ops": many], "\(p).ops", message: "invalid_spec:\(p).ops at most \(SoundEffect.maxOps) steps")
        // In order: mono, ops, the unknown keys, the count; then a step's op, its numbers, its keys.
        assertRefused(["mono": "x", "ops": 1, "extra": 1] as [String: Any], "\(p).mono")
        assertRefused(["ops": 1, "extra": 1], "\(p).ops")
        assertRefused(["ops": [["op": "nope"] as [String: Any]], "extra": 1] as [String: Any], "\(p).extra")
        assertRefused(["ops": [["op": "peak", "extra": 1] as [String: Any]]], "\(p).ops[0].hz")
    }

    func testALaneNamesItsOwnPathAndKeepsTheCountsWords() {
        let lane = "audio.musicTracks[0][0].effect"
        assertRefused(["ops": [["op": "reverb"] as [String: Any]]], "\(lane).ops[0].op", onLane: true)
        let many = (0...SoundEffect.maxOps).map { _ in ["op": "gain", "db": 0] as [String: Any] }
        assertRefused(["ops": many], "\(lane).ops", message: "invalid_spec:\(lane).ops at most \(SoundEffect.maxOps) steps",
                      onLane: true)
    }

    func testEveryNumberIsHeldToItsRange() throws {
        let effect = try XCTUnwrap(try effectOf(["ops": [
            ["op": "highpass", "hz": 1, "q": 0] as [String: Any],
            ["op": "lowpass", "hz": 96_000, "q": 50] as [String: Any],
            ["op": "peak", "hz": 1000, "q": 1, "db": -99] as [String: Any],
            ["op": "drive", "db": 99, "followMs": 0] as [String: Any],
            ["op": "drive", "db": -3] as [String: Any],
            ["op": "gain", "db": 60] as [String: Any],
        ] as [Any]]))
        XCTAssertEqual(effect.ops, [
            .highpass(hz: 10, q: 0.1),
            .lowpass(hz: 20_000, q: 10),
            .peak(hz: 1000, q: 1, db: -24),
            .drive(db: 40, followMs: 1),
            .drive(db: 0, followMs: nil),
            .gain(db: 24),
        ])
    }

    // MARK: - The arithmetic

    /// `channels` through `effect` at `rate`, a frame at a time, as the tap hands them over.
    private func through(_ effect: SoundEffect, rate: Double, _ channels: [[Float]]) -> [[Float]] {
        var out = channels
        let chain = SoundEffectChain(effect: effect, sampleRate: rate, channels: channels.count)
        let frame = UnsafeMutableBufferPointer<Double>.allocate(capacity: channels.count)
        defer { frame.deallocate() }
        for i in 0..<channels[0].count {
            for c in 0..<channels.count { frame[c] = Double(channels[c][i]) }
            chain.processFrame(frame)
            for c in 0..<channels.count { out[c][i] = Float(frame[c]) }
        }
        return out
    }

    private func sine(_ hz: Double, _ amplitude: Double, frames: Int, rate: Double = 48_000) -> [Float] {
        (0..<frames).map { Float(amplitude * sin(2 * Double.pi * hz * Double($0) / rate)) }
    }

    private func parsedMegaphone() throws -> SoundEffect {
        try XCTUnwrap(try effectOf(megaphone))
    }

    /// The same fragment `sound-effects.unit.test.ts` and `SoundEffectTest.kt` hold their engines to:
    /// stereo at 48 kHz, every sample a float as each engine reads one, through the megaphone. A change
    /// to the arithmetic in one engine is a change to all three, and to all three tests.
    func testTheMegaphoneMatchesTheGoldenNumbersEveryEngineIsHeldTo() throws {
        let rate = 48_000.0
        let left = (0..<2400).map { i -> Float in
            Float(0.6 * sin(2 * Double.pi * 440 * Double(i) / rate) + 0.2 * sin(2 * Double.pi * 3100 * Double(i) / rate))
        }
        let right = (0..<2400).map { i -> Float in Float(0.3 * sin(2 * Double.pi * 220 * Double(i) / rate + 0.5)) }
        let out = through(try parsedMegaphone(), rate: rate, [left, right])
        let golden: [(Int, Double)] = [
            (0, 0.000004868781616096385),
            (1, 0.00005642078031087294),
            (2, 0.0003210754366591573),
            (3, 0.001207839697599411),
            (50, -0.10473176091909409),
            (100, -0.055209930986166),
            (480, 0.03146327659487724),
            (1000, -0.03916871175169945),
            (1500, 0.11145441234111786),
            (2399, 0.043290454894304276),
        ]
        for (i, value) in golden {
            XCTAssertEqual(Double(out[0][i]), value, accuracy: 1e-6, "sample \(i)")
            XCTAssertEqual(out[0][i], out[1][i], "sample \(i), the other channel")
        }
    }

    func testAQuietSoundIsDrivenAsHardAsALoudOneAndStaysAsQuiet() throws {
        let loud = sine(440, 0.8, frames: 24_000)
        let quiet = loud.map { $0 / 16 }
        let effect = try parsedMegaphone()
        let a = through(effect, rate: 48_000, [loud])[0]
        let b = through(effect, rate: 48_000, [quiet])[0]
        var worst = 0.0
        for i in 960..<a.count { worst = max(worst, abs(Double(a[i]) / 16 - Double(b[i]))) }
        XCTAssertLessThan(worst, 1e-7)
    }

    func testSilenceStaysSilentAndASoundFallsBackToExactSilence() throws {
        let effect = try parsedMegaphone()
        XCTAssertTrue(through(effect, rate: 48_000, [[Float](repeating: 0, count: 4800)])[0].allSatisfy { $0 == 0 })
        var burst = [Float](repeating: 0, count: 3 * 48_000)
        for (i, v) in sine(500, 0.9, frames: 4800).enumerated() { burst[i] = v }
        let after = through(effect, rate: 48_000, [burst])[0]
        XCTAssertTrue(after[(2 * 48_000)...].allSatisfy { $0 == 0 })
    }

    // MARK: - The tap

    func testMediaToolboxMakesTheTap() throws {
        XCTAssertNotNil(SoundEffectTap.make(try parsedMegaphone()))
    }

    /// A mono WAV of `hz` at a quarter of full scale.
    private static func tone(_ url: URL, hz: Double, durationMs: Int64, rate: Int = 44_100) throws -> URL {
        let count = rate * Int(durationMs) / 1000
        var data = Data()
        func text(_ s: String) { data.append(contentsOf: Array(s.utf8)) }
        func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { data.append(contentsOf: $0) } }
        text("RIFF"); u32(36 + count * 2); text("WAVE")
        text("fmt "); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        text("data"); u32(count * 2)
        for i in 0..<count {
            let sample = Int16(sin(2 * Double.pi * hz * Double(i) / Double(rate)) * 8000)
            withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) }
        }
        try data.write(to: url)
        return url
    }

    /// The tap runs in the export: a 150 Hz hum is nearly all body, which the megaphone's horn does not
    /// pass, so the same hum through it comes out far below the dry one. Without the tap in the
    /// export's audio mix the two would measure the same.
    func testARenderPlaysTheSoundThroughTheEffect() async throws {
        let video = try await TestMedia.video(file("v.mp4"), durationMs: 1000, color: .red, audio: false)
        let hum = try Self.tone(file("hum.wav"), hz: 150, durationMs: 1500)
        func level(_ effect: [String: Any]?, _ name: String) async throws -> Double {
            var music: [String: Any] = ["uri": hum.absoluteString, "startMs": 0, "inMs": 0, "outMs": 1500,
                                        "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]
            if let effect { music["effect"] = effect }
            let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 1000)], [
                "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](), "music": music],
            ])
            let (out, _) = try await TestRender.render(options, to: file(name))
            return try await RobustnessSupport.rms(of: out, from: 0.2, to: 0.8)
        }
        let dry = try await level(nil, "dry.mp4")
        let wet = try await level(megaphone, "wet.mp4")
        XCTAssertGreaterThan(dry, 0.05, "the hum should be heard dry")
        XCTAssertLessThan(wet, dry * 0.1, "the megaphone should take the hum away: dry \(dry), through it \(wet)")
    }
}
