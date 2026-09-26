import Foundation

// Slow motion that moves, iOS side: which two SOURCE frames an output instant of a slowed clip is made
// from, and how far it is from one to the other. The rules are `slow-motion.ts`'s - the WEB engine's,
// not Android's - and every function here is a port of one there, named after it and pinned by
// `SlowMotionTests` to the same cases and the same numbers as `slow-motion.unit.test.ts`.
//
// A clip slowed below 1x runs out of frames: 30 fps footage at 0.3x has about nine distinct pictures
// in each second of the post, and a compositor that draws "whatever frame the source has at this
// moment" repeats each of them three or four times. So an instant of a slowed clip is drawn from TWO
// source frames: A, the last one presented at or before the source time `s` the instant maps to, and
// B, the one after it, mixed `w` of the way from A's timestamp to B's.
//
// WHY THE WEB'S RULES AND NOT ANDROID'S. Both agree on A, B and w; they differ only in WHERE on the
// source timeline the output's instants fall. Android starts its grid at each slowed clip's first
// frame. The web draws at the post's own instants, `index / fps` from output zero - and so does this
// engine, which has always rendered a fixed `vc.frameDuration` cadence from zero and must keep every
// frame time exactly where it is today. With the same grid and the same rules, iOS draws the web's pairs
// at the web's weights - to within the builder's millisecond rounding of each slowed clip's length,
// which the composition really plays and so `sourceSeconds` follows (see there).
//
// The rules every engine keeps:
//
//  - ONLY a video clip slower than 1x is synthesised (`isSlowMotion`). At 1x or faster every output
//    frame already has a source frame of its own, and a picture has one frame; both are drawn exactly
//    as they were before any of this existed.
//  - Only the clip's OWN frames take part: those stamped at or after its in point and before its out
//    point. A frame the customer trimmed away has no business in the picture, not even blended in at a
//    sixth, and a cut is never mixed across.
//  - Before the clip's first frame - an in point between two frames - that first frame is HELD, and
//    after its last frame the last is held: there is no frame on the other side to blend with.
//  - `w` is taken on the SOURCE timeline, from the frames' REAL timestamps, so a variable frame rate -
//    a phone in low light - is blended by the time that actually passed between the two frames.
//  - Two timestamps within `SAME_FRAME_S` are one frame, and a weight under `MIN_TWEEN_WEIGHT` is A
//    alone.

/// The piece of a file a clip plays, in source seconds: from its in point, up to but NOT including its
/// out point. `SourceWindow` in slow-motion.ts. On iOS it is the source range the builder actually
/// inserted, after the out-point clamp, the layer cut and the transition tail's span.
struct SourceWindow: Equatable, Sendable {
    let from: Double
    let to: Double
}

/// The two frames an instant is made from, as indices into the clip's file's frame times (see
/// `SlowMotion.frameTimes`). `FramePair` in slow-motion.ts, with B an optional where the TypeScript
/// writes -1, so an index that is not there cannot be read by mistake.
struct FramePair: Equatable, Sendable {
    /// The last frame at or before the instant - or, before the clip's first frame, that first frame.
    let a: Int
    /// The frame after A, or nil when there is nothing to blend towards: A is the clip's last frame
    /// (held to the out point), the instant is before the clip's first frame (held from the in point),
    /// or the clip is too short to hold a frame of its own. Set does not mean drawn: see `weight`.
    let b: Int?
    /// 0...1 from A towards B. 0 wherever B is not drawn - `b` nil, an instant on A itself, or one
    /// within `MIN_TWEEN_WEIGHT` of it - and then B need not even be decoded.
    let weight: Double
}

/// The frame-choosing rules of slow motion, as static functions the way `slow-motion.ts` keeps them as
/// module functions. Nothing here knows about AVFoundation: times are Double seconds, and the
/// compositor converts its `CMTime`s at the door.
enum SlowMotion {

    /// The weight below which B is not drawn at all: `MIN_TWEEN_WEIGHT` in slow-motion.ts. A 1/512 mix
    /// moves no 8-bit value by a whole step, so the frame is A's to the eye and to the encoder, and B
    /// need not be decoded for it - which is every output instant that lands exactly on a source frame,
    /// the first frame of every slowed clip among them.
    static let MIN_TWEEN_WEIGHT: Double = 1.0 / 512

    /// Two timestamps closer than this, in seconds, are one frame: `SAME_FRAME_S` in slow-motion.ts. A
    /// container can carry the same presentation time twice - a duplicated packet, an edit - and a pair
    /// of frames zero seconds apart has no fraction between them. It is also the slack every
    /// comparison below allows, so an instant computed in microseconds that lands a rounding error
    /// short of a frame is that frame.
    static let SAME_FRAME_S: Double = 1e-6

    /// Whether a clip is drawn from synthesised frames: `isSlowMotion` in slow-motion.ts, which asks
    /// `clip.speed < 1 && !clip.clip.image`.
    ///
    /// `speed` is the speed the builder scaled the clip with. `image` is a picture, which has one frame
    /// whatever a hand-written spec says its speed is. `held` is the one case the web plan has no word
    /// for: a clip whose in point is at or past the end of its footage, which the builder draws as the
    /// footage's last frame stretched over a millisecond of source. It is a picture in all but name -
    /// one frame, nothing either side of it that belongs to the clip - so it is drawn as it always was.
    /// Every other clip takes the path it always took, pixel for pixel: speed < 1 is the whole signal,
    /// and there is no flag on the wire.
    static func isSlowMotion(speed: Double, image: Bool, held: Bool) -> Bool {
        speed < 1 && !image && !held
    }

    /// The frame times of a file as `framePairAt` searches them: ascending, each frame once, in SECONDS
    /// on the asset's presentation timeline. `frameTimes` in slow-motion.ts.
    ///
    /// A reader hands samples over in DECODE order, and a stream with B-frames presents them in
    /// another, so the list is sorted here rather than trusted. A time within `SAME_FRAME_S` of the
    /// last one KEPT is the same frame and is dropped - measured against the kept one, so a chain of
    /// near-duplicates cannot walk a list forward a microsecond at a time. Anything that is not a finite
    /// number is dropped: `CMTime.invalid` and an indefinite time both reach Double as NaN or infinity.
    static func frameTimes<S: Sequence>(_ timestamps: S) -> [Double] where S.Element == Double {
        let sorted = timestamps.filter { $0.isFinite }.sorted()
        var kept: [Double] = []
        kept.reserveCapacity(sorted.count)
        for time in sorted {
            if let last = kept.last, !(time - last > SAME_FRAME_S) { continue }
            kept.append(time)
        }
        return kept
    }

    /// The frames an instant `seconds` into the SOURCE is made from, or nil for a file with no frames:
    /// `framePairAt` in slow-motion.ts, rule for rule and tolerance for tolerance.
    ///
    /// `times` is what `frameTimes` answers: the whole file's frames, or any stretch of them that
    /// covers the window. `window` is the clip's own piece of the file, and only frames inside it are
    /// used - see the rules at the top of this file. The tolerance at both ends is the one two frames
    /// are told apart by, so a frame stamped a rounding error before an in point computed in
    /// microseconds is still the clip's, and one a rounding error before the out point is not. A clip
    /// too short to hold a single frame of its own (a trim that falls between two) is the frame that
    /// covers the instant, alone, which is what the plain path draws. With no window, the whole list is
    /// the clip's.
    ///
    /// A NaN instant is held on the clip's first frame: every comparison with it is false, and the
    /// hold test is written as a negation so that false means "before".
    ///
    /// Binary searches, because a minute of 60 fps footage is 3600 frames and the compositor asks once
    /// per output frame per slowed layer.
    static func framePairAt(_ times: [Double], seconds: Double, window: SourceWindow? = nil) -> FramePair? {
        let count = times.count
        guard count > 0 else { return nil }
        // The clip's first and last frames: at or after its in point, and before its out point.
        let first = window.map { firstAtOrAfter(times, $0.from - SAME_FRAME_S) } ?? 0
        let last = window.map { firstAtOrAfter(times, $0.to - SAME_FRAME_S) - 1 } ?? count - 1
        if first > last {
            return FramePair(a: lastAtOrBefore(times, seconds, low: 0, high: count - 1), b: nil, weight: 0)
        }
        // Before the clip's first frame, and after its last, the frame there is is held.
        if !(seconds + SAME_FRAME_S >= times[first]) { return FramePair(a: first, b: nil, weight: 0) }
        let a = lastAtOrBefore(times, seconds, low: first, high: last)
        if a >= last { return FramePair(a: a, b: nil, weight: 0) }
        let from = times[a]
        let span = times[a + 1] - from
        let raw = span > 0 ? (seconds - from) / span : 0
        let weight = raw < MIN_TWEEN_WEIGHT ? 0 : min(1, raw)
        return FramePair(a: a, b: a + 1, weight: weight)
    }

    /// Where on the SOURCE timeline composition time `t` falls, in seconds, for a clip the builder
    /// inserted as `insertedStart ..< insertedStart + insertedDuration` of its file and then scaled onto
    /// `placedStart ..< placedStart + placedDuration` of the composition:
    ///
    ///     s = insertedStart + (t - placedStart) * insertedDuration / placedDuration
    ///
    /// That is `CMTimeMapTimeFromRangeToRange(t, fromRange: placed, toRange: inserted)` in Double
    /// seconds, and it is the mapping the composition itself plays the clip by: `scaleTimeRange`
    /// presents a scaled segment "at a rate equal to source.duration / target.duration of its resulting
    /// time mapping", so the ends of the placed range land exactly on the ends of the inserted one.
    /// The web's twin is `sourceTimeUs` in plan.ts, `inUs + offset * speed`.
    ///
    /// WHY NOT `t * speed`. The builder rounds every scaled range to whole MILLISECONDS before it calls
    /// `scaleTimeRange` (`CompositionBuilder`, the base clips, the layers and the transition tails
    /// alike), so the composition does not play a clip at `spec.speed` but at inserted/placed: 1000 ms
    /// at 0.3x is placed on 3333 ms and plays at 0.30003x. Mapped through `spec.speed`, source time
    /// falls behind the frames the composition is actually showing by up to half a millisecond of
    /// output times the speed - 0.1 ms at the end of that clip, 0.3% of a 30 fps frame in `w` - and
    /// the clip's last instants would never reach its out point. Mapped through the ranges it cannot
    /// drift: the builder's own rounding is IN them.
    ///
    /// NO CLAMP TO THE OUT POINT. The web clamps source time to `outUs - 1` before it looks up a pair;
    /// this does not, because the window rules already make every instant at or past the clip's last
    /// own frame the same answer. `framePairAt`'s search for A is bounded by that last frame, and that
    /// frame is stamped more than `SAME_FRAME_S` before the out point, so an `s` of `out - 1 µs`, `out`,
    /// or anything past it all find the last frame, find it is the last, and hold it alone. The lower
    /// end is the same: the compositor never asks for a `t` before `placedStart` (an instruction that
    /// names the clip starts no earlier than the clip does), and if it did, the hold-first rule draws
    /// the web's picture - the clip's first frame, alone. `SlowMotionTests` pins both. So the mapping
    /// stays the straight line AVFoundation plays, and the rules do the clamping in one place.
    ///
    /// A zero or negative placement - which the builder never makes, since it floors every scaled range
    /// at a millisecond - maps everything to the in point rather than dividing by zero.
    static func sourceSeconds(composition t: Double, placedStart: Double, placedDuration: Double,
                              insertedStart: Double, insertedDuration: Double) -> Double {
        guard placedDuration > 0 else { return insertedStart }
        return insertedStart + (t - placedStart) * insertedDuration / placedDuration
    }

    /// The frames composition instant `t` of a slowed clip is made from: `sourceSeconds` for where it
    /// falls in the source, then `framePairAt` over the clip's own frames. `slowFramesAt` in
    /// slow-motion.ts, with the inserted and placed ranges in place of the web's planned clip; the one
    /// call the compositor makes per slowed layer per frame.
    ///
    /// `window` is the clip's own piece of its file, the web's `clipWindow`. It is the range the builder
    /// inserted when nil, which is what it is for every base clip and extra layer; only a transition tail
    /// the builder cut short of its clip passes a wider one (`SlowClip.window` says why).
    static func slowFramesAt(_ times: [Double], composition t: Double, placedStart: Double,
                             placedDuration: Double, insertedStart: Double,
                             insertedDuration: Double, window: SourceWindow? = nil) -> FramePair? {
        let s = sourceSeconds(composition: t, placedStart: placedStart, placedDuration: placedDuration,
                              insertedStart: insertedStart, insertedDuration: insertedDuration)
        return framePairAt(times, seconds: s,
                           window: window ?? SourceWindow(from: insertedStart, to: insertedStart + insertedDuration))
    }

    /// The last index in `low...high` whose time is at or before `seconds` - give or take the tolerance
    /// two frames are told apart by, so an instant that lands a rounding error short of a frame is that
    /// frame and not the end of the one before it - or `low` when none is. `lastAtOrBefore` in
    /// slow-motion.ts.
    private static func lastAtOrBefore(_ times: [Double], _ seconds: Double, low: Int, high: Int) -> Int {
        var low = low
        var high = high
        while low < high {
            let middle = (low + high + 1) >> 1
            if times[middle] <= seconds + SAME_FRAME_S { low = middle } else { high = middle - 1 }
        }
        return low
    }

    /// The first index whose time is at or after `seconds`, or the count when none is.
    /// `firstAtOrAfter` in slow-motion.ts.
    private static func firstAtOrAfter(_ times: [Double], _ seconds: Double) -> Int {
        var low = 0
        var high = times.count
        while low < high {
            let middle = (low + high) >> 1
            if times[middle] < seconds { low = middle + 1 } else { high = middle }
        }
        return low
    }
}
