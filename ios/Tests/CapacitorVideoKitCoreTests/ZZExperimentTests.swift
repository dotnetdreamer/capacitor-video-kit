@preconcurrency import AVFoundation
import XCTest
@testable import CapacitorVideoKitCore

final class ZZExperimentTests: RenderTestCase {

    func testWatchWriterGrowth() async throws {
        let source = try await TestMedia.noise(file("noise.mp4"), durationMs: 4000, audio: true)
        let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 4000)], [
            "output": ["width": 360, "height": 640, "fps": 30, "videoBitrate": 4_000_000, "audioBitrate": 128_000],
        ]))
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        let part = JobFolders.part(spec.batchId, jobId: spec.jobId)
        let tmp = JobFolders.exportTmp(spec.batchId)
        let built = try await CompositionBuilder.build(spec)
        let stop = FirstTime()
        let poller = Task.detached {
            while !Task.isCancelled {
                let size = (try? FileManager.default.attributesOfItem(atPath: part.path)[.size] as? NSNumber)?.int64Value ?? -1
                let tmps = (try? FileManager.default.contentsOfDirectory(atPath: tmp.path)) ?? []
                var tsz: [String] = []
                for t in tmps {
                    let s = (try? FileManager.default.attributesOfItem(atPath: tmp.appendingPathComponent(t).path)[.size] as? NSNumber)?.int64Value ?? -1
                    tsz.append("\(t)=\(s)")
                }
                print("EXP writer part=\(size) tmp=\(tsz)")
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        _ = try await WriterEngine.encode(built, to: part, tmpDir: tmp, spec: spec) { _ in }
        poller.cancel()
        _ = stop
        print("EXP writer final=\(Thumbnailer.fileBytes(part)) tmpAfter=\((try? FileManager.default.contentsOfDirectory(atPath: tmp.path)) ?? [])")
        // A cancel partway.
        try? FileManager.default.removeItem(at: part)
        let once = FirstTime()
        let t = Task {
            try await WriterEngine.encode(built, to: part, tmpDir: tmp, spec: spec) { f in
                if f > 0.3, once.claim() { print("EXP writer cancelling at \(f) tmp=\((try? FileManager.default.contentsOfDirectory(atPath: tmp.path)) ?? [])") }
            }
        }
        while !once.claim() { try await Task.sleep(nanoseconds: 10_000_000) }
        t.cancel()
        _ = try? await t.value
        print("EXP writer after cancel part=\(FileManager.default.fileExists(atPath: part.path)) tmpAfter=\((try? FileManager.default.contentsOfDirectory(atPath: tmp.path)) ?? [])")
    }

    func testPresetLimit() async throws {
        let source = try await TestMedia.noise(file("noise.mp4"), durationMs: 4000, audio: true)
        let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 4000)], [
            "output": ["width": 360, "height": 640, "fps": 30, "videoBitrate": 4_000_000, "audioBitrate": 128_000],
        ]))
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        let part = JobFolders.part(spec.batchId, jobId: spec.jobId)
        let tmp = JobFolders.exportTmp(spec.batchId)
        let built = try await CompositionBuilder.build(spec)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        for limit: Int64 in [0, 100_000, 300_000, 1_000_000, 2_000_000, 3_000_000, 50_000_000] {
            try? FileManager.default.removeItem(at: part)
            let session = try PresetEngine.session(for: built, spec: spec, tmpDir: tmp)
            session.fileLengthLimit = limit
            var peak: Int64 = 0
            let poller = Task.detached { () -> Int64 in
                var peak: Int64 = 0
                while !Task.isCancelled {
                    for t in (try? FileManager.default.contentsOfDirectory(atPath: tmp.path)) ?? [] {
                        let s = (try? FileManager.default.attributesOfItem(atPath: tmp.appendingPathComponent(t).path)[.size] as? NSNumber)?.int64Value ?? -1
                        peak = max(peak, s)
                    }
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
                return peak
            }
            var outcome = ""
            do {
                try await session.export(to: part, as: .mp4)
                outcome = "completed"
            } catch {
                outcome = "threw \(error)"
            }
            poller.cancel()
            peak = await poller.value
            let probeURL = tmp.deletingLastPathComponent().appendingPathComponent("probe-\(limit).mp4")
            try? FileManager.default.removeItem(at: probeURL)
            try FileManager.default.copyItem(at: part, to: probeURL)
            let asset = AVURLAsset(url: probeURL)
            let d = try? await asset.load(.duration)
            let v = (try? await asset.loadTracks(withMediaType: .video))?.count ?? -1
            let a = (try? await asset.loadTracks(withMediaType: .audio))?.count ?? -1
            var vr = "?"
            if let vt = (try? await asset.loadTracks(withMediaType: .video))?.first {
                let range = try await vt.load(.timeRange)
                let bytes = try await vt.load(.totalSampleDataLength)
                let times = (try? await TestTracks.frameTimes(of: probeURL))?.frames.count ?? -1
                vr = "vrange=\(range.duration.seconds) vbytes=\(bytes) frames=\(times)"
            }
            if let at = (try? await asset.loadTracks(withMediaType: .audio))?.first {
                let range = try await at.load(.timeRange)
                let bytes = try await at.load(.totalSampleDataLength)
                vr += " arange=\(range.duration.seconds) abytes=\(bytes)"
            }
            print("EXP preset \(vr)")
            print("EXP preset limit=\(limit) \(outcome) final=\(Thumbnailer.fileBytes(URL(fileURLWithPath: part.path))) tmpPeak=\(peak) duration=\(d.map { $0.seconds } ?? -1) v=\(v) a=\(a) est=\(String(describing: try? await session.estimatedOutputFileLengthInBytes))")
        }
    }
}
