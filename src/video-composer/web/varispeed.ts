/**
 * Sound read at another speed AS A RECORD IS: slower and lower together, or faster and higher. What
 * [ComposeMusic.varispeed] asks for, and the one speed change `time-stretch.ts` is there to avoid.
 *
 * Output sample `i` is the input read at `start + i * speed`, between its samples by a Catmull-Rom
 * cubic: it passes through every sample it reads and turns no corner at any of them, so a slowed
 * song comes out smooth where a straight line between samples would leave a faint buzz on its top.
 * Android's Sonic resamples between two samples and AVFoundation's varispeed with its own filter; no
 * two engines share a resampler, as none shares a time-stretch, and the effect that follows is the
 * arithmetic they do share.
 *
 * Nothing takes the top off before a speed over 1x, which folds what is above the new Nyquist back
 * down. Slow + reverb, the one effect that plays a speed this way, offers only speeds under 1x; a
 * customer who then speeds the sound up on the Speed sheet hears that fold on the web alone.
 *
 * Pure arithmetic over `Float32Array`s, so it is a unit test rather than something to listen to.
 */

/**
 * `count` samples of `input` read from `start` at `speed` samples a sample. A read before the first
 * sample or past the last takes that end's sample, so the caller hands over a sample either side of
 * the stretch it wants where it has them - the one before a pass, and the start of what follows it.
 */
export function varispeed(input: Float32Array, speed: number, count: number, start = 0): Float32Array {
  const out = new Float32Array(Math.max(0, count));
  const last = input.length - 1;
  if (last < 0) return out;
  const at = (k: number): number => input[k < 0 ? 0 : k > last ? last : k]!;
  for (let i = 0; i < out.length; i++) {
    const position = start + i * speed;
    const k = Math.floor(position);
    const t = position - k;
    const x0 = at(k - 1);
    const x1 = at(k);
    const x2 = at(k + 1);
    const x3 = at(k + 2);
    out[i] = x1 + 0.5 * t * (x2 - x0 + t * (2 * x0 - 5 * x1 + 4 * x2 - x3 + t * (3 * (x1 - x2) + x3 - x0)));
  }
  return out;
}
