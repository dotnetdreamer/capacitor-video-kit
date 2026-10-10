import AVFoundation
import MediaToolbox

/// What a sound is put through - `ComposeSoundEffect` in definitions.ts, as the parser leaves it:
/// every number held to its range, and nil in `ComposeMusic.effect` for an effect that would do
/// nothing.
///
/// JS names the effects and lowers each one to these steps (`SOUND_EFFECTS` in
/// `src/editor/sound-effects.ts`), so this engine knows nothing about a megaphone: `SoundEffectChain`
/// runs the steps, which is the overlay motion's precedent and the reason the preview, the web export
/// and both phones cannot disagree about how one sounds.
struct SoundEffect: Sendable, Equatable {
    /// Fold the channels into one before the steps, and play the result from every channel.
    let mono: Bool
    let ops: [SoundOp]

    /// `MAX_SOUND_OPS` in definitions.ts: a spec with more is refused rather than cut short.
    static let maxOps = 16
}

/// One step of a `SoundEffect`. Doubles, because the TypeScript that chose them counts in doubles.
enum SoundOp: Sendable, Equatable {
    case highpass(hz: Double, q: Double)
    case lowpass(hz: Double, q: Double)
    case peak(hz: Double, q: Double, db: Double)
    /// Soft clipping by `db`; measured against the sound's own recent peak when `followMs` is set.
    case drive(db: Double, followMs: Double?)
    case gain(db: Double)
    /// A room: a tail that falls 60 dB in `decayMs`, darkened from `dampHz`, heard at `wet` beside the
    /// sound itself at `dry`. The one step whose arithmetic depends on the channel it runs on.
    case reverb(decayMs: Double, dampHz: Double, wet: Double, dry: Double)
    /// The pitch moved by `semitones` and, apart from it, the resonances - what makes a voice a man's or
    /// a woman's - by `formant`, a frame of 40 ms at a time and that much late.
    case pitch(semitones: Double, formant: Double)
}

/// A `SoundEffect` running on a stream of sound at `sampleRate`, one frame at a time: the arithmetic
/// `ComposeSoundEffect` sets down, line for line as `SoundEffectRunner` in sound-effects.ts and
/// Android's `SoundEffectChain` run it, in doubles throughout. Every step is made here, up front, so
/// the tap's render thread never allocates; `reset` puts them all back to 0 without making anything.
final class SoundEffectChain {
    private let mono: Bool
    /// One chain for a folded sound, else one per channel. Chain `k` is made for the channel numbered
    /// `k` in the frame's order, the folded one as 0, which only a reverb's delays depend on.
    private let chains: [[any SoundStep]]

    init(effect: SoundEffect, sampleRate: Double, channels: Int) {
        mono = effect.mono
        let count = effect.mono ? 1 : max(1, channels)
        chains = (0..<count).map { k in effect.ops.map { stepFor($0, rate: sampleRate, channel: k) } }
    }

    /// One frame - a sample per channel, in -1...1 - through the effect, in place. A channel past the
    /// ones the chain was made for is left as it is, which no format AVFoundation hands a tap has.
    func processFrame(_ frame: UnsafeMutableBufferPointer<Double>) {
        let n = frame.count
        guard n > 0 else { return }
        if mono {
            var sum = 0.0
            for c in 0..<n { sum += frame[c] }
            let y = held(run(chains[0], sum / Double(n)))
            for c in 0..<n { frame[c] = y }
            return
        }
        for c in 0..<min(n, chains.count) {
            frame[c] = held(run(chains[c], frame[c]))
        }
    }

    /// Every state back to 0, as at the start of a pass of the sound.
    func reset() {
        for chain in chains {
            for step in chain { step.reset() }
        }
    }

    private func run(_ chain: [any SoundStep], _ input: Double) -> Double {
        var x = input
        for step in chain { x = step.run(x) }
        return x
    }

    private func held(_ y: Double) -> Double { y > 1 ? 1 : (y < -1 ? -1 : y) }
}

/// Under this a filter's state or the drive's level is set to 0, so silence never goes denormal.
private let tiny = 1e-20
/// The quietest level the drive measures a sound against: -50 dBFS.
private let driveFloor = pow(10.0, -50.0 / 20.0)
/// The highest a filter's frequency goes, as a fraction of the rate.
private let maxHzOfRate = 0.45

private protocol SoundStep: AnyObject {
    func run(_ x: Double) -> Double
    func reset()
}

/// One cookbook biquad in transposed direct form II, its coefficients already divided by `a0`.
private final class Biquad: SoundStep {
    private let b0, b1, b2, a1, a2: Double
    private var z1 = 0.0
    private var z2 = 0.0

    init(_ b0: Double, _ b1: Double, _ b2: Double, _ a0: Double, _ a1: Double, _ a2: Double) {
        self.b0 = b0 / a0
        self.b1 = b1 / a0
        self.b2 = b2 / a0
        self.a1 = a1 / a0
        self.a2 = a2 / a0
    }

    func run(_ x: Double) -> Double {
        let y = b0 * x + z1
        let n1 = b1 * x - a1 * y + z2
        let n2 = b2 * x - a2 * y
        // Both at once or neither, as the contract says: one zeroed alone holds the recurrence just
        // over the line for ever instead of letting it fall silent.
        if n1 < tiny && n1 > -tiny && n2 < tiny && n2 > -tiny {
            z1 = 0
            z2 = 0
        } else {
            z1 = n1
            z2 = n2
        }
        return y
    }

    func reset() {
        z1 = 0
        z2 = 0
    }
}

private final class Drive: SoundStep {
    private let g: Double
    /// The level's fall per sample, or nil for a drive measured against full scale.
    private let decay: Double?
    private var level = 0.0

    init(g: Double, decay: Double?) {
        self.g = g
        self.decay = decay
    }

    func run(_ x: Double) -> Double {
        guard let decay else { return tanh(g * x) }
        let a = x < 0 ? -x : x
        var next = a > level ? a : level * decay
        if next < tiny { next = 0 }
        level = next
        let e = next > driveFloor ? next : driveFloor
        return e * tanh(g * x / e)
    }

    func reset() { level = 0 }
}

private final class Gain: SoundStep {
    private let g: Double
    init(g: Double) { self.g = g }
    func run(_ x: Double) -> Double { g * x }
    func reset() {}
}

/// Jezar's Freeverb tunings, in samples at `tuningRate`: the combs' delays, then the allpasses'.
private let combTuning = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
private let allpassTuning = [556, 441, 341, 225]
private let tuningRate = 44_100.0
/// How many samples, at `tuningRate`, each channel's delays are longer than the one before it's: what
/// makes a stereo tail wide rather than the same tail out of both speakers.
private let stereoSpread = 23

/// The reverb, exactly as `ComposeSoundEffect` writes it down and `Reverb` in sound-effects.ts runs it:
/// Freeverb's eight combs side by side, then its four allpasses one after another, every comb tuned to
/// fall 60 dB in `decayMs` and fed in proportion, so the room's length and its level are two separate
/// numbers. `channel` is the chain's number in the frame, which sets its delays.
///
/// Every line and every state is made here - the chain is made in `TapState.prepare`, where allocating
/// is allowed - and given back in `deinit`. A sample only reads and writes them, and `reset` zeroes
/// them where they are, so the tap's render thread never allocates for a room, however long.
private final class Reverb: SoundStep {
    /// Each comb's delay line, and where in it the next sample is read and then written: `p`.
    private let combs: [UnsafeMutableBufferPointer<Double>]
    private let combAt: UnsafeMutableBufferPointer<Int>
    /// Each comb's `g` and `c`, and its damped value `f`.
    private let feedback: [Double]
    private let take: [Double]
    private let damped: UnsafeMutableBufferPointer<Double>
    /// Each allpass's delay line, and its `p`.
    private let allpasses: [UnsafeMutableBufferPointer<Double>]
    private let allpassAt: UnsafeMutableBufferPointer<Int>
    private let d: Double
    private let undamped: Double
    private let wet: Double
    private let dry: Double

    init(decayMs: Double, dampHz: Double, wet: Double, dry: Double, rate: Double, channel: Int) {
        // `n(t)` in the contract's order of operations: the tuning moved on by the channel's spread,
        // scaled from 44.1 kHz to the rate, rounded half up, and never under one sample.
        func delay(_ tuning: Int) -> Int {
            max(1, Int((Double(tuning + stereoSpread * channel) * rate / tuningRate + 0.5).rounded(.down)))
        }
        let lengths = combTuning.map(delay)
        let feedback = lengths.map { (length: Int) -> Double in pow(10, (-3 * Double(length)) / ((rate * decayMs) / 1000)) }
        self.feedback = feedback
        take = feedback.map { (g: Double) -> Double in ((1 - g * g) / 8).squareRoot() }
        combs = lengths.map { zeros($0, of: Double.self) }
        combAt = zeros(lengths.count, of: Int.self)
        damped = zeros(lengths.count, of: Double.self)
        allpasses = allpassTuning.map { zeros(delay($0), of: Double.self) }
        allpassAt = zeros(allpassTuning.count, of: Int.self)
        let d = exp((-2 * Double.pi * min(dampHz, maxHzOfRate * rate)) / rate)
        self.d = d
        undamped = 1 - d
        self.wet = wet
        self.dry = dry
    }

    deinit {
        for line in combs { line.deallocate() }
        for line in allpasses { line.deallocate() }
        combAt.deallocate()
        damped.deallocate()
        allpassAt.deallocate()
    }

    func run(_ x: Double) -> Double {
        var r = 0.0
        for i in 0..<combs.count {
            let line = combs[i]
            let p = combAt[i]
            let o = line[p]
            var f = undamped * o + d * damped[i]
            if f < tiny && f > -tiny { f = 0 }
            damped[i] = f
            var stored = take[i] * x + feedback[i] * f
            if stored < tiny && stored > -tiny { stored = 0 }
            line[p] = stored
            combAt[i] = p + 1 == line.count ? 0 : p + 1
            r = r + o
        }
        for j in 0..<allpasses.count {
            let line = allpasses[j]
            let p = allpassAt[j]
            let b = line[p]
            var v = r + 0.5 * b
            if v < tiny && v > -tiny { v = 0 }
            line[p] = v
            r = b - 0.5 * v
            allpassAt[j] = p + 1 == line.count ? 0 : p + 1
        }
        return dry * x + wet * r
    }

    /// Every line silent, every `f` 0 and every `p` at the start of its line, as when it was made: a
    /// fresh room, written over in place.
    func reset() {
        for line in combs { zero(line) }
        for line in allpasses { zero(line) }
        zero(combAt)
        zero(damped)
        zero(allpassAt)
    }
}

/// A peak marks the pitch step's envelope when no bin this close to it, in Hz, is louder...
private let envelopeReachHz = 100.0
/// ...and when it is no more than 60 dB, in power, under the frame's loudest peak.
private let envelopeFloor = 1e-6
/// The most the pitch step's envelope lifts a peak by, 20 dB, and lowers one by.
private let pitchMaxGain = 10.0
/// What a frame's spectrum loses to its two windows overlapping four times: a periodic Hann's squares sum to 1.5.
private let hannOverlap = 1.5

/// The pitch step, exactly as `ComposeSoundEffect` writes it down and `Pitch` in sound-effects.ts runs
/// it, expression for expression: a phase vocoder that moves every peak of the spectrum to its new pitch
/// with the bins around it locked to it, and weighs each by the spectrum's envelope where it lands, so a
/// voice's resonances move by its formant whatever the pitch does.
///
/// Every buffer is made here - in `TapState.prepare` for a tap, where allocating is allowed - and given
/// back in `deinit`. A sample only reads and writes them, and `reset` zeroes them where they are.
private final class Pitch: SoundStep {
    private let ratio: Double
    private let formant: Double
    private let hop: Int
    private let length: Int
    private let size: Int
    private let half: Int
    /// How many bins either side a peak has to be the loudest of to mark the envelope.
    private let reach: Int
    /// `sqrt(ratio / formant)`: what keeps the sound as loud with its peaks spread or crowded.
    private let loudness: Double
    /// What a bin's centre frequency turns through in a hop, per bin.
    private let turn: Double
    private let window: UnsafeMutableBufferPointer<Double>
    /// The window again, with the transform's and the overlap's scale in it.
    private let synthesis: UnsafeMutableBufferPointer<Double>
    private let cosTable: UnsafeMutableBufferPointer<Double>
    private let sinTable: UnsafeMutableBufferPointer<Double>
    /// The last `length` inputs, the oldest at `at`.
    private let input: UnsafeMutableBufferPointer<Double>
    private var at = 0
    /// Inputs since the last frame.
    private var count = 0
    /// The overlap-add, from the oldest sample a frame still reaches; and the `hop` it finished last.
    private let sum: UnsafeMutableBufferPointer<Double>
    private let ready: UnsafeMutableBufferPointer<Double>
    private let re: UnsafeMutableBufferPointer<Double>
    private let im: UnsafeMutableBufferPointer<Double>
    /// The frame before's spectrum, as it was read and as it was made, bins 0 to `half`.
    private let lastRe: UnsafeMutableBufferPointer<Double>
    private let lastIm: UnsafeMutableBufferPointer<Double>
    private var outRe: UnsafeMutableBufferPointer<Double>
    private var outIm: UnsafeMutableBufferPointer<Double>
    private var lastOutRe: UnsafeMutableBufferPointer<Double>
    private var lastOutIm: UnsafeMutableBufferPointer<Double>
    private let power: UnsafeMutableBufferPointer<Double>
    private let peaks: UnsafeMutableBufferPointer<Int>
    /// The peaks that mark the envelope, and the log of each one's power.
    private let marks: UnsafeMutableBufferPointer<Int>
    private let levels: UnsafeMutableBufferPointer<Double>
    private var markCount = 0

    init(semitones: Double, formant: Double, rate: Double) {
        // Everything worked out in locals first: a class may not read its own properties until every
        // one of them is set, as `Reverb` does it.
        let ratio = pow(2, semitones / 12)
        let shape = pow(2, formant / 12)
        let hop = max(1, Int((rate / 100 + 0.5).rounded(.down)))
        let length = 4 * hop
        var size = 2
        while size < length { size *= 2 }
        let half = size / 2
        let window = zeros(length, of: Double.self)
        let synthesis = zeros(length, of: Double.self)
        for n in 0..<length {
            window[n] = 0.5 - 0.5 * cos(2 * Double.pi * Double(n) / Double(length))
            synthesis[n] = window[n] / (Double(size) * hannOverlap)
        }
        let cosTable = zeros(half, of: Double.self)
        let sinTable = zeros(half, of: Double.self)
        for k in 0..<half {
            cosTable[k] = cos(2 * Double.pi * Double(k) / Double(size))
            sinTable[k] = sin(2 * Double.pi * Double(k) / Double(size))
        }
        self.ratio = ratio
        self.formant = shape
        self.hop = hop
        self.length = length
        self.size = size
        self.half = half
        reach = max(1, Int((envelopeReachHz * Double(size) / rate + 0.5).rounded(.down)))
        loudness = (ratio / shape).squareRoot()
        turn = 2 * Double.pi * Double(hop) / Double(size)
        self.window = window
        self.synthesis = synthesis
        self.cosTable = cosTable
        self.sinTable = sinTable
        input = zeros(length, of: Double.self)
        sum = zeros(length, of: Double.self)
        ready = zeros(hop, of: Double.self)
        re = zeros(size, of: Double.self)
        im = zeros(size, of: Double.self)
        lastRe = zeros(half + 1, of: Double.self)
        lastIm = zeros(half + 1, of: Double.self)
        outRe = zeros(half + 1, of: Double.self)
        outIm = zeros(half + 1, of: Double.self)
        lastOutRe = zeros(half + 1, of: Double.self)
        lastOutIm = zeros(half + 1, of: Double.self)
        power = zeros(half + 1, of: Double.self)
        peaks = zeros(half + 1, of: Int.self)
        marks = zeros(half + 1, of: Int.self)
        levels = zeros(half + 1, of: Double.self)
    }

    deinit {
        for buffer in [window, synthesis, cosTable, sinTable, input, sum, ready, re, im,
                       lastRe, lastIm, outRe, outIm, lastOutRe, lastOutIm, power, levels] {
            buffer.deallocate()
        }
        peaks.deallocate()
        marks.deallocate()
    }

    func run(_ x: Double) -> Double {
        input[at] = x
        at = at + 1 == length ? 0 : at + 1
        count += 1
        if count == hop {
            count = 0
            frame()
        }
        return ready[count]
    }

    /// Every state back to 0, as when it was made, written over in place.
    func reset() {
        for buffer in [input, sum, ready, re, im, lastRe, lastIm, outRe, outIm, lastOutRe, lastOutIm, power, levels] {
            zero(buffer)
        }
        zero(peaks)
        zero(marks)
        at = 0
        count = 0
        markCount = 0
    }

    private func frame() {
        let mid = length / 2
        // The frame turned so its middle is the transform's first sample: a peak's neighbours then carry
        // its phase rather than a turn each, which is what lets them follow it.
        zero(re)
        zero(im)
        var p = at
        for n in 0..<length {
            re[n < mid ? size - mid + n : n - mid] = input[p] * window[n]
            p = p + 1 == length ? 0 : p + 1
        }
        fft(re, im, cosTable, sinTable, inverse: false)

        for k in 0...half { power[k] = re[k] * re[k] + im[k] * im[k] }

        zero(outRe)
        zero(outIm)
        var peakCount = 0
        for k in 1..<half {
            let v = power[k]
            if v > power[k - 1] && (k < 2 || v > power[k - 2]) && v >= power[k + 1] && (k + 2 > half || v >= power[k + 2]) {
                peaks[peakCount] = k
                peakCount += 1
            }
        }
        // The envelope runs through the peaks nothing near them outshines - a voice's harmonics, and not
        // the ripples between them - straight from one to the next in decibels.
        var loudest = 0.0
        for i in 0..<peakCount where power[peaks[i]] > loudest { loudest = power[peaks[i]] }
        let quietest = loudest * envelopeFloor
        var markTotal = 0
        for i in 0..<peakCount {
            let k = peaks[i]
            let v = power[k]
            if v < quietest { continue }
            let a = k - reach > 0 ? k - reach : 0
            let b = k + reach < half ? k + reach : half
            var top = true
            for m in a...b where power[m] > v {
                top = false
                break
            }
            if top {
                marks[markTotal] = k
                levels[markTotal] = log(v)
                markTotal += 1
            }
        }
        markCount = markTotal
        // Each peak takes the bins from the last one's edge to the quietest bin before the next.
        var from = 1
        for i in 0..<peakCount {
            let k = peaks[i]
            var to = half - 1
            if i + 1 < peakCount {
                let next = peaks[i + 1]
                to = k + 1
                for b in (k + 2)..<next where power[b] < power[to] { to = b }
            }
            move(k, from, to)
            from = to + 1
        }

        for k in 0...half {
            lastRe[k] = re[k]
            lastIm[k] = im[k]
        }
        zero(re)
        zero(im)
        for k in 1..<half {
            re[k] = outRe[k]
            im[k] = outIm[k]
            re[size - k] = outRe[k]
            im[size - k] = -outIm[k]
        }
        fft(re, im, cosTable, sinTable, inverse: true)
        for n in 0..<length { sum[n] = sum[n] + re[n < mid ? size - mid + n : n - mid] * synthesis[n] }

        for n in 0..<hop { ready[n] = sum[n] }
        for n in 0..<(length - hop) { sum[n] = sum[n + hop] }
        for n in (length - hop)..<length { sum[n] = 0 }
        let madeRe = outRe
        let madeIm = outIm
        outRe = lastOutRe
        outIm = lastOutIm
        lastOutRe = madeRe
        lastOutIm = madeIm
    }

    /// Bins `from` to `to`, the region of the peak at bin `k`, moved to where its pitch goes.
    private func move(_ k: Int, _ from: Int, _ to: Int) {
        let phase = atan2(im[k], re[k])
        var d = phase - atan2(lastIm[k], lastRe[k]) - Double(k) * turn
        d -= 2 * Double.pi * (d / (2 * Double.pi) + 0.5).rounded(.down)
        // Its true frequency, in bins, from how far its phase turned since the frame before.
        let bin = Double(k) + d / turn
        let shift = Int((bin * (ratio - 1) + 0.5).rounded(.down))
        let j = k + shift
        if j < 1 || j >= half { return }
        // Carried on from the phase the frame before left at its new bin, so a held note stays one note.
        let previousRe = lastOutRe[j]
        let previousIm = lastOutIm[j]
        let theta = previousRe != 0 || previousIm != 0 ? atan2(previousIm, previousRe) + bin * ratio * turn - phase : 0
        // As loud as the envelope is where its resonances have moved to, against where it came from.
        let lift = exp(0.5 * (level(Double(j) / formant) - level(Double(k)))) * loudness
        let g = lift > pitchMaxGain ? pitchMaxGain : (lift < 1 / pitchMaxGain ? 1 / pitchMaxGain : lift)
        let c = g * cos(theta)
        let s = g * sin(theta)
        for i in from...to {
            let target = i + shift
            if target < 1 || target >= half { continue }
            let xr = re[i]
            let xi = im[i]
            outRe[target] = outRe[target] + (xr * c - xi * s)
            outIm[target] = outIm[target] + (xr * s + xi * c)
        }
    }

    /// The log of the envelope's power at bin `at`, which need not be whole: straight between the marks
    /// either side of it, the nearest one's own beyond the first and the last, and 0 with no mark at all.
    private func level(_ at: Double) -> Double {
        let total = markCount
        if total == 0 { return 0 }
        if at <= Double(marks[0]) { return levels[0] }
        if at >= Double(marks[total - 1]) { return levels[total - 1] }
        var lo = 0
        var hi = total - 1
        while hi - lo > 1 {
            let m = (lo + hi) >> 1
            if Double(marks[m]) <= at { lo = m } else { hi = m }
        }
        let t = (at - Double(marks[lo])) / Double(marks[hi] - marks[lo])
        return levels[lo] + t * (levels[hi] - levels[lo])
    }
}

/// The discrete Fourier transform of `re + i im`, in place, as `fft` in sound-effects.ts: radix 2, its
/// length a power of two, with tables of `cos` and `sin` of `2 * PI * k / length` for the first half of
/// `k`. Forward turns by `e^-i`, inverse by `e^+i`, and neither scales.
private func fft(_ re: UnsafeMutableBufferPointer<Double>, _ im: UnsafeMutableBufferPointer<Double>,
                 _ cosTable: UnsafeMutableBufferPointer<Double>, _ sinTable: UnsafeMutableBufferPointer<Double>,
                 inverse: Bool) {
    let n = re.count
    var j = 0
    for i in 1..<n {
        var bit = n >> 1
        while (j & bit) != 0 {
            j ^= bit
            bit >>= 1
        }
        j ^= bit
        if i < j {
            let r = re[i]
            re[i] = re[j]
            re[j] = r
            let m = im[i]
            im[i] = im[j]
            im[j] = m
        }
    }
    var width = 2
    while width <= n {
        let halfWidth = width / 2
        let step = n / width
        var i = 0
        while i < n {
            for k in 0..<halfWidth {
                let wr = cosTable[k * step]
                let wi = inverse ? sinTable[k * step] : -sinTable[k * step]
                let a = i + k
                let b = a + halfWidth
                let xr = re[b] * wr - im[b] * wi
                let xi = re[b] * wi + im[b] * wr
                re[b] = re[a] - xr
                im[b] = im[a] - xi
                re[a] = re[a] + xr
                im[a] = im[a] + xi
            }
            i += width
        }
        width *= 2
    }
}

/// `count` zeros, made once, for a step to keep: a reverb's lines and its state.
private func zeros<T: Numeric>(_ count: Int, of _: T.Type) -> UnsafeMutableBufferPointer<T> {
    let made = UnsafeMutableBufferPointer<T>.allocate(capacity: count)
    made.initialize(repeating: 0)
    return made
}

/// Every value of `buffer` back to 0, where it is: on the render thread, which must not allocate.
private func zero<T: Numeric>(_ buffer: UnsafeMutableBufferPointer<T>) {
    for k in buffer.indices { buffer[k] = 0 }
}

/// The step `op` stands for at `rate`, on the chain numbered `channel` - which only a reverb asks.
private func stepFor(_ op: SoundOp, rate: Double, channel: Int) -> any SoundStep {
    switch op {
    case let .drive(db, followMs):
        return Drive(g: pow(10, db / 20), decay: followMs.map { exp(-1000 / ($0 * rate)) })
    case let .gain(db):
        return Gain(g: pow(10, db / 20))
    case let .reverb(decayMs, dampHz, wet, dry):
        return Reverb(decayMs: decayMs, dampHz: dampHz, wet: wet, dry: dry, rate: rate, channel: channel)
    case let .pitch(semitones, formant):
        return Pitch(semitones: semitones, formant: formant, rate: rate)
    case let .highpass(hz, q):
        let (cosW, alpha) = corner(hz, q, rate)
        return Biquad((1 + cosW) / 2, -(1 + cosW), (1 + cosW) / 2, 1 + alpha, -2 * cosW, 1 - alpha)
    case let .lowpass(hz, q):
        let (cosW, alpha) = corner(hz, q, rate)
        return Biquad((1 - cosW) / 2, 1 - cosW, (1 - cosW) / 2, 1 + alpha, -2 * cosW, 1 - alpha)
    case let .peak(hz, q, db):
        let (cosW, alpha) = corner(hz, q, rate)
        let a = pow(10, db / 40)
        return Biquad(1 + alpha * a, -2 * cosW, 1 - alpha * a, 1 + alpha / a, -2 * cosW, 1 - alpha / a)
    }
}

/// `cos w0` and `alpha` for a filter at `hz`, held under `maxHzOfRate` of the rate.
private func corner(_ hz: Double, _ q: Double, _ rate: Double) -> (Double, Double) {
    let w0 = 2 * Double.pi * min(hz, maxHzOfRate * rate) / rate
    return (cos(w0), sin(w0) / (2 * q))
}

// MARK: - The tap

/// The audio tap a sound's track is run through: `SoundEffectChain` on the audio AVFoundation reads
/// for that track, set on its `AVMutableAudioMixInputParameters` by `CompositionBuilder.addMusic`.
///
/// PRE-effects, which Apple's QA1783 defines as "called before any effects specified by
/// AVAudioMixInputParameters are applied" - the volume ramps that carry the sound's level and its
/// fades. So the level and the fades take down what the effect made, `ComposeMusic.effect`'s order on
/// every engine. Each sound is a track of its own, so the tap hears that sound and nothing else, and
/// it carries its state across a loop's seams, which the contract allows: a reverb's tail rings on
/// into the next pass here, where the other engines start each pass from silence.
///
/// It runs wherever the audio mix does: `Exporter`'s session and `WriterEngine`'s reader both take
/// `BuiltComposition.audioMix`. AVFoundation hands a tap 32-bit float, deinterleaved as a rule; an
/// interleaved buffer is read as one, and any other format is left as it is rather than played as
/// noise - logged, because the sound then reaches the post without its effect.
enum SoundEffectTap {

    /// A tap that runs `effect`, or nil when MediaToolbox would not make one.
    ///
    /// The state rides on the tap from `init` to `finalize`, which releases it. A tap that is never
    /// made leaks that one small object rather than risk releasing it twice: whether `init` ran before
    /// a failed create is nowhere written down. Apple asks for the callbacks to be filled in a local
    /// rather than a global or a static, for the misaligned function pointers they hold on 64-bit.
    static func make(_ effect: SoundEffect) -> MTAudioProcessingTap? {
        // Each callback typed on its own line: closures that capture nothing, which is what lets Swift
        // hand them to MediaToolbox as C function pointers.
        let initialise: MTAudioProcessingTapInitCallback = { _, clientInfo, tapStorageOut in
            tapStorageOut.pointee = clientInfo
        }
        let finalize: MTAudioProcessingTapFinalizeCallback = { tap in
            Unmanaged<TapState>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
        }
        let prepare: MTAudioProcessingTapPrepareCallback = { tap, _, format in
            Unmanaged<TapState>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue().prepare(format.pointee)
        }
        let unprepare: MTAudioProcessingTapUnprepareCallback = { tap in
            Unmanaged<TapState>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue().unprepare()
        }
        let process: MTAudioProcessingTapProcessCallback = { tap, numberFrames, _, bufferListInOut, numberFramesOut, flagsOut in
            // In place: the buffer list's data pointers come back pointing at the source audio.
            guard MTAudioProcessingTapGetSourceAudio(tap, numberFrames, bufferListInOut, flagsOut, nil, numberFramesOut) == noErr else {
                return
            }
            Unmanaged<TapState>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
                .process(bufferListInOut, frames: Int(numberFramesOut.pointee), flags: flagsOut.pointee)
        }
        let state = Unmanaged.passRetained(TapState(effect: effect))
        var callbacks = MTAudioProcessingTapCallbacks(version: kMTAudioProcessingTapCallbacksVersion_0,
                                                      clientInfo: state.toOpaque(),
                                                      init: initialise,
                                                      finalize: finalize,
                                                      prepare: prepare,
                                                      unprepare: unprepare,
                                                      process: process)
        var tap: MTAudioProcessingTap?
        let status = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PreEffects, &tap)
        guard status == noErr, let made = tap else { return nil }
        return made
    }
}

/// One tap's effect and its chain. The chain is made in `prepare`, where the rate and the channels are
/// first known and allocating is allowed, and only read on the render thread.
private final class TapState {
    let effect: SoundEffect
    private var chain: SoundEffectChain?
    private var channels = 0
    private var interleaved = false
    /// One frame's samples, made with the chain so `process` makes nothing.
    private var frame = UnsafeMutableBufferPointer<Double>(start: nil, count: 0)

    init(effect: SoundEffect) {
        self.effect = effect
    }

    deinit {
        frame.deallocate()
    }

    func prepare(_ format: AudioStreamBasicDescription) {
        unprepare()
        let float = format.mFormatID == kAudioFormatLinearPCM
            && format.mFormatFlags & kAudioFormatFlagIsFloat != 0
            && format.mBitsPerChannel == 32
        let count = Int(format.mChannelsPerFrame)
        guard float, count > 0, format.mSampleRate > 0 else {
            NSLog("[CapacitorVideoKitCore] a sound effect could not read its track's audio (format %u, flags %u, %u bits); it plays without it",
                  format.mFormatID, format.mFormatFlags, format.mBitsPerChannel)
            return
        }
        channels = count
        interleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0 && count > 1
        frame = UnsafeMutableBufferPointer<Double>.allocate(capacity: count)
        frame.initialize(repeating: 0)
        chain = SoundEffectChain(effect: effect, sampleRate: format.mSampleRate, channels: count)
    }

    func unprepare() {
        chain = nil
        frame.deallocate()
        frame = UnsafeMutableBufferPointer<Double>(start: nil, count: 0)
    }

    func process(_ list: UnsafeMutablePointer<AudioBufferList>, frames: Int, flags: MTAudioProcessingTapFlags) {
        guard let chain, frames > 0 else { return }
        // Where AVFoundation says a stream starts again, so does the effect: after a seek, a fresh pass.
        if flags & kMTAudioProcessingTapFlag_StartOfStream != 0 { chain.reset() }
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        if interleaved {
            guard let data = buffers.first?.mData?.assumingMemoryBound(to: Float.self) else { return }
            for i in 0..<frames {
                for c in 0..<channels { frame[c] = Double(data[i * channels + c]) }
                chain.processFrame(frame)
                for c in 0..<channels { data[i * channels + c] = Float(frame[c]) }
            }
            return
        }
        // One buffer per channel. A list shorter than the format says is treated as far as it goes.
        let present = min(channels, buffers.count)
        guard present > 0 else { return }
        let lane = UnsafeMutableBufferPointer(rebasing: frame[0..<present])
        for i in 0..<frames {
            for c in 0..<present {
                lane[c] = buffers[c].mData.map { Double($0.assumingMemoryBound(to: Float.self)[i]) } ?? 0
            }
            chain.processFrame(lane)
            for c in 0..<present {
                if let data = buffers[c].mData {
                    data.assumingMemoryBound(to: Float.self)[i] = Float(lane[c])
                }
            }
        }
    }
}
