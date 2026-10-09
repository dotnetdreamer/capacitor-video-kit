import { afterEach, describe, expect, it } from 'vitest';

import { SoundEffectRunner, emptyManifest, soundEffectPreset, type EditManifest } from '../editor';
import { resolveEditorHost } from '../host/defaults';
import { EditorMedia } from '../state/editor-media';
import { EditorStore } from '../state/editor-store';
import { soundCopyKey } from '../state/editor.types';

import { copyRateFor, makeSoundCopy } from './sound-copy';

/*
 * The preview's copy of a sound through its effect, against a real browser: `decodeAudioData`, the
 * resampling to the copy's rate, the WAV an `<audio>` element plays, and `EditorMedia` making one for
 * a sound the post puts through an effect. The arithmetic itself is `sound-effects.unit.test.ts`'s.
 */

const megaphone = soundEffectPreset('megaphone')!.effect;
const urls: string[] = [];
const stores: EditorStore[] = [];

afterEach(() => {
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  for (const store of stores.splice(0)) store.dispose();
});

/** A tone as a mono 16-bit WAV, sounding only between `from` and `to` seconds when they are given. */
function tone(seconds: number, hz: number, amplitude: number, from = 0, to = seconds, rate = 48_000): Blob {
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
    const t = i / rate;
    const level = t >= from && t < to ? amplitude : 0;
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * level * 32_767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function urlFor(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}

async function decode(blob: Blob, rate: number): Promise<AudioBuffer> {
  return new OfflineAudioContext(1, 1, rate).decodeAudioData(await blob.arrayBuffer());
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
}

describe('makeSoundCopy', () => {
  it('copies the whole file on its own timeline, at the rate the effect needs and in one channel for a fold', async () => {
    expect(copyRateFor(megaphone)).toBe(22_050);
    const copy = await makeSoundCopy(urlFor(tone(2, 440, 0.5)), megaphone, 2000);
    expect(copy?.type).toBe('audio/wav');
    const read = await decode(copy!, 22_050);
    expect(read.numberOfChannels).toBe(1);
    expect(read.sampleRate).toBe(22_050);
    expect(Math.abs(read.duration - 2)).toBeLessThan(0.001);
  });

  it('is the very arithmetic the render runs, on the sound decoded at the copy’s rate', async () => {
    const source = tone(1, 700, 0.6);
    const copy = await decode((await makeSoundCopy(urlFor(source), megaphone, 1000))!, 22_050);
    const expected = (await decode(source, 22_050)).getChannelData(0).slice();
    new SoundEffectRunner(megaphone, 22_050).process([expected]);
    const got = copy.getChannelData(0);
    let worst = 0;
    for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs((expected[i] ?? 0) - (got[i] ?? 0)));
    // Within the 16-bit the WAV is written in.
    expect(worst).toBeLessThan(2 / 32_768);
  });

  it('puts every moment where it was in the file', async () => {
    // A tone between 1.0 s and 1.2 s of a two-second file: in the copy, there and nowhere else.
    const copy = await decode((await makeSoundCopy(urlFor(tone(2, 1000, 0.5, 1, 1.2)), megaphone, 2000))!, 22_050);
    const samples = copy.getChannelData(0);
    const at = (s: number) => Math.round(s * 22_050);
    expect(rms(samples, at(1.02), at(1.18))).toBeGreaterThan(0.05);
    expect(rms(samples, 0, at(0.95))).toBe(0);
    expect(rms(samples, at(1.3), samples.length)).toBeLessThan(0.001);
  });

  it('takes a hum away, as a megaphone does', async () => {
    const hum = tone(1, 150, 0.5);
    const copy = await decode((await makeSoundCopy(urlFor(hum), megaphone, 1000))!, 22_050);
    const dry = await decode(hum, 22_050);
    expect(rms(copy.getChannelData(0), 2205)).toBeLessThan(rms(dry.getChannelData(0), 2205) * 0.1);
  });

  it('is a file an audio element plays and knows the length of', async () => {
    const copy = await makeSoundCopy(urlFor(tone(1.5, 440, 0.5)), megaphone, 1500);
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.src = urlFor(copy!);
    await new Promise<void>((done, fail) => {
      audio.addEventListener('loadedmetadata', () => done(), { once: true });
      audio.addEventListener('error', () => fail(new Error('the copy did not load')), { once: true });
    });
    expect(Math.abs(audio.duration - 1.5)).toBeLessThan(0.01);
  });

  /*
   * A sound whose speed is a record's plays its copy at that speed with the pitch let go, which takes
   * every frequency in it down by the speed - a corner of the effect's included. The copy is worked
   * out for the rate it is heard at, so the corner lands where the render, which treats the sound
   * after slowing it, puts it: a 1 kHz low-pass for half speed is a 2 kHz one in the copy, which half
   * speed brings down to 1 kHz. A 1600 Hz tone, slowed to 800 Hz, comes through it as the render lets
   * it through - where the same low-pass at the file's own rate all but takes it away.
   */
  it('works the effect out at the rate the copy is heard at', async () => {
    const lowpass = { ops: [1, 2, 3, 4].map(() => ({ op: 'lowpass' as const, hz: 1000, q: Math.SQRT1_2 })) };
    const source = tone(1, 1600, 0.5);
    const asIs = await decode((await makeSoundCopy(urlFor(source), lowpass, 1000))!, 44_100);
    const halved = await decode((await makeSoundCopy(urlFor(source), lowpass, 1000, 0.5))!, 44_100);
    // Four Butterworths: 0.84 each at 0.8 of their corner, 0.36 each at 1.6 of it.
    const level = (copy: AudioBuffer) => rms(copy.getChannelData(0), 4410);
    expect(level(halved) / (0.5 * Math.SQRT1_2)).toBeCloseTo(0.84 ** 4, 1);
    expect(level(asIs)).toBeLessThan(level(halved) * 0.1);
  });

  it('makes no copy of a sound too long to decode, or of a file that is not sound', async () => {
    expect(await makeSoundCopy(urlFor(tone(0.5, 440, 0.5)), megaphone, 11 * 60 * 1000)).toBeNull();
    expect(await makeSoundCopy(urlFor(new Blob(['not sound'], { type: 'audio/wav' })), megaphone, 1000)).toBeNull();
  });
});

describe('the copies EditorMedia makes', () => {
  /** A post whose one lane holds `uri`, through the megaphone. */
  function post(uri: string): EditManifest {
    return {
      ...emptyManifest(),
      clips: [{ id: 'seg-0', clipKey: 'clip-a', inMs: 0, outMs: 5000, speed: 1, volume: 1, muted: false }],
      audioTracks: [
        {
          id: 'lane',
          clips: [{ id: 'line', uri, fileName: 'line.wav', sourceDurationMs: 1000, inMs: 0, outMs: 0, startMs: 0, endMs: 0, volume: 1, loop: false, fadeOutMs: 0, effect: 'megaphone' }],
        },
      ],
    };
  }

  async function until(what: string, ready: () => boolean, ms = 5000): Promise<void> {
    const deadline = performance.now() + ms;
    while (!ready()) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  it('makes one for a sound the post puts through an effect, and lets it go with the editor', async () => {
    const uri = urlFor(tone(1, 440, 0.5));
    const host = resolveEditorHost({});
    const store = new EditorStore(host);
    stores.push(store);
    const media = new EditorMedia(store, host);
    store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 5000]]), post(uri));

    const key = soundCopyKey({ uri, effect: 'megaphone' })!;
    await until('the copy', () => typeof store.soundCopies.value.get(key) === 'string');
    const copy = store.soundCopies.value.get(key)!;
    expect(copy.startsWith('blob:')).toBe(true);
    expect((await fetch(copy)).headers.get('content-type')).toBe('audio/wav');

    media.dispose();
    expect(store.soundCopies.value.size).toBe(0);
    await expect(fetch(copy)).rejects.toThrow();
  });
});
