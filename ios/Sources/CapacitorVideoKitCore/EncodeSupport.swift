import CoreMedia
import Foundation
import VideoToolbox

/**
 Which frames this device's H.264 encoder will take, for the plugin's `encodeSupport`.

 iOS has no table to read, unlike Android's `MediaCodecInfo`: the only honest way to find out
 whether VideoToolbox will encode 4K60 on THIS device is to ask it for that encoder and see what it
 says. So a compression session is created at the size and thrown away again, which allocates
 nothing on the GPU because no frame is ever fed to it and takes well under a millisecond.

 The rate is asked about as well as the size, as Android's `areSizeAndRateSupported` asks it and
 the web probes WebCodecs at it. A session takes any expected frame rate it is told, so the rate's
 real ceiling is the one the encoder states for itself: the highest H.264 level it lists (`Level`).
 A level bounds how many macroblocks a frame may have and how many a second, which is where a
 device that encodes a size at 30 fps and not at 60 shows it. Sizes are tried BOTH WAYS ROUND, as
 Android tries them, because an encoder may state its limits in landscape and a portrait post asks
 for the same pixels standing up.

 `plugin.ts` promises the answers are cached for the life of the process, because they cannot
 change while the app runs, so each size and rate is asked of VideoToolbox once.
 */
final class EncodeSupport: @unchecked Sendable {

    struct Answer: Equatable {
        let supported: Bool
        /// A sentence for the customer when `supported` is false, and nil when it is true.
        let reason: String?
    }

    /// What the encoder says about one frame, the one way round it was asked.
    enum Verdict: Equatable {
        case fits
        /// The frame is more than the encoder takes at any rate.
        case sizeRefused
        /// The frame fits, just not that many of them a second.
        case rateRefused
    }

    typealias Probe = (_ width: Int, _ height: Int, _ fps: Int) -> Verdict

    /// The one the plugin asks, backed by VideoToolbox.
    static let shared = EncodeSupport(probe: EncodeSupport.videoToolbox)

    private struct Frame: Hashable {
        let width: Int
        let height: Int
        let fps: Int
    }

    private let probe: Probe
    private let lock = NSLock()
    private var answers: [Frame: Answer] = [:]

    /// `probe` is VideoToolbox in the app; a test hands in one it can count.
    init(probe: @escaping Probe) {
        self.probe = probe
    }

    /**
     Whether this device can encode `width` x `height` at `fps`, with a sentence when it cannot.

     The reason names the rate only when the rate is what is refused, in Android's words; a size
     the encoder will not take at all is said without one, because naming a rate there would
     suggest that a lower one would do.
     */
    func answer(width: Int, height: Int, fps: Int) -> Answer {
        guard width > 0, height > 0 else { return Answer(supported: false, reason: "That is not a frame.") }
        let frame = Frame(width: width, height: height, fps: fps)

        lock.lock()
        let known = answers[frame]
        lock.unlock()
        if let known { return known }

        let answer = decide(frame)
        lock.lock()
        answers[frame] = answer
        lock.unlock()
        return answer
    }

    private func decide(_ frame: Frame) -> Answer {
        let upright = probe(frame.width, frame.height, frame.fps)
        if upright == .fits { return Answer(supported: true, reason: nil) }
        // Either way round: the same pixels turned through a right angle.
        let turned = probe(frame.height, frame.width, frame.fps)
        if turned == .fits { return Answer(supported: true, reason: nil) }

        let short = min(frame.width, frame.height)
        if upright == .rateRefused || turned == .rateRefused {
            return Answer(supported: false,
                          reason: "\(short)P at \(frame.fps)fps is more than this device's encoder can take.")
        }
        return Answer(supported: false, reason: "\(short)P is more than this device's encoder can take.")
    }

    /**
     What VideoToolbox says about one frame, asked by asking it for an H.264 encoder at that size.

     The session is invalidated straight away: it is the CREATION that answers the question, and a
     session left open holds an encoder the rest of the system could be using. A session that will
     not take the rate as its expected frame rate refuses the rate outright; one that does is held
     to the highest level it lists, and one that lists none has said all it is going to by being
     created.
     */
    static func videoToolbox(width: Int, height: Int, fps: Int) -> Verdict {
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session)
        guard status == noErr, let session else { return .sizeRefused }
        defer { VTCompressionSessionInvalidate(session) }

        if fps > 0,
           VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate,
                                value: fps as CFNumber) != noErr {
            return .rateRefused
        }

        var supported: CFDictionary?
        VTSessionCopySupportedPropertyDictionary(session, supportedPropertyDictionaryOut: &supported)
        let levels = ((supported as? [String: Any])?[kVTCompressionPropertyKey_ProfileLevel as String]
            as? [String: Any])?[kVTPropertySupportedValueListKey as String] as? [String] ?? []
        guard let ceiling = Level.highest(in: levels) else { return .fits }
        return ceiling.verdict(width: width, height: height, fps: fps)
    }

    /**
     One H.264 level's two limits that a frame and a rate run into (ITU-T H.264 Table A-1): the
     macroblocks in one frame, and the macroblocks a second.

     4K at 60 fps is 32,400 macroblocks a frame and 1,944,000 a second, which level 5.2 takes and
     5.1 does not; 8K is more macroblocks in one frame than any level VideoToolbox lists.
     */
    struct Level: Equatable {
        let name: String
        let maxFrameMacroblocks: Int
        let maxMacroblocksPerSecond: Int

        /// Every level VideoToolbox has a name for (`kVTProfileLevel_H264_*`), lowest first.
        static let table: [Level] = [
            Level(name: "1_3", maxFrameMacroblocks: 396, maxMacroblocksPerSecond: 11_880),
            Level(name: "3_0", maxFrameMacroblocks: 1_620, maxMacroblocksPerSecond: 40_500),
            Level(name: "3_1", maxFrameMacroblocks: 3_600, maxMacroblocksPerSecond: 108_000),
            Level(name: "3_2", maxFrameMacroblocks: 5_120, maxMacroblocksPerSecond: 216_000),
            Level(name: "4_0", maxFrameMacroblocks: 8_192, maxMacroblocksPerSecond: 245_760),
            Level(name: "4_1", maxFrameMacroblocks: 8_192, maxMacroblocksPerSecond: 245_760),
            Level(name: "4_2", maxFrameMacroblocks: 8_704, maxMacroblocksPerSecond: 522_240),
            Level(name: "5_0", maxFrameMacroblocks: 22_080, maxMacroblocksPerSecond: 589_824),
            Level(name: "5_1", maxFrameMacroblocks: 36_864, maxMacroblocksPerSecond: 983_040),
            Level(name: "5_2", maxFrameMacroblocks: 36_864, maxMacroblocksPerSecond: 2_073_600),
        ]

        /// The highest level named in a `kVTCompressionPropertyKey_ProfileLevel` value list -
        /// `H264_High_5_2` and the like, over every profile - or nil when it names none this knows,
        /// `AutoLevel` included.
        static func highest(in values: [String]) -> Level? {
            var best: Int?
            for value in values {
                guard value.hasPrefix("H264_"),
                      let index = table.firstIndex(where: { value.hasSuffix("_\($0.name)") }) else { continue }
                best = max(best ?? index, index)
            }
            return best.map { table[$0] }
        }

        func verdict(width: Int, height: Int, fps: Int) -> Verdict {
            // A frame is coded in whole 16 x 16 macroblocks, a partial one at an edge included.
            let perFrame = ((width + 15) / 16) * ((height + 15) / 16)
            if perFrame > maxFrameMacroblocks { return .sizeRefused }
            if perFrame * max(0, fps) > maxMacroblocksPerSecond { return .rateRefused }
            return .fits
        }
    }
}
