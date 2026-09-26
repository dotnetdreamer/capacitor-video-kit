@preconcurrency import AVFoundation
import CryptoKit
import Foundation
import XCTest
@testable import CapacitorVideoKitCore

/// The slow-motion benchmark's iOS half: renders whatever specs a jobs file lists on the simulator,
/// and leaves behind the numbers and the pictures the benchmark scores. It proves nothing by itself
/// and asserts only that every job ran, so it is SKIPPED unless it is given a jobs file; a plain
/// `xcodebuild test` of the suite never renders a benchmark.
///
/// The jobs file is named by `VK_BENCH_JOBS`, an absolute path. `xcodebuild` hands the test runner
/// every variable of its own that starts `TEST_RUNNER_`, with the prefix stripped, so it is set with
/// `TEST_RUNNER_VK_BENCH_JOBS=/path/jobs.json xcodebuild test ...`. A simulated process opens the
/// Mac's own paths, so the media and `outDir` are read and written where they are, with nothing
/// copied in or out. There is deliberately no route for a phone: this bench runs on the simulator
/// only, and a phone would need the jobs file and its media inside the signed bundle and the
/// results carried back out, which nothing here does.
///
/// The jobs file:
///
///     {"outDir": "...", "media": "<dir>",
///      "jobs": [{"name": "...", "spec": {<ComposeSpec options>}, "mode": "export" | "hash",
///                "slowMotion": "off" | "blend" | "flow", "repeat": 1}]}
///
/// `media` and `outDir` are absolute, or relative to the folder the jobs file is in; `outDir` is
/// made when it is missing, and a run that cannot write there fails before any job starts.
/// Every `{{MEDIA}}` inside a string anywhere in a spec becomes the media folder's absolute path.
/// `mode` defaults to "export", `repeat` to 1 and `slowMotion` to "flow", the engine's own default.
///
/// What a job writes:
/// - export: `<name>.mp4`, the file the module's own `Exporter` wrote on the LAST repeat, and
///   `<name>.json` with the wall time of the build and of the export on every repeat, the engine
///   that wrote the file, and its frame count and length read back off it.
/// - hash: `<name>.hashes.txt`, one line per frame the COMPOSITOR drew - `<pts in seconds, six
///   decimals> <sha256 of the frame's BGRA rows>` - read through the same reader output the writer
///   engine reads, before any encoder has touched it, and `<name>.json` with the times. This is the
///   byte-for-byte proof: two runs whose hash files are equal drew the same pixels at the same
///   times, whatever an encoder would have made of them.
///
/// A job that fails is reported by name and the jobs after it still run, so one broken spec in a
/// long bench costs its own numbers and nobody else's.
final class SlowMotionBenchTests: XCTestCase {

    func testBenchJobs() async throws {
        guard let jobsURL = BenchJobsFile.locate() else {
            throw XCTSkip("no jobs file: run with TEST_RUNNER_VK_BENCH_JOBS=/absolute/jobs.json")
        }
        let file = try BenchJobsFile(contentsOf: jobsURL)
        // Printed rather than only logged: the runner's stdout lands in the xcodebuild log, which is
        // the first place anyone looks when a job goes missing.
        print("[bench] jobs \(jobsURL.path) media \(file.media.path) out \(file.outDir.path) - \(file.jobs.count) jobs on \(BenchDevice.describe)")

        for (index, raw) in file.jobs.enumerated() {
            let label = (raw["name"] as? String).map { "job \($0)" } ?? "job #\(index)"
            do {
                let job = try BenchJob(raw, media: file.media)
                // Not inside an `XCTContext` activity: `runActivity` takes only a synchronous
                // block (ctx7, developer_apple_xctest), and a render is awaited.
                let written = try await job.run(into: file.outDir)
                print("[bench] \(label) done: \(written.map(\.lastPathComponent).joined(separator: ", "))")
            } catch {
                // The job's name first, so a failure in a bench of forty says which of the forty.
                XCTFail("\(label) failed: \(error)")
            }
        }
    }
}

// MARK: - The one build path

/// Every composition the bench renders is built HERE, and nowhere else in this file, so that the
/// slow-motion mode reaches the builder through one call.
enum BenchBuild {
    /// The modes a job may name, and the builder's mode each one is.
    static let byName: [String: SlowMotionMode] = ["off": .off, "blend": .blend, "flow": .flow]
    static var modes: Set<String> { Set(byName.keys) }

    /// Builds `spec` for the slow-motion mode `slowMotion`: "off" is the engine as it was before slow
    /// motion was synthesised (repeated frames; byte for byte what the phase-0 baseline recorded), "blend"
    /// phase 1's cross-fade and "flow" phase 2's optical flow, which is what the app renders. A name that
    /// is none of them fails the job rather than silently rendering the default.
    static func build(_ spec: ComposeSpec, slowMotion: String) async throws -> BuiltComposition {
        guard let mode = byName[slowMotion] else { throw TestError("slowMotion \"\(slowMotion)\" is none of \(modes.sorted())") }
        return try await CompositionBuilder.build(spec, slowMotion: mode)
    }
}

// MARK: - The jobs file

struct BenchJobsFile {
    let outDir: URL
    let media: URL
    let jobs: [[String: Any]]

    /// The jobs file `VK_BENCH_JOBS` names, or nil when the variable is unset or empty.
    static func locate() -> URL? {
        guard let path = ProcessInfo.processInfo.environment["VK_BENCH_JOBS"], !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path)
    }

    init(contentsOf url: URL) throws {
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw TestError("cannot read the jobs file \(url.path): \(error)") }
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TestError("the jobs file \(url.path) is not a JSON object")
        }
        guard let jobs = root["jobs"] as? [[String: Any]] else {
            throw TestError("the jobs file \(url.path) has no \"jobs\" array")
        }
        let base = url.deletingLastPathComponent()
        func resolve(_ path: String) -> URL {
            // `..` is folded by hand rather than by `standardizedFileURL`, which also drops a leading
            // `/private` (measured: `/private/tmp/...` came back `/tmp/...`). Both open the same
            // files, but every path the harness prints and substitutes for `{{MEDIA}}` should be
            // spelled the way the Mac wrote it, so a log can be matched against the jobs file.
            let joined = path.hasPrefix("/") ? path : base.path + "/" + path
            var parts: [String] = []
            for part in joined.split(separator: "/", omittingEmptySubsequences: true).map(String.init) {
                switch part {
                case ".": continue
                case "..": _ = parts.popLast()
                default: parts.append(part)
                }
            }
            return URL(fileURLWithPath: "/" + parts.joined(separator: "/"), isDirectory: true)
        }
        self.jobs = jobs
        self.media = resolve(root["media"] as? String ?? ".")
        guard let outDir = (root["outDir"] as? String).map(resolve) else {
            throw TestError("the jobs file \(url.path) has no \"outDir\"")
        }
        // Made and checked before the first job, not found out after the first render: a bench of
        // forty jobs that cannot write its results should fail in a second, not in an hour.
        do { try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true) } catch {
            throw TestError("cannot make outDir \(outDir.path): \(error)")
        }
        guard FileManager.default.isWritableFile(atPath: outDir.path) else {
            throw TestError("outDir \(outDir.path) is not writable")
        }
        self.outDir = outDir
    }
}

// MARK: - One job

struct BenchJob {
    let name: String
    let mode: String
    let slowMotion: String
    let repeats: Int
    /// The spec's options with `{{MEDIA}}` already replaced, and the ids still the file's own.
    let options: [String: Any]

    init(_ raw: [String: Any], media: URL) throws {
        guard let name = raw["name"] as? String, !name.isEmpty else { throw TestError("a job has no \"name\"") }
        // The name becomes file names in outDir, so it may not climb out of it or hide in a folder.
        guard !name.contains("/"), !name.hasPrefix(".") else { throw TestError("the name \"\(name)\" is not a plain file name") }
        guard let spec = raw["spec"] as? [String: Any] else { throw TestError("no \"spec\" object") }
        self.name = name
        self.mode = raw["mode"] as? String ?? "export"
        guard mode == "export" || mode == "hash" else { throw TestError("mode \"\(mode)\" is neither export nor hash") }
        self.slowMotion = raw["slowMotion"] as? String ?? "flow"
        guard BenchBuild.modes.contains(slowMotion) else { throw TestError("slowMotion \"\(slowMotion)\" is none of \(BenchBuild.modes.sorted())") }
        self.repeats = max(1, (raw["repeat"] as? NSNumber)?.intValue ?? 1)
        guard let substituted = BenchJob.substitute(spec, media: media.path) as? [String: Any] else {
            throw TestError("the spec did not survive {{MEDIA}} substitution")
        }
        self.options = substituted
    }

    /// Runs every repeat and answers the files it wrote into `outDir`.
    func run(into outDir: URL) async throws -> [URL] {
        switch mode {
        case "hash": return try await hash(into: outDir)
        default: return try await export(into: outDir)
        }
    }

    // MARK: Export

    private func export(into outDir: URL) async throws -> [URL] {
        var runs: [[String: Any]] = []
        var engine = ""
        let finalURL = outDir.appendingPathComponent("\(name).mp4")
        for r in 0..<repeats {
            let spec = try TestCalls.parse(freshIds())
            try BenchJob.makeJobFolder(spec)
            defer { JobFolders.cleanup(batchId: spec.batchId) }
            let tmpDir = JobFolders.exportTmp(spec.batchId)
            let out = JobFolders.jobDir(spec.batchId).appendingPathComponent("bench.mp4")

            let t0 = BenchClock.now()
            let built = try await BenchBuild.build(spec, slowMotion: slowMotion)
            let t1 = BenchClock.now()
            let result = try await Exporter.export(built, to: out, tmpDir: tmpDir, spec: spec,
                                                   engines: (WriterEngine.self, BenchPresetEngine.self),
                                                   onProgress: { _ in })
            let t2 = BenchClock.now()
            // The marker is the only trace the fallback leaves: `Exporter` logs which engine wrote
            // the file but hands back nothing that says so.
            let fellBack = FileManager.default.fileExists(atPath: BenchPresetEngine.marker(in: tmpDir).path)
            engine = fellBack ? PresetEngine.name : WriterEngine.name
            runs.append(["buildMs": BenchClock.ms(t0, t1), "exportMs": BenchClock.ms(t1, t2), "engine": engine,
                         "bytes": result.bytes])
            print("[bench] \(name) export \(r + 1)/\(repeats): build \(BenchClock.ms(t0, t1)) ms, export \(BenchClock.ms(t1, t2)) ms, \(engine)")

            if r == repeats - 1 {
                try? FileManager.default.removeItem(at: finalURL)
                try FileManager.default.copyItem(at: out, to: finalURL)
            }
        }
        let probed = try await BenchProbe.frames(of: finalURL)
        // Measured from the first frame shown, as `TestTracks.frameTimes` does: with frame
        // reordering on, the track's own times start a frame in, where the edit list puts them.
        let origin = probed.first ?? 0
        let asset = AVURLAsset(url: finalURL)
        let duration = try await asset.load(.duration)
        let summary: [String: Any] = [
            "name": name, "mode": mode, "slowMotion": slowMotion, "repeat": repeats,
            "device": BenchDevice.info, "runs": runs, "engine": engine,
            "frames": probed.count, "trackPtsOffset": origin, "lastPts": (probed.last ?? 0) - origin,
            "durationS": duration.seconds, "durationMs": msOf(duration),
            "buildMs": runs.map { $0["buildMs"] as? Double ?? 0 },
            "exportMs": runs.map { $0["exportMs"] as? Double ?? 0 },
        ]
        let jsonURL = try writeJSON(summary, to: outDir)
        return [finalURL, jsonURL]
    }

    // MARK: Hash

    private func hash(into outDir: URL) async throws -> [URL] {
        var runs: [[String: Any]] = []
        var lines: [String] = []
        var agree = true
        for r in 0..<repeats {
            let spec = try TestCalls.parse(freshIds())
            // Kept until the frames have been read, not only built: the stills of a spec's
            // pictures are written into it while the composition is built and decoded from there.
            try BenchJob.makeJobFolder(spec)
            defer { JobFolders.cleanup(batchId: spec.batchId) }
            let t0 = BenchClock.now()
            let built = try await BenchBuild.build(spec, slowMotion: slowMotion)
            let t1 = BenchClock.now()
            let these = try BenchHasher.hashes(built)
            let t2 = BenchClock.now()
            // Every repeat is hashed, and a repeat that draws other pixels than the first is recorded
            // rather than failed: a compositor that is not deterministic is a finding the bench has
            // to report, not a reason to throw away the run that found it.
            if r > 0, these != lines { agree = false }
            if r == 0 { lines = these }
            runs.append(["buildMs": BenchClock.ms(t0, t1), "readMs": BenchClock.ms(t1, t2), "frames": these.count])
            print("[bench] \(name) hash \(r + 1)/\(repeats): build \(BenchClock.ms(t0, t1)) ms, read+hash \(BenchClock.ms(t1, t2)) ms, \(these.count) frames")
        }
        let hashesURL = outDir.appendingPathComponent("\(name).hashes.txt")
        try (lines.joined(separator: "\n") + "\n").write(to: hashesURL, atomically: true, encoding: .utf8)
        let summary: [String: Any] = [
            "name": name, "mode": mode, "slowMotion": slowMotion, "repeat": repeats,
            "device": BenchDevice.info, "runs": runs, "frames": lines.count, "repeatsAgree": agree,
            "buildMs": runs.map { $0["buildMs"] as? Double ?? 0 },
            "readMs": runs.map { $0["readMs"] as? Double ?? 0 },
        ]
        let jsonURL = try writeJSON(summary, to: outDir)
        return [hashesURL, jsonURL]
    }

    // MARK: Helpers

    /// The job folder the registry would make for `spec`, which the caller removes with
    /// `JobFolders.cleanup` whichever way the job ends, as `TestRender.render` does. Both modes need
    /// it: the builder writes a spec's picture stills into it (`PictureStills`), and the writer puts
    /// its temporary files under it.
    static func makeJobFolder(_ spec: ComposeSpec) throws {
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
    }

    /// The spec's options with a job id and batch id nobody has used: the batch id names the job
    /// folder that is made and deleted around every render, and two repeats, or two runs of one jobs
    /// file, must never share one.
    private func freshIds() -> [String: Any] {
        var o = options
        let tag = UUID().uuidString.lowercased()
        o["jobId"] = "bench-job-\(tag)"
        o["batchId"] = "bench-batch-\(tag)"
        return o
    }

    private func writeJSON(_ object: [String: Any], to outDir: URL) throws -> URL {
        let url = outDir.appendingPathComponent("\(name).json")
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
        return url
    }

    /// `value` with every `{{MEDIA}}` in every string replaced by `media`, keys left alone.
    static func substitute(_ value: Any, media: String) -> Any {
        switch value {
        case let s as String: return s.replacingOccurrences(of: "{{MEDIA}}", with: media)
        case let a as [Any]: return a.map { substitute($0, media: media) }
        case let d as [String: Any]: return d.mapValues { substitute($0, media: media) }
        default: return value
        }
    }
}

// MARK: - Reading the compositor's own frames

enum BenchHasher {
    /// One line per frame the compositor drew for `built`: its presentation time and the SHA-256 of
    /// its pixels.
    ///
    /// Read the way `WriterEngine` reads a render - the same reader range, the same
    /// `AVAssetReaderVideoCompositionOutput` over every video track, the same `frameSettings`
    /// (32BGRA, Metal-compatible) and the same video composition - so the frames hashed are the
    /// frames the encoder would have been handed, and nothing an encoder does can move a hash.
    ///
    /// Only the picture's own bytes are hashed, `width * 4` of every row: a buffer's rows may be
    /// padded out to an alignment of the allocator's choosing, and padding is not picture - two
    /// equal frames in buffers padded differently must hash alike.
    static func hashes(_ built: BuiltComposition) throws -> [String] {
        let reader = try AVAssetReader(asset: built.composition)
        reader.timeRange = CMTimeRange(start: .zero, duration: ms(built.totalMs))
        let output = AVAssetReaderVideoCompositionOutput(videoTracks: built.composition.tracks(withMediaType: .video),
                                                         videoSettings: WriterEngine.frameSettings)
        output.videoComposition = built.videoComposition
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw TestError("the reader refused the composed video output") }
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? TestError("startReading") }

        var lines: [String] = []
        while let sample = output.copyNextSampleBuffer() {
            guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            let hex = try digest(buffer)
            lines.append(String(format: "%.6f %@", pts, hex))
        }
        if reader.status == .failed { throw reader.error ?? TestError("reading the composition") }
        if reader.status != .completed { throw TestError("the reader stopped at status \(reader.status.rawValue)") }
        return lines
    }

    private static func digest(_ buffer: CVPixelBuffer) throws -> String {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA,
              !CVPixelBufferIsPlanar(buffer) else {
            throw TestError("a frame came back as format \(CVPixelBufferGetPixelFormatType(buffer)), not 32BGRA")
        }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw TestError("a frame with no pixels") }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        var sha = SHA256()
        for y in 0..<height {
            sha.update(bufferPointer: UnsafeRawBufferPointer(start: base + y * stride, count: width * 4))
        }
        return sha.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

enum BenchProbe {
    /// The presentation times, in seconds and in order, of every frame in the file's video track,
    /// read off the compressed samples so that nothing is decoded to count them.
    static func frames(of url: URL) async throws -> [Double] {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw TestError("\(url.lastPathComponent) has no video track")
        }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? TestError("startReading") }
        var times: [Double] = []
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
            times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
        }
        if reader.status == .failed { throw reader.error ?? TestError("reading \(url.lastPathComponent)") }
        // Compressed samples come in DECODE order; with frame reordering they are not in time order.
        return times.sorted()
    }
}

/// `PresetEngine`, leaving a marker in the job's temporary folder when `Exporter` falls back to it.
/// Handed to `Exporter.export` through the seam its failure tests use, with `WriterEngine` first as
/// every real render has it, so the bench exports exactly as the app does and can still say which
/// engine wrote the file.
private enum BenchPresetEngine: RenderEngine {
    static let name = PresetEngine.name

    static func marker(in tmpDir: URL) -> URL { tmpDir.appendingPathComponent("bench-fell-back") }

    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws {
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: marker(in: tmpDir).path, contents: Data())
        try await PresetEngine.encode(built, to: url, tmpDir: tmpDir, spec: spec, onProgress: onProgress)
    }
}

enum BenchClock {
    static func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
    /// Milliseconds from `a` to `b`, to a hundredth.
    static func ms(_ a: UInt64, _ b: UInt64) -> Double { (Double(b &- a) / 10_000).rounded() / 100 }
}

enum BenchDevice {
    /// What ran the job, written into every summary. A simulator's times are the Mac's under it -
    /// its software paths, its cores - so a time is only ever compared with one measured on the same
    /// simulator and the same machine, and the summary has to say which that was. `machine` is the
    /// host's architecture on a simulator; `model` is the simulated phone.
    static var info: [String: Any] {
        var sys = utsname()
        uname(&sys)
        let machine = withUnsafeBytes(of: &sys.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        let env = ProcessInfo.processInfo.environment
        #if targetEnvironment(simulator)
        let simulator = true
        #else
        let simulator = false
        #endif
        return ["simulator": simulator,
                "model": env["SIMULATOR_MODEL_IDENTIFIER"] ?? machine,
                "machine": machine,
                "os": ProcessInfo.processInfo.operatingSystemVersionString,
                "cores": ProcessInfo.processInfo.activeProcessorCount]
    }

    static var describe: String {
        let i = info
        return "\(i["model"] ?? "?") \((i["simulator"] as? Bool) == true ? "simulator" : "device") \(i["os"] ?? "")"
    }
}
