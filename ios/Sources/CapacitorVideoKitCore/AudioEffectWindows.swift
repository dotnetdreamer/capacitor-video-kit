import Foundation

/// One window of `ComposeAudio.effects`, as the parser leaves it - `ComposeAudioEffect` in
/// definitions.ts: an effect over `startMs..endMs` of the FINISHED mix, everything heard there at
/// once, the window played from its start at `speed` as a record plays a speed. `startMs` is held to 0
/// and up, `endMs` is after it, `speed` is in `minSpeed...1`, and a window that would change nothing
/// - no steps, a speed of 1 - is not one the parser keeps.
struct AudioEffectWindow: Sendable, Equatable {
    let startMs: Double
    let endMs: Double
    let speed: Double
    /// Nil for a window that only slows.
    let effect: SoundEffect?

    /// `MAX_AUDIO_EFFECTS`: a spec with more is refused rather than cut short.
    static let maxCount = 50
    /// `MIN_AUDIO_EFFECT_SPEED`.
    static let minSpeed = 0.5
    /// `AUDIO_EFFECT_RAMP_MS`: how long a window takes to come in and to go out.
    static let rampMs = 30.0
    /// `AUDIO_EFFECT_MIN_TAIL_MS`: the least a window's steps run on after it.
    static let minTailMs = 500.0

    /// How long its steps run on after it: twice the longest reverb's `decayMs` - 120 dB down - and
    /// never under `minTailMs`. `audioEffectTailMs` in audio-effect-windows.ts.
    var tailMs: Double {
        var decayMs = 0.0
        for op in effect?.ops ?? [] {
            if case .reverb(let decay, _, _, _) = op { decayMs = max(decayMs, decay) }
        }
        return max(Self.minTailMs, 2 * decayMs)
    }
}

/// A time on the stream as a frame number, rounded half up, as every engine rounds it.
func frameAt(_ ms: Double, rate: Double) -> Int64 {
    Int64((ms * rate / 1000 + 0.5).rounded(.down))
}

/// Every window of a list running on a stream of sound: `ComposeAudioEffect`'s arithmetic, frame for
/// frame, line for line as `AudioEffectRunner` in audio-effect-windows.ts and Android's runner run it.
/// The stream comes in order, in pieces of any size, interleaved, and leaves exactly as it would in
/// one; the first frame of the first piece is output frame `firstFrame`. Each window runs on what the
/// one before it left.
final class AudioEffectRunner {
    private let stages: [WindowStage]
    private var frame: Int64

    init(windows: [AudioEffectWindow], sampleRate: Double, channels: Int, firstFrame: Int64 = 0) {
        stages = windows.map { WindowStage($0, rate: sampleRate, channels: max(1, channels)) }
        frame = firstFrame
    }

    /// The output frame past which nothing is changed: where the last tail ends. 0 for none.
    var endFrame: Int64 { stages.map(\.tailEnd).max() ?? 0 }

    /// `count` interleaved frames from `samples` through every window, in place, -1...1 in and out.
    func process(_ samples: UnsafeMutablePointer<Double>, count: Int) {
        guard count > 0 else { return }
        for stage in stages { stage.process(samples, count: count, at: frame) }
        frame += Int64(count)
    }
}

/// One window of the list, with its own steps and its own memory of its input.
private final class WindowStage {
    let start: Int64
    let end: Int64
    let tailEnd: Int64
    private let ramp: Int64
    private let speed: Double
    private let channels: Int
    private let steps: SoundEffectChain?
    /// What goes through the steps, one sample per channel.
    private var wet: [Double]
    /// A slowed window's input, per channel: entry `i` is frame `historyFrom + i`, and the first
    /// `historyDead` of them it will never read again.
    private var history: [[Double]]
    private var historyFrom: Int64 = 0
    private var historyDead = 0

    init(_ window: AudioEffectWindow, rate: Double, channels: Int) {
        start = frameAt(window.startMs, rate: rate)
        end = max(start, frameAt(window.endMs, rate: rate))
        tailEnd = end + frameAt(window.tailMs, rate: rate)
        ramp = min(frameAt(AudioEffectWindow.rampMs, rate: rate), (end - start) / 2)
        speed = window.speed
        self.channels = channels
        steps = window.effect.map { SoundEffectChain(effect: $0, sampleRate: rate, channels: channels) }
        wet = Array(repeating: 0, count: channels)
        history = window.speed < 1 ? Array(repeating: [], count: channels) : []
    }

    private var slows: Bool { speed < 1 }

    func process(_ samples: UnsafeMutablePointer<Double>, count: Int, at: Int64) {
        // A slowed window remembers the frame before it as well: its first frames read it.
        let first = max(at, slows ? start - 1 : start)
        let last = min(at + Int64(count), tailEnd)
        guard first < last else { return }
        wet.withUnsafeMutableBufferPointer { wet in
            for n in first..<last {
                let base = samples + Int(n - at) * channels
                if slows && n < end { remember(base, frame: n) }
                // The frame before the window is only remembered, never changed.
                if n < start { continue }
                let g = gate(n)
                for c in 0..<channels {
                    let w = n >= end ? 0 : (slows ? slowed(c, frame: n) : base[c])
                    wet[c] = g * w
                }
                steps?.processFrame(wet)
                let keep = 1 - g
                for c in 0..<channels { base[c] = held(keep * base[c] + wet[c]) }
                if slows && n < end { forget(next: n + 1) }
            }
        }
    }

    /// g(n): 0 at the start, up over the ramp, 1, down over the ramp to 0 at the end; 0 outside.
    private func gate(_ n: Int64) -> Double {
        if n < start || n >= end { return 0 }
        if ramp <= 0 { return 1 }
        let g = Double(min(n - start, end - n)) / Double(ramp)
        return g < 1 ? g : 1
    }

    /// w(n) of a slowed window: the input read at `start + (n - start) * speed`, by Catmull-Rom.
    private func slowed(_ c: Int, frame n: Int64) -> Double {
        let position = Double(start) + Double(n - start) * speed
        let k = Int64(position.rounded(.down))
        let t = position - Double(k)
        let x0 = input(c, k - 1, now: n)
        let x1 = input(c, k, now: n)
        let x2 = input(c, k + 1, now: n)
        let x3 = input(c, k + 2, now: n)
        return x1 + 0.5 * t * (x2 - x0 + t * (2 * x0 - 5 * x1 + 4 * x2 - x3 + t * (3 * (x1 - x2) + x3 - x0)))
    }

    /// x(k) as the slowed mix reads it: a frame after `now` reads `now`, one before 0 reads 0, and one
    /// before what is remembered - a stream handed over from inside the window - the earliest there is.
    private func input(_ c: Int, _ k: Int64, now: Int64) -> Double {
        let frame = k > now ? now : (k < 0 ? 0 : k)
        let list = history[c]
        let index = min(max(0, Int(frame - historyFrom)), list.count - 1)
        return list[index]
    }

    private func remember(_ base: UnsafeMutablePointer<Double>, frame n: Int64) {
        if history[0].isEmpty {
            historyFrom = n
            historyDead = 0
        }
        for c in 0..<channels { history[c].append(base[c]) }
    }

    /// Lets go of the input the slowed mix will never read again, once that is the bigger half.
    private func forget(next: Int64) {
        if next >= end {
            // Past the window nothing reads its input at all.
            history = Array(repeating: [], count: channels)
            return
        }
        let oldest = Int64((Double(start) + Double(next - start) * speed).rounded(.down)) - 1
        historyDead = max(0, min(history[0].count, Int(oldest - historyFrom)))
        if historyDead >= 4096 && 2 * historyDead >= history[0].count {
            for c in 0..<channels { history[c].removeFirst(historyDead) }
            historyFrom += Int64(historyDead)
            historyDead = 0
        }
    }

    private func held(_ y: Double) -> Double { y > 1 ? 1 : (y < -1 ? -1 : y) }
}
