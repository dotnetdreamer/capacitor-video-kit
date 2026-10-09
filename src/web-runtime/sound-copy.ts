/**
 * A sound's own file put through its effect, for the preview to play in the file's place.
 *
 * An `<audio>` element plays a file and nothing else; it cannot be handed a filter. The other way to
 * treat what it plays, Web Audio, is the one the preview keeps sound out of wherever it can
 * (`PreviewMixer`): an element given to the graph can never be taken back, WebKit reads it at real time
 * whatever its rate, and on iOS the graph is ambient sound the ringer silences. So the effect goes into
 * a FILE instead: the sound decoded, run through `SoundEffectRunner` - the arithmetic the web render
 * and both phones run - and written back out as a WAV.
 *
 * The WHOLE file, on its own timeline: the copy is as long as the file and every moment of it is where
 * that moment of the file was. So the preview puts the copy's element at exactly the positions it
 * puts the file's at, and a trim, a loop, a speed or a cut plays from it unchanged - nothing in the
 * player has to tell a copy from a file. A copy of the trimmed stretch alone would be smaller, and
 * would have to be made again for every trim.
 *
 * At the rate the effect needs. A megaphone passes nothing much above 3.5 kHz, so its copy is decoded
 * and written at 22.05 kHz - the lowest rate every WebKit accepts - and in one channel, since it folds
 * them: 44 KB a second, 8 MB for a three-minute song. An effect that keeps the top of the sound is
 * copied at 44.1 kHz.
 *
 * In steps, giving the page back between them, so a long sound does not hold the editor up while it
 * is made: the runner keeps its state from one step to the next, so the steps join as if they were one.
 */
import { SoundEffectRunner } from '../editor/sound-effects';
import type { ComposeSoundEffect } from '../video-composer/definitions';
import { resolve } from './files';
import { decodeAudioData } from './waveform';

/** The rate of a copy that keeps nothing above a fifth of it; see [copyRateFor]. */
const LOW_RATE = 22_050;
/** The rate of every other copy. */
const FULL_RATE = 44_100;

/**
 * Past ten minutes of sound no copy is made, the waveform's own ceiling and for its reason: decoding
 * is all or nothing, and Chromium holds the file decoded at its own rate on the way to this one.
 */
const MAX_SOURCE_MS = 10 * 60 * 1000;

/** The same ceiling in bytes, for a file whose length nobody could read: the waveform's 12 MB. */
const MAX_BYTES_UNMEASURED = 12 * 1024 * 1024;

/** How much sound is put through the effect before the page is given back, in seconds of it. */
const STEP_S = 1;

/**
 * The rate a copy through `effect` is decoded and written at: [LOW_RATE] when what comes out of the
 * effect stops below a fifth of it - its last low-pass after its last drive, which is where the top of
 * the sound is decided, a drive making harmonics over everything before it - and [FULL_RATE] otherwise.
 */
export function copyRateFor(effect: ComposeSoundEffect): number {
  let top = Number.POSITIVE_INFINITY;
  for (let i = effect.ops.length - 1; i >= 0; i--) {
    const op = effect.ops[i]!;
    if (op.op === 'drive') break;
    if (op.op === 'lowpass') top = Math.min(top, op.hz);
  }
  return top <= LOW_RATE / 5 ? LOW_RATE : FULL_RATE;
}

/**
 * `src` through `effect`, as a WAV on the file's own timeline, or null when no copy can be made: a
 * file too long to decode, one this WebView cannot decode, a browser with no Web Audio. The preview
 * then plays the file as it is, and the render has the effect either way.
 */
export async function makeSoundCopy(src: string, effect: ComposeSoundEffect, sourceDurationMs = 0): Promise<Blob | null> {
  if (sourceDurationMs > MAX_SOURCE_MS) return null;
  const rate = copyRateFor(effect);
  const context = audioContext(rate);
  if (!context) return null;
  try {
    const file = await resolve(src);
    if (file.size === 0 || (sourceDurationMs <= 0 && file.size > MAX_BYTES_UNMEASURED)) return null;
    const decoded = await decodeAudioData(context, await file.arrayBuffer());
    if (decoded.length === 0 || decoded.numberOfChannels === 0) return null;
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));

    // The buffer's OWN rate, never the one asked for: a browser that would not resample hands back
    // the file's, and filters designed for another rate would sit in the wrong place.
    const runner = new SoundEffectRunner(effect, decoded.sampleRate);
    const step = Math.max(1, Math.round(decoded.sampleRate * STEP_S));
    for (let from = 0; from < decoded.length; from += step) {
      runner.process(channels, from, Math.min(step, decoded.length - from));
      await pageTurn();
    }
    // A folded sound is the same in every channel, so one is written; anything else keeps two at most.
    return wav(effect.mono ? channels.slice(0, 1) : channels.slice(0, 2), decoded.sampleRate);
  } catch {
    // Every failure is the same answer, as the waveform's are: the file plays as it is.
    return null;
  } finally {
    // Specified on `AudioContext` and not on the offline one, so very likely a no-op; best effort.
    void (context as { close?: () => Promise<void> }).close?.().catch(() => undefined);
  }
}

/** A context to decode in, at `rate` or the first rate above it this browser will build one at. */
function audioContext(rate: number): BaseAudioContext | null {
  const Offline =
    typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Offline) return null;
  for (const each of [rate, FULL_RATE, 48_000]) {
    if (each < rate) continue;
    try {
      return new Offline(1, 1, each);
    } catch {
      // Not at this rate. Try the next one up.
    }
  }
  return null;
}

/** Lets the page paint and take a tap before the next step. */
function pageTurn(): Promise<void> {
  return new Promise(done => setTimeout(done, 0));
}

/** 16-bit PCM in a WAV: the one format every WebView's `<audio>` plays and seeks on the sample. */
export function wav(channels: readonly Float32Array[], rate: number): Blob {
  const n = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytes = new ArrayBuffer(44 + frames * n * 2);
  const head = new DataView(bytes);
  const text = (at: number, value: string): void => {
    for (let i = 0; i < value.length; i++) head.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  head.setUint32(4, 36 + frames * n * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true);
  head.setUint16(22, n, true);
  head.setUint32(24, rate, true);
  head.setUint32(28, rate * n * 2, true);
  head.setUint16(32, n * 2, true);
  head.setUint16(34, 16, true);
  text(36, 'data');
  head.setUint32(40, frames * n * 2, true);
  const samples = new DataView(bytes, 44);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const v = channels[c]![i] ?? 0;
      const held = v > 1 ? 1 : v < -1 ? -1 : v;
      samples.setInt16((i * n + c) * 2, Math.round(held < 0 ? held * 32768 : held * 32767), true);
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
