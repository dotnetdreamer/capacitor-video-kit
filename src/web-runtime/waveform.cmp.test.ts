import { afterEach, describe, expect, it } from 'vitest';

import { WAVEFORM_STEP_MS, extractPeaks, streamPeaks } from './waveform';

/*
 * The decode, against a real browser.
 *
 * `waveform.unit.test.ts` covers the measuring; this covers everything the mock DOM cannot have -
 * `OfflineAudioContext`, `decodeAudioData`, and the resampling that is the whole reason the
 * context is built at 8 kHz. Between them, nothing in the file is left unexercised.
 */

const urls: string[] = [];

afterEach(() => {
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
});

/**
 * A tone as a WAV, which `decodeAudioData` reads on every browser. Mono 16-bit, the same shape
 * `render.cmp.test.ts` uses to stand in for a music track.
 *
 * `amplitude` is a fraction of full scale, so what comes back out can be checked against what went
 * in: a peak meter that is right reads 0.6 in as about 153 of 255.
 */
function tone(seconds: number, hz: number, amplitude: number | ((second: number) => number), rate = 48_000): Blob {
  const frames = Math.round(seconds * rate);
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const level = typeof amplitude === 'number' ? amplitude : amplitude(i / rate);
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * level * 32_767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function urlFor(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}

describe('extractPeaks', () => {
  it('measures a file at one byte per step of source, at the level it was written', async () => {
    const peaks = await extractPeaks(urlFor(tone(1, 440, 0.6)));

    expect(peaks).not.toBeNull();
    expect(peaks!.stepMs).toBe(WAVEFORM_STEP_MS);
    expect(peaks!.durationMs).toBeCloseTo(1000, -2);
    // A second at 10 ms a measurement.
    expect(peaks!.peaks.length).toBeGreaterThanOrEqual(99);
    expect(peaks!.peaks.length).toBeLessThanOrEqual(101);
    // 0.6 of full scale is 153 of 255. A little under is the resampler; a lot under is a bug.
    expect(peaks!.max).toBeGreaterThan(140);
    expect(peaks!.max).toBeLessThanOrEqual(165);
  });

  it('follows the shape of the sound rather than flattening it', async () => {
    // The complaint this whole feature answers: a bar that looks the same all the way along.
    // Loud for the first half second, near-silent for the second.
    const peaks = await extractPeaks(urlFor(tone(1, 440, t => (t < 0.5 ? 0.8 : 0.02))));

    expect(peaks).not.toBeNull();
    const half = Math.floor(peaks!.peaks.length / 2);
    const loud = Math.max(...peaks!.peaks.slice(0, half - 2));
    const quiet = Math.max(...peaks!.peaks.slice(half + 2));

    expect(loud).toBeGreaterThan(180);
    expect(quiet).toBeLessThan(30);
  });

  it("resamples to its own rate, so the file's rate does not change how much is measured", async () => {
    // The 8 kHz context is what keeps a five-minute track from being 115 MB of float while it is
    // measured. What must NOT change with it is how many measurements a second of audio makes.
    const at48k = await extractPeaks(urlFor(tone(1, 440, 0.6, 48_000)));
    const at8k = await extractPeaks(urlFor(tone(1, 440, 0.6, 8_000)));

    expect(at48k).not.toBeNull();
    expect(at8k).not.toBeNull();
    expect(Math.abs(at48k!.peaks.length - at8k!.peaks.length)).toBeLessThanOrEqual(2);
    expect(Math.abs(at48k!.durationMs - at8k!.durationMs)).toBeLessThanOrEqual(20);
  });

  it('reports a silent file as measured, with a max of zero', async () => {
    // Which is what draws a hairline rather than nothing, and is the one state that must not be
    // confused with "could not be measured".
    const peaks = await extractPeaks(urlFor(tone(0.5, 440, 0)));

    expect(peaks).not.toBeNull();
    expect(peaks!.max).toBe(0);
    expect(peaks!.peaks.length).toBeGreaterThan(0);
  });

  it('answers null for bytes it cannot decode', async () => {
    const url = urlFor(new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'audio/mpeg' }));

    expect(await extractPeaks(url)).toBeNull();
  });

  it('answers null for an empty file', async () => {
    expect(await extractPeaks(urlFor(new Blob([], { type: 'audio/wav' })))).toBeNull();
  });

  it('answers null for a URL that cannot be read at all', async () => {
    const url = URL.createObjectURL(tone(0.2, 440, 0.5));
    URL.revokeObjectURL(url);

    expect(await extractPeaks(url)).toBeNull();
  });

  it("takes a step of its caller's choosing", async () => {
    const coarse = await extractPeaks(urlFor(tone(1, 440, 0.6)), 100);

    expect(coarse!.stepMs).toBe(100);
    expect(coarse!.peaks.length).toBeGreaterThanOrEqual(9);
    expect(coarse!.peaks.length).toBeLessThanOrEqual(11);
  });
});

describe('streamPeaks', () => {
  /*
   * The path that actually runs, tested on its own.
   *
   * `extractPeaks` falls back to the whole-file decoder when this cannot read a container, so a
   * test that only went through the front door would pass just as happily with the streaming half
   * broken - and the streaming half is the whole reason a video can be measured at all.
   */
  it('measures a file without decoding it whole', async () => {
    const peaks = await streamPeaks(urlFor(tone(1, 440, 0.6)));

    expect(peaks).not.toBeNull();
    expect(peaks!.stepMs).toBe(WAVEFORM_STEP_MS);
    expect(peaks!.peaks.length).toBeGreaterThanOrEqual(95);
    expect(peaks!.peaks.length).toBeLessThanOrEqual(105);
    expect(peaks!.max).toBeGreaterThan(140);
    expect(peaks!.max).toBeLessThanOrEqual(165);
  });

  it('follows the shape of the sound', async () => {
    const peaks = await streamPeaks(urlFor(tone(1, 440, t => (t < 0.5 ? 0.8 : 0.02))));

    expect(peaks).not.toBeNull();
    const half = Math.floor(peaks!.peaks.length / 2);
    expect(Math.max(...peaks!.peaks.slice(0, half - 2))).toBeGreaterThan(180);
    expect(Math.max(...peaks!.peaks.slice(half + 2))).toBeLessThan(30);
  });

  it('answers null for something it cannot demux, so the caller can fall back', async () => {
    const url = urlFor(new Blob([new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])], { type: 'audio/mpeg' }));

    expect(await streamPeaks(url)).toBeNull();
  });
});
