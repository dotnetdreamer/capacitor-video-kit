import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractPeaks, reducePeaks } from './waveform';

/*
 * The measuring half only. Decoding needs Web Audio, which the mock DOM these run in does not
 * have - that is why `reducePeaks` is exported separately from `extractPeaks`, and the real decode
 * is covered in `waveform.cmp.test.ts` where there is a browser to do it.
 *
 * A rate of 1000 Hz with a 10 ms step puts exactly ten samples in a bucket, so every expectation
 * below can be checked by counting.
 */
const RATE = 1000;
const STEP = 10;

/** `count` samples, each from `f(i)`. */
function samples(count: number, f: (i: number) => number): Float32Array {
  return Float32Array.from({ length: count }, (_, i) => f(i));
}

describe('reducePeaks', () => {
  it('measures the loudest sample in each bucket, as a byte of full scale', () => {
    const { peaks, max } = reducePeaks([samples(30, () => 0.6)], RATE, STEP);

    expect(peaks.length).toBe(3);
    expect([...peaks]).toEqual([153, 153, 153]);
    expect(max).toBe(153);
  });

  it('takes the PEAK of a bucket, not its average', () => {
    // One loud sample in an otherwise silent bucket is the whole point: it is the transient a
    // customer lines a cut up to, and an average would bury it.
    const { peaks } = reducePeaks([samples(10, i => (i === 7 ? 1 : 0))], RATE, STEP);

    expect([...peaks]).toEqual([255]);
  });

  it('measures how far from silence a sample is, either way', () => {
    const { peaks } = reducePeaks([samples(10, () => -0.6)], RATE, STEP);

    expect([...peaks]).toEqual([153]);
  });

  it('takes the louder channel rather than mixing them', () => {
    // A hard-panned part would read as a quiet file if the channels were averaged.
    const left = samples(10, () => 0.8);
    const right = samples(10, () => 0);

    expect([...reducePeaks([left, right], RATE, STEP).peaks]).toEqual([204]);
    expect([...reducePeaks([right, left], RATE, STEP).peaks]).toEqual([204]);
  });

  it('clamps samples past full scale instead of overflowing the byte', () => {
    // Float PCM is not obliged to stay inside -1..1, and a clipped MP3 really does decode past it.
    const { peaks, max } = reducePeaks([samples(10, () => 1.7)], RATE, STEP);

    expect([...peaks]).toEqual([255]);
    expect(max).toBe(255);
  });

  it('reports a silent track as measured, with a max of zero', () => {
    // The one distinction the drawing depends on: this is "measured, and there is nothing here",
    // which draws a hairline, as against no measurement at all, which draws nothing.
    const { peaks, max } = reducePeaks([samples(20, () => 0)], RATE, STEP);

    expect(peaks.length).toBe(2);
    expect(max).toBe(0);
  });

  it('keeps the loudest bucket of the whole track as `max`', () => {
    const { peaks, max } = reducePeaks([samples(30, i => (i < 10 ? 0.2 : i < 20 ? 0.9 : 0.4))], RATE, STEP);

    // 229 rather than 230: a `Float32Array` holds 0.9 as a shade under it, and 255 times that
    // lands a hair below 229.5. Worth pinning, because it is the kind of drift a reader would
    // otherwise "correct" into a rounding change.
    expect([...peaks]).toEqual([51, 229, 102]);
    expect(max).toBe(229);
  });

  it('gives the last, short bucket its own measurement rather than dropping it', () => {
    // 25 samples is two whole buckets and half of a third.
    const { peaks } = reducePeaks([samples(25, i => (i >= 20 ? 1 : 0.2))], RATE, STEP);

    expect(peaks.length).toBe(3);
    expect([...peaks]).toEqual([51, 51, 255]);
  });

  it('buckets by the rate it is given, not by the one the file had', () => {
    // The same second of audio at twice the rate is still a hundred buckets of 10 ms.
    const oneSecond = reducePeaks([samples(2000, () => 0.5)], 2000, STEP);

    expect(oneSecond.peaks.length).toBe(100);
  });

  it('rounds the bucket size rather than truncating it', () => {
    // 44 100 Hz at 10 ms is 441 samples exactly; a rate that does not divide evenly must still
    // produce buckets of about the right length instead of drifting.
    const { peaks } = reducePeaks([samples(44_100, () => 0.5)], 44_100, STEP);

    expect(peaks.length).toBe(100);
  });

  it('has nothing to say about an empty or impossible input', () => {
    expect(reducePeaks([], RATE, STEP)).toEqual({ peaks: new Uint8Array(0), max: 0 });
    expect(reducePeaks([new Float32Array(0)], RATE, STEP)).toEqual({ peaks: new Uint8Array(0), max: 0 });
    expect(reducePeaks([samples(10, () => 1)], 0, STEP)).toEqual({ peaks: new Uint8Array(0), max: 0 });
    expect(reducePeaks([samples(10, () => 1)], RATE, 0)).toEqual({ peaks: new Uint8Array(0), max: 0 });
  });
});

/*
 * How often `extractPeaks` reads a source that is not read by range - a `blob:`, a stored file, an
 * iOS clip's `capacitor:` URL - when the streamed pass cannot use it and the whole-file pass is
 * asked. Bytes no demuxer recognises stand in for a video whose audio this WebView cannot decode,
 * and the whole-file decoder is stood in for, because Web Audio is not in the mock DOM.
 */
describe('extractPeaks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function serve(bytes: number): ReturnType<typeof vi.fn> {
    const read = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array(bytes)]) }));
    vi.stubGlobal('fetch', read);
    return read;
  }

  function decodeTo(channel: Float32Array, sampleRate: number): ReturnType<typeof vi.fn> {
    const decode = vi.fn(async () => ({ length: channel.length, numberOfChannels: 1, sampleRate, duration: channel.length / sampleRate, getChannelData: () => channel }));
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = decode;
      },
    );
    return decode;
  }

  /* The size check refused it anyway: the second read was a whole video through the WebView for nothing. */
  it('reads a source too big for the whole-file decoder once, not once per pass', async () => {
    const read = serve(12 * 1024 * 1024 + 1);
    const decode = decodeTo(new Float32Array(10), 1000);

    expect(await extractPeaks('capacitor://localhost/_capacitor_file_/clip.mp4')).toBeNull();

    expect(read).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled();
  });

  it('hands the whole-file decoder the bytes the streamed pass was given, without reading them again', async () => {
    const read = serve(64);
    const decode = decodeTo(new Float32Array(30).fill(0.6), 1000);

    const peaks = await extractPeaks('blob:app/sound', 10);

    expect(read).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(peaks).toMatchObject({ stepMs: 10, durationMs: 30, max: 153 });
    expect([...(peaks?.peaks ?? [])]).toEqual([153, 153, 153]);
  });

  it('answers null for a source that will not read, without trying either pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const decode = decodeTo(new Float32Array(10), 1000);

    expect(await extractPeaks('blob:app/revoked')).toBeNull();
    expect(decode).not.toHaveBeenCalled();
  });
});
