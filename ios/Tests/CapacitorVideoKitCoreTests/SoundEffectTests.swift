@preconcurrency import AVFoundation
import XCTest
@testable import CapacitorVideoKitCore

/// A sound's effect on iOS: the wire read by `normaliseSoundEffect`'s rules in Android's order and
/// words, the arithmetic `SoundEffectChain` runs, and a render that plays a sound through the tap. The
/// same cases as `sound-effects.unit.test.ts` and Android's `SoundEffectTest` - the golden fragments
/// included, which all three engines are held to, to the same tolerance. And a sound's `varispeed`,
/// the speed played as a record plays it, which slow + reverb is made of along with its room.
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

    /// Slow + reverb's room at the middle of its sliders, exactly as the editor sends it (`slowReverb`
    /// in sound-effects.ts): one step, not folded, so each channel has a room of its own.
    private let slowReverb: [String: Any] = [
        "ops": [
            ["op": "reverb", "decayMs": 3500, "dampHz": 5500, "wet": 0.5, "dry": 0.8] as [String: Any],
        ] as [Any],
    ]

    /// A spec whose one sound carries `effect`, and `extra` over its own keys, as the post's music or on
    /// a lane.
    private func spec(_ effect: Any?, onLane: Bool = false, sound extra: [String: Any] = [:]) -> [String: Any] {
        var sound: [String: Any] = ["uri": file("m.m4a").absoluteString, "startMs": 0, "inMs": 0, "outMs": 5000,
                                    "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]
        if let effect { sound["effect"] = effect }
        for (k, v) in extra { sound[k] = v }
        let audio: [String: Any] = onLane
            ? ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](), "music": NSNull(), "musicTracks": [[sound]]]
            : ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](), "music": sound]
        return TestSpecs.spec([TestSpecs.clip("a", file("a.mp4"), outMs: 2000)], ["audio": audio])
    }

    private func effectOf(_ effect: Any?) throws -> SoundEffect? {
        try TestCalls.parse(spec(effect)).audio.music?.effect
    }

    /// The sound `spec` makes with `extra` over its keys, as the parser leaves it.
    private func soundOf(_ extra: [String: Any], onLane: Bool = false) throws -> ComposeMusic? {
        let audio = try TestCalls.parse(spec(nil, onLane: onLane, sound: extra)).audio
        return onLane ? audio.musicTracks.first?.first : audio.music
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

    func testTheRoomTheEditorSendsIsReadAsItWasSent() throws {
        let effect = try XCTUnwrap(try effectOf(slowReverb))
        XCTAssertEqual(effect, SoundEffect(mono: false, ops: [.reverb(decayMs: 3500, dampHz: 5500, wet: 0.5, dry: 0.8)]))
        XCTAssertEqual(try TestCalls.parse(spec(slowReverb, onLane: true)).audio.musicTracks[0][0].effect, effect)
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
        assertRefused(["ops": [["op": "echo"] as [String: Any]]], "\(p).ops[0].op")
        // A reverb's numbers in the contract's order - decayMs, dampHz, wet, dry - then its keys.
        assertRefused(["ops": [["op": "reverb", "decayMs": 1000] as [String: Any]]], "\(p).ops[0].dampHz")
        assertRefused(["ops": [["op": "reverb", "decayMs": 1000, "dampHz": 5000, "wet": 0.5] as [String: Any]]], "\(p).ops[0].dry")
        assertRefused(["ops": [["op": "reverb", "decayMs": "long", "dampHz": 5000, "wet": 0.5, "dry": 1] as [String: Any]]],
                      "\(p).ops[0].decayMs")
        assertRefused(["ops": [["op": "reverb", "decayMs": 1000, "dampHz": 5000, "wet": 0.5, "dry": 1, "size": 2] as [String: Any]]],
                      "\(p).ops[0].size")
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
        assertRefused(["ops": [["op": "echo"] as [String: Any]]], "\(lane).ops[0].op", onLane: true)
        assertRefused(["ops": [["op": "reverb", "decayMs": 1000] as [String: Any]]], "\(lane).ops[0].dampHz", onLane: true)
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
            ["op": "reverb", "decayMs": 5, "dampHz": 99_999, "wet": 2, "dry": -1] as [String: Any],
        ] as [Any]]))
        XCTAssertEqual(effect.ops, [
            .highpass(hz: 10, q: 0.1),
            .lowpass(hz: 20_000, q: 10),
            .peak(hz: 1000, q: 1, db: -24),
            .drive(db: 40, followMs: 1),
            .drive(db: 0, followMs: nil),
            .gain(db: 24),
            .reverb(decayMs: 100, dampHz: 20_000, wet: 1, dry: 0),
        ])
    }

    // MARK: - The arithmetic

    /// `channels` through `effect` at `rate`, a frame at a time, as the tap hands them over.
    private func through(_ effect: SoundEffect, rate: Double, _ channels: [[Float]]) -> [[Float]] {
        through(SoundEffectChain(effect: effect, sampleRate: rate, channels: channels.count), channels)
    }

    /// `channels` through a chain already made, which keeps its state from one call to the next as the
    /// tap's does from one buffer to the next.
    private func through(_ chain: SoundEffectChain, _ channels: [[Float]]) -> [[Float]] {
        var out = channels
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

    // MARK: - The reverb

    /// A room of 2 s damped from 6 kHz and heard alone, unless told otherwise: `room` in
    /// sound-effects.unit.test.ts, which the cases below share with it.
    private func room(decayMs: Double = 2000, dampHz: Double = 6000, wet: Double = 1, dry: Double = 0) -> SoundEffect {
        SoundEffect(mono: false, ops: [.reverb(decayMs: decayMs, dampHz: dampHz, wet: wet, dry: dry)])
    }

    /// The megaphone's fragment, twice as long, through slow + reverb's room as the editor sends it - the
    /// numbers `sound-effects.unit.test.ts` and `SoundEffectTest.kt` hold their engines to. Not folded,
    /// so each channel is held to a room of its own: the left first hears its room at sample 1215 and
    /// the right, whose delays are 23 samples longer at 44.1 kHz, at 1240.
    func testTheReverbMatchesTheGoldenNumbersEveryEngineIsHeldTo() throws {
        let rate = 48_000.0
        let left = (0..<4800).map { i -> Float in
            Float(0.6 * sin(2 * Double.pi * 440 * Double(i) / rate) + 0.2 * sin(2 * Double.pi * 3100 * Double(i) / rate))
        }
        let right = (0..<4800).map { i -> Float in Float(0.3 * sin(2 * Double.pi * 220 * Double(i) / rate + 0.5)) }
        let out = through(try XCTUnwrap(try effectOf(slowReverb)), rate: rate, [left, right])
        let golden: [(Int, Double, Double)] = [
            (0, 0, 0.11506213247776031),
            (1, 0.09078975021839142, 0.1210789903998375),
            (1214, 0.4370698928833008, -0.18847058713436127),
            (1215, 0.3962092995643616, -0.19267092645168304),
            (1239, 0.39520999789237976, -0.23967154324054718),
            (1240, 0.4382869005203247, -0.2387159764766693),
            (1500, -0.5940757393836975, -0.06688307225704193),
            (2000, 0.5418930649757385, 0.23884811997413635),
            (3000, -0.2069074958562851, -0.22407972812652588),
            (4000, -0.2956431806087494, 0.14864428341388702),
            (4799, -0.1521013230085373, 0.08078738301992416),
        ]
        for (i, l, r) in golden {
            XCTAssertEqual(Double(out[0][i]), l, accuracy: 1e-6, "sample \(i), left")
            XCTAssertEqual(Double(out[1][i]), r, accuracy: 1e-6, "sample \(i), right")
        }
    }

    /// Nothing comes back out of a comb before its delay has passed, and the shortest is 1116 samples at
    /// 44.1 kHz, 1215 at 48: until then the first channel is the dry sound alone, at `dry`.
    func testAReverbIsTheDrySoundAloneUntilItsFirstCombsDelay() {
        let input = sine(440, 0.5, frames: 2400)
        let out = through(room(wet: 0.7, dry: 0.6), rate: 48_000, [input])[0]
        var worst = 0.0
        for i in 0..<1215 { worst = max(worst, abs(Double(out[i]) - Double(Float(0.6 * Double(input[i]))))) }
        XCTAssertLessThan(worst, 1e-7)
        XCTAssertNotEqual(out[1300], Float(0.6 * Double(input[1300])), "the room should be heard by sample 1300")
    }

    /// A click in both channels comes back as two tails all but unrelated to each other - each channel's
    /// delays are its own - so the room is as wide as the speakers rather than one tail out of both.
    func testEachChannelRingsWithATailOfItsOwn() {
        var click = [Float](repeating: 0, count: 48_000)
        click[0] = 1
        let out = through(room(), rate: 48_000, [click, click])
        var ab = 0.0, aa = 0.0, bb = 0.0
        for i in 2400..<click.count {
            let a = Double(out[0][i]), b = Double(out[1][i])
            ab += a * b
            aa += a * a
            bb += b * b
        }
        XCTAssertGreaterThan(aa, 0, "the left should ring")
        XCTAssertGreaterThan(bb, 0, "the right should ring")
        XCTAssertLessThan(abs(ab / (aa * bb).squareRoot()), 0.2, "the two tails should differ")
    }

    /// A folded sound runs through the first channel's room - the mean of its channels, played from both.
    func testAFoldedReverbIsTheFirstChannels() {
        let left = sine(300, 0.5, frames: 9600)
        let right = sine(700, 0.3, frames: 9600)
        let folded = through(SoundEffect(mono: true, ops: room().ops), rate: 48_000, [left, right])
        let mean = left.indices.map { Float((Double(left[$0]) + Double(right[$0])) / 2) }
        let first = through(room(), rate: 48_000, [mean])[0]
        var worst = 0.0
        for i in first.indices { worst = max(worst, abs(Double(folded[0][i]) - Double(first[i]))) }
        XCTAssertLessThan(worst, 1e-6)
        XCTAssertEqual(folded[0], folded[1], "a folded sound plays the same from every channel")
    }

    func testAReverbLeavesSilenceSilentAndFallsBackToExactSilence() {
        XCTAssertTrue(through(room(), rate: 48_000, [[Float](repeating: 0, count: 4800)])[0].allSatisfy { $0 == 0 })
        var burst = [Float](repeating: 0, count: 9 * 48_000)
        for (i, v) in sine(500, 0.9, frames: 4800).enumerated() { burst[i] = v }
        let after = through(room(decayMs: 1000), rate: 48_000, [burst])[0]
        // Every value it keeps is let go under 1e-20, so the tail ends in zeros rather than denormals.
        XCTAssertTrue(after[(8 * 48_000)...].allSatisfy { $0 == 0 })
    }

    /// `reset`, which the tap calls where a stream starts again, leaves a room as it was made: every line
    /// silent, every `f` 0 and every `p` at its start. A room that has rung and been reset plays the next
    /// sound sample for sample as a new one does, where one that was not is still ringing.
    func testResetPutsTheRoomBackToItsStart() {
        let effect = room(decayMs: 3500, dampHz: 5500, wet: 0.5, dry: 0.8)
        let first = [sine(440, 0.5, frames: 4800), sine(220, 0.3, frames: 4800)]
        let next = [sine(330, 0.6, frames: 4800), sine(550, 0.4, frames: 4800)]
        let fresh = through(effect, rate: 48_000, next)
        let used = SoundEffectChain(effect: effect, sampleRate: 48_000, channels: 2)
        _ = through(used, first)
        used.reset()
        XCTAssertEqual(through(used, next), fresh)
        let ringing = SoundEffectChain(effect: effect, sampleRate: 48_000, channels: 2)
        _ = through(ringing, first)
        XCTAssertNotEqual(through(ringing, next), fresh, "a room that was not reset should still be ringing")
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

    // MARK: - Varispeed

    func testVarispeedIsReadAsTheSoundSentIt() throws {
        let record = try XCTUnwrap(try soundOf(["speed": 0.8, "varispeed": true]))
        XCTAssertEqual(record.speed, 0.8)
        XCTAssertTrue(record.varispeed)
        XCTAssertEqual(try soundOf(["speed": 0.8, "varispeed": true], onLane: true)?.varispeed, true)
        // Absent is false, which is every spec written before the key; and, read as `loop` is, so is a
        // value that is not a boolean.
        XCTAssertEqual(try soundOf(["speed": 0.8])?.varispeed, false)
        XCTAssertEqual(try soundOf(["speed": 0.8, "varispeed": "yes"])?.varispeed, false)
    }

    /// A slowed sound that asks to play as a record does is scaled under `.varispeed`, which lets its
    /// pitch go with the speed. One that does not ask keeps its pitch under `.spectral`, and so does one
    /// at 1x, where nothing is scaled and the sound keeps the path it always took.
    func testOnlyASlowedSoundThatAsksIsScaledUnderVarispeed() async throws {
        let video = try await TestMedia.video(file("v.mp4"), durationMs: 1000, color: .red, audio: false)
        let tone = try Self.tone(file("tone.wav"), hz: 440, durationMs: 1500)
        func algorithm(_ extra: [String: Any]) async throws -> AVAudioTimePitchAlgorithm? {
            var music: [String: Any] = ["uri": tone.absoluteString, "startMs": 0, "inMs": 0, "outMs": 1500,
                                        "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]
            for (k, v) in extra { music[k] = v }
            let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 1000)], [
                "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](), "music": music],
            ])
            let built = try await RobustnessSupport.build(options)
            // The video is silent, so the sound's are the only parameters in the mix.
            let params = try XCTUnwrap(built.audioMix?.inputParameters)
            XCTAssertEqual(params.count, 1)
            return params.first?.audioTimePitchAlgorithm
        }
        let record = try await algorithm(["speed": 0.5, "varispeed": true])
        let stretched = try await algorithm(["speed": 0.5])
        let unscaled = try await algorithm(["speed": 1, "varispeed": true])
        XCTAssertEqual(record, AVAudioTimePitchAlgorithm.varispeed)
        XCTAssertEqual(stretched, AVAudioTimePitchAlgorithm.spectral)
        XCTAssertEqual(unscaled, AVAudioTimePitchAlgorithm.spectral)
    }

    /// The same 440 Hz tone slowed to half speed both ways and rendered: stretched it keeps its pitch,
    /// and as a record it comes out an octave lower, at 220 Hz. Counted in the post's own sound, so it is
    /// the export that is heard - the track's own algorithm used in place of the engine's - and not the
    /// parameters that are read.
    func testASoundSlowedAsARecordComesOutAnOctaveLower() async throws {
        let video = try await TestMedia.video(file("v.mp4"), durationMs: 1000, color: .red, audio: false)
        let tone = try Self.tone(file("tone.wav"), hz: 440, durationMs: 1500)
        func crossings(_ extra: [String: Any], _ name: String) async throws -> Int {
            var music: [String: Any] = ["uri": tone.absoluteString, "startMs": 0, "inMs": 0, "outMs": 1500,
                                        "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0, "speed": 0.5]
            for (k, v) in extra { music[k] = v }
            let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 1000)], [
                "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](), "music": music],
            ])
            let (out, _) = try await TestRender.render(options, to: file(name))
            return try await SoundEffectTests.risingCrossings(of: out, from: 0.2, to: 0.8)
        }
        let stretched = try await crossings([:], "stretched.mp4")
        let record = try await crossings(["varispeed": true], "record.mp4")
        // 0.6 s of 440 Hz rises through zero 264 times, and of 220 Hz 132.
        XCTAssertEqual(Double(stretched), 264, accuracy: 26, "stretched, the tone should keep its 440 Hz")
        XCTAssertEqual(Double(record), 132, accuracy: 13, "as a record, the tone should fall an octave to 220 Hz")
    }

    /// How many times the sound of `url` rises through zero between two moments: a tone's frequency,
    /// counted. Decoded to PCM exactly as `RobustnessSupport.rms` decodes it. A rise counts only from
    /// under -1600 to over +1600, about 0.05 of full scale, so the encoder's dust about the line is not a
    /// crossing; and the channels are read interleaved, which for a sound that is the same in both - or
    /// in one and silent in the other - counts what one channel alone does.
    private static func risingCrossings(of url: URL, from: Double, to: Double) async throws -> Int {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return 0 }
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 600),
                                       end: CMTime(seconds: to, preferredTimescale: 600))
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? TestError("startReading") }
        var count = 0
        var under = false
        while let buffer = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var samples = [Int16](repeating: 0, count: length / 2)
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: samples.count * 2, destination: &samples)
            for s in samples {
                if s < -1600 {
                    under = true
                } else if s > 1600 && under {
                    under = false
                    count += 1
                }
            }
        }
        return count
    }
}
