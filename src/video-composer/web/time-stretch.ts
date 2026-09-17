/**
 * Speeding sound up or slowing it down WITHOUT moving its pitch.
 *
 * The contract says a speed change preserves pitch, and both native engines get that for free -
 * Media3's speed-changing audio processor and AVFoundation's time-pitch unit both do it in the
 * platform. The web has nothing equivalent: `AudioBufferSourceNode.playbackRate` resamples, so a 2x
 * clip comes out an octave up, and an editor that sounded right in the preview would post a video
 * full of chipmunks.
 *
 * So it is done here, with SOLA - synchronised overlap-add. The idea is old and simple: cut the
 * signal into overlapping frames, lay them down at a different spacing than they were taken from,
 * and before each one is laid down, slide it by up to a few milliseconds to the position where it
 * best lines up with what is already there. Sliding by whole samples is what preserves the
 * waveform's period, and preserving the period is what preserves the pitch.
 *
 * Pure arithmetic over `Float32Array`s, so it is a unit test rather than something to listen to.
 */

/** 40 ms of signal per frame: long enough to hold a low vowel's period, short enough to stay crisp. */
const FRAME_SECONDS = 0.04;

/** How far a frame may slide to find its best fit. Eight milliseconds covers down to 125 Hz. */
const SEARCH_SECONDS = 0.008;

/** The search runs on a coarse grid: two samples at 48 kHz is well under a cycle of anything audible. */
const SEARCH_STEP = 2;

/** Only the head of the overlap is correlated. The tail agrees whenever the head does. */
const CORRELATION_SAMPLES = 512;

/**
 * `input` played `rate` times faster, at its own pitch.
 *
 * A rate of exactly 1 hands the input straight back - the same instance, not a copy, because
 * nothing downstream writes to it and the copy would be a megabyte a minute per channel for no
 * reason. Anything under a quarter or over four is clamped, matching the manifest's own limits.
 */
export function timeStretch(input: Float32Array, rate: number, sampleRate: number): Float32Array {
  const speed = Math.min(4, Math.max(0.25, rate));
  if (Math.abs(speed - 1) < 1e-6 || input.length === 0) return input;

  const frame = evenLength(Math.round(FRAME_SECONDS * sampleRate));
  const synthesisHop = frame >> 1;
  const analysisHop = Math.max(1, Math.round(synthesisHop * speed));
  const search = Math.round(SEARCH_SECONDS * sampleRate);

  // A source too short to hold even one frame cannot be overlap-added at all; resampling it is the
  // honest fallback and, at a few tens of milliseconds, is not long enough for a pitch shift to be
  // audible.
  if (input.length < frame) return resample(input, speed);

  const expected = Math.ceil(input.length / speed);
  const output = new Float32Array(expected);
  let outAt = 0;
  let inAt = 0;
  // The second half of the previous frame, waiting to be crossfaded with the next one's first half.
  let tail: Float32Array | null = null;

  // One HOP of source is the requirement, not a whole frame plus its search margin. Demanding the
  // margin costs the last frame and a half of every clip - about fifty milliseconds, which at 0.5x
  // is a hundred milliseconds of output simply missing off the end. So the last few frames run with
  // whatever room is left: a shorter search, and a frame cut to what the source still has.
  while (inAt + synthesisHop <= input.length && outAt + synthesisHop <= output.length) {
    const room = Math.max(0, Math.min(search, input.length - inAt - synthesisHop));
    const start = tail ? bestOffset(input, tail, inAt, room, synthesisHop) : inAt;
    // What of this hop the source can actually fill. Short only on the very last frame.
    const filled = Math.min(synthesisHop, input.length - start);

    if (tail) {
      for (let i = 0; i < synthesisHop; i++) {
        // A linear crossfade, not a raised cosine. With the frames already aligned on their own
        // period, linear keeps the two weights summing to exactly one and so cannot dip the level
        // in the middle of the join. Past `filled` there is no new frame to fade in, so what is
        // left is the previous one fading out - silence would be a click.
        const w = i / synthesisHop;
        const next = i < filled ? (input[start + i] ?? 0) * w : 0;
        output[outAt + i] = (tail[i] ?? 0) * (1 - w) + next;
      }
    } else {
      for (let i = 0; i < filled; i++) output[outAt + i] = input[start + i] ?? 0;
    }

    tail = input.subarray(Math.min(start + synthesisHop, input.length), Math.min(start + frame, input.length));
    outAt += synthesisHop;
    inAt += analysisHop;
  }

  // Whatever the last frame still had to say, as far as there is room for it.
  if (tail) {
    const room = Math.min(tail.length, output.length - outAt);
    for (let i = 0; i < room; i++) output[outAt + i] = tail[i] ?? 0;
    outAt += room;
  }

  // The loop stops on whichever limit comes first, so the buffer can be a frame longer than what
  // was written. Trimming beats leaving a tail of silence on every clip.
  return outAt === output.length ? output : output.slice(0, outAt);
}

/**
 * Where, within `±search` of `at`, the next frame lines up best with the tail of the last one.
 *
 * Plain cross-correlation rather than a normalised one: both windows come from the same signal
 * moments apart, so their energies are near enough equal for the numerator alone to pick the same
 * winner, and it is half the arithmetic in the hottest loop in the file.
 */
function bestOffset(input: Float32Array, tail: Float32Array, at: number, search: number, overlap: number): number {
  const length = Math.min(CORRELATION_SAMPLES, overlap, tail.length);
  const from = Math.max(0, at - search);
  const to = Math.max(from, Math.min(input.length - overlap, at + search));
  let bestAt = Math.min(Math.max(at, from), to);
  let best = -Infinity;

  for (let candidate = from; candidate <= to; candidate += SEARCH_STEP) {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += (tail[i] ?? 0) * (input[candidate + i] ?? 0);
    if (sum > best) {
      best = sum;
      bestAt = candidate;
    }
  }
  return bestAt;
}

/**
 * Linear resampling - a pitch shift, and only ever used for a fragment too short for the real
 * thing. Linear rather than nearest, so the fragment does not also acquire an edge.
 */
function resample(input: Float32Array, speed: number): Float32Array {
  const length = Math.max(1, Math.floor(input.length / speed));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const at = i * speed;
    const index = Math.floor(at);
    const frac = at - index;
    const a = input[Math.min(index, input.length - 1)] ?? 0;
    const b = input[Math.min(index + 1, input.length - 1)] ?? 0;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

function evenLength(value: number): number {
  const at = Math.max(64, value);
  return at % 2 === 0 ? at : at + 1;
}
