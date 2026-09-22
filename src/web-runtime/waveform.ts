/**
 * Peak amplitudes for an audio file, which is what lets the timeline draw a sound instead of a
 * coloured rectangle.
 *
 * Neutral ground for the same reason `web-runtime/sounds.ts` is: the editor's timeline wants this
 * and the editor half may not reach into the plugin half. `video-composer/web/audio.ts` already
 * decodes audio and is deliberately NOT reused - its `SourceDecoder` is module-private, and it
 * resamples every source to 48 kHz stereo because a mix has to be sample-accurate. A picture of a
 * sound has the opposite requirement, and that difference is the whole memory argument below.
 *
 * What comes out is one byte per [WAVEFORM_STEP_MS] of SOURCE time: the loudest sample in that
 * slice, 0..255 of full scale. Source time, not output time, is what makes it survive every edit -
 * trimming, moving and looping a track all change where the sound is heard without changing the
 * sound, so the picture is measured once and read differently.
 */
import { resolve } from './files';

/**
 * One peak per 10 ms.
 *
 * Set by the zoom the timeline can actually reach rather than by taste. A waveform bar is 3 px of
 * pitch and `MAX_PPS` is 320, so the narrowest slice of time a bar can ever cover is 3/320 s =
 * 9.4 ms. At 10 ms there is about one measurement per bar at full zoom - finer would be measuring
 * detail no screen can show, coarser would go visibly blocky exactly where a customer has zoomed
 * in to look.
 *
 * It costs 100 bytes per second of audio, so a ten-minute track is 60 KB. Cheap enough that
 * nothing here needs an eviction policy: every track a customer auditions can simply be kept, and
 * an undo that brings a removed sound back finds its picture still there.
 */
export const WAVEFORM_STEP_MS = 10;

/**
 * Decode at 8 kHz rather than at the file's own rate.
 *
 * `decodeAudioData` resamples to the rate of the context it is called on, and that one fact is
 * what makes this affordable on a phone. Decoding a 5-minute track at 48 kHz stereo float is
 * ~115 MB of `Float32Array` held at once, on a device that is also holding the preview's video
 * decoders; at 8 kHz it is ~19 MB. Nothing is lost that this can see - 80 samples still go into
 * every 10 ms bucket and only their maximum is kept.
 *
 * The fallbacks exist because the minimum rate a browser must accept is not agreed on. Chromium
 * takes 3000 and up, so Android's WebView takes 8000; older Safari refused anything under 22050.
 * The first rate that constructs wins, and the decoded buffer's OWN rate is what the maths uses.
 */
const DECODE_RATES = [8000, 16000, 22050, 44100];

/**
 * Past ten minutes of audio, no picture is drawn at all.
 *
 * There is no cap on what `pickAudio` may hand back - a customer can choose a two-hour DJ set -
 * and decoding is all-or-nothing: `decodeAudioData` holds the entire decoded result before a
 * single measurement can be taken. At the 8 kHz this asks for, ten minutes is about 38 MB of
 * float, which a phone survives next to the preview's own decoders.
 *
 * The number has to be read against what decoding really costs, not against the file. Chromium
 * decodes at the FILE's rate and resamples afterwards, so a ten-minute 48 kHz stereo track passes
 * through ~230 MB on the way to those 38 MB. That transient is the real ceiling, and it is why
 * this is minutes of audio rather than the generous byte cap that stood here before: 60 MB of MP3
 * is a 50-minute track, which is over a gigabyte of transient and would simply kill the WebView.
 */
const MAX_SOURCE_MS = 10 * 60 * 1000;

/**
 * The same ceiling in bytes, for a file whose length nobody could read.
 *
 * `EditMusic.sourceDurationMs` is documented as 0 when the length could not be measured - the
 * exact case a guard is wanted for - so the byte length is the fallback question. 12 MB is about
 * twelve minutes of 128 kbps MP3, which puts it in the same place as [MAX_SOURCE_MS] for ordinary
 * files without having to guess at a bitrate.
 */
const MAX_BYTES = 12 * 1024 * 1024;

/** One byte per [Peaks.stepMs] of source, plus what is needed to read them. */
export interface Peaks {
  stepMs: number;
  /** 0..255 of full scale. Index `i` is the loudest sample in `[i*stepMs, (i+1)*stepMs)`. */
  peaks: Uint8Array;
  /** How much of the track was measured. Source milliseconds past this were never sampled. */
  durationMs: number;
  /**
   * The loudest bucket in the whole track.
   *
   * Kept so the drawing can normalise without a second pass, and so that "measured, and it is
   * silence" (`max === 0`) stays distinguishable from "not measured yet" (no record at all).
   */
  max: number;
}

/**
 * The loudest sample in each slice of the decoded audio.
 *
 * Separate from the decoding, and exported, because this is the half worth testing: it is pure
 * arithmetic over arrays, and Web Audio exists in neither the mock DOM the unit tests run in nor
 * in a server render.
 *
 * Channels are collapsed by taking the louder of them rather than by averaging. A stereo track
 * with a hard-panned part would otherwise draw that part at half height, which reads as the file
 * being quiet rather than as it being wide.
 */
export function reducePeaks(channels: readonly Float32Array[], sampleRate: number, stepMs: number): { peaks: Uint8Array; max: number } {
  const frames = channels[0]?.length ?? 0;
  if (frames === 0 || sampleRate <= 0 || stepMs <= 0) return { peaks: new Uint8Array(0), max: 0 };

  const perBucket = Math.max(1, Math.round((sampleRate * stepMs) / 1000));
  const buckets = Math.ceil(frames / perBucket);
  const peaks = new Uint8Array(buckets);
  let max = 0;

  for (let b = 0; b < buckets; b++) {
    const from = b * perBucket;
    const to = Math.min(frames, from + perBucket);
    let loudest = 0;
    for (const samples of channels) {
      for (let i = from; i < to; i++) {
        // `Math.abs` rather than a squared sum: this is a peak meter, not a loudness meter, and a
        // single transient is exactly what a customer looks for when lining a cut up to a beat.
        const value = samples[i] < 0 ? -samples[i] : samples[i];
        if (value > loudest) loudest = value;
      }
    }
    // Clamped because float PCM is not obliged to stay inside -1..1: a decoder handed a clipped
    // MP3 can and does return samples past full scale.
    const byte = Math.min(255, Math.round(loudest * 255));
    peaks[b] = byte;
    if (byte > max) max = byte;
  }

  return { peaks, max };
}

/**
 * Measures the audio at `src`, or null when there is nothing to draw.
 *
 * Null is every failure, and they are deliberately not told apart: a file too big to decode, a
 * codec this WebView has no decoder for, a browser with no Web Audio at all and a `blob:` URL
 * revoked while it was being read all end in the same place, which is a bar that keeps the colour
 * it has today. The sound itself is unaffected - the preview plays it through its own `<audio>`
 * and the render mixes it through its own decoder - so nothing here is ever worth telling the
 * customer about.
 */
export async function extractPeaks(src: string, stepMs: number = WAVEFORM_STEP_MS, sourceDurationMs = 0): Promise<Peaks | null> {
  /*
   * Streamed first, and whole-file only when that cannot read the container.
   *
   * The streamed pass is the only one a VIDEO can afford. A minute of 1080p is tens of megabytes
   * of which the audio is a rounding error, and `decodeAudioData` has no way to be told that: it
   * takes the whole file and hands back the whole decoded track. Demuxing instead reads only the
   * audio track's own byte ranges, decodes it a chunk at a time, and keeps nothing but the
   * measurements - so the memory it uses is the same for a ten-second clip and a ten-minute one.
   */
  const streamed = await streamPeaks(src, stepMs);
  if (streamed) return streamed;

  // Asked before anything is read, so a track too long to decode is never even downloaded.
  if (sourceDurationMs > MAX_SOURCE_MS) return null;

  const context = audioContext();
  if (!context) return null;

  try {
    const blob = await resolve(src);
    if (blob.size === 0 || blob.size > MAX_BYTES) return null;

    /*
     * Handed straight in, not copied. A successful decode DETACHES this buffer, which would matter
     * to anything wanting a second attempt - but nothing here retries, and at these sizes a copy
     * is the difference between one and two of the largest allocation in the function, both alive
     * at once for as long as the decode runs.
     */
    const decoded = await decodeAudioData(context, await blob.arrayBuffer());
    if (decoded.length === 0 || decoded.numberOfChannels === 0) return null;

    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));

    // The buffer's OWN rate, never the rate the context was asked for: a browser that declined to
    // resample hands back the file's, and bucketing at the wrong rate would stretch the picture.
    const { peaks, max } = reducePeaks(channels, decoded.sampleRate, stepMs);
    return { stepMs, peaks, durationMs: Math.round(decoded.duration * 1000), max };
  } catch {
    /*
     * Silent here, and said by the caller instead.
     *
     * Nothing in `web-runtime/` may reach into `src/host/`: the two are separate builds, and one
     * import of `host/debug` was enough to pull that module into the PUBLISHED plugin bundle -
     * where it would be a second copy with its own flag that `setEditorDebug` never reaches.
     */
    return null;
  } finally {
    /*
     * `close` is specified on `AudioContext` and not on the offline one, so on today's browsers
     * this is very likely a no-op that optional chaining skips - which is why it is written as a
     * best effort rather than relied on. The context is dropped on the next line either way, and
     * decodes are serialised, so at most one is ever waiting to be collected.
     *
     * It runs after the decode, not during it: the `await` above suspends inside the `try`, so
     * everything here happens once the samples have already been read.
     */
    void (context as { close?: () => Promise<void> }).close?.().catch(() => undefined);
  }
}

/**
 * Peaks read straight off the file's audio track, without ever holding the file.
 *
 * Three things make this cheap enough to run on a video, and all three matter:
 *
 * - only the AUDIO track is touched. The demuxer seeks to its packets and steps over the video
 *   entirely, which for a phone recording is well over 99% of the bytes never read at all;
 * - an `http(s)` source is read by RANGE, so nothing is downloaded up front. That is the shape
 *   every clip has on a phone, where the file is served over Capacitor's own local server;
 * - the decoded audio is folded into measurements a chunk at a time and each chunk is then
 *   dropped, so what is held is one chunk plus a byte per 10 ms - about 100 bytes a second,
 *   whatever the length or the resolution of what it came out of.
 *
 * Null means "could not read this", never "no sound here": a file with no audio track, a codec
 * this device cannot decode, or a browser with no WebCodecs at all. The caller then decides
 * whether to try the whole-file decoder instead.
 *
 * Exported on its own, like [reducePeaks], because it is the path that actually runs: a test
 * that only called [extractPeaks] would still pass with this silently falling back to the
 * whole-file decoder, and would be saying nothing about the half that matters.
 *
 * The import is dynamic so the demuxer stays out of the editor's own bundle - the timeline asks
 * for it the first time a sound needs measuring, and never on a post that has none.
 */
export async function streamPeaks(src: string, stepMs: number = WAVEFORM_STEP_MS): Promise<Peaks | null> {
  let input: { dispose?: () => void } | null = null;
  try {
    const { ALL_FORMATS, AudioBufferSink, BlobSource, Input, UrlSource } = await import('mediabunny');

    // A URL is read in ranges; anything else is resolved to a blob first, which is already backed
    // by the file on disk and is sliced rather than copied.
    const source = /^https?:/i.test(src) ? new UrlSource(src) : new BlobSource(await resolve(src));
    const reader = new Input({ source, formats: ALL_FORMATS });
    input = reader;

    const track = await reader.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;

    const peaks: number[] = [];
    let max = 0;
    let endMs = 0;

    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      const rate = buffer.sampleRate;
      const frames = buffer.length;
      if (rate <= 0 || frames === 0 || buffer.numberOfChannels === 0) continue;

      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

      // Bucketed against the chunk's own place on the timeline, so a gap or a re-ordered packet
      // lands where it belongs rather than wherever the running count had got to.
      const baseMs = timestamp * 1000;
      for (let i = 0; i < frames; ) {
        const bucket = Math.floor((baseMs + (i / rate) * 1000) / stepMs);
        const boundary = Math.ceil((((bucket + 1) * stepMs - baseMs) / 1000) * rate);
        const end = Math.min(frames, Math.max(i + 1, boundary));

        let loudest = 0;
        for (const samples of channels) {
          for (let j = i; j < end; j++) {
            const value = samples[j] < 0 ? -samples[j] : samples[j];
            if (value > loudest) loudest = value;
          }
        }
        const byte = Math.min(255, Math.round(loudest * 255));
        if (bucket >= 0 && byte > (peaks[bucket] ?? 0)) peaks[bucket] = byte;
        if (byte > max) max = byte;
        i = end;
      }
      endMs = Math.max(endMs, baseMs + (frames / rate) * 1000);
    }

    if (peaks.length === 0) return null;
    // Built through an index rather than from the array, because a chunk that skipped a bucket
    // leaves a hole in it and a hole is silence, not `undefined`.
    return { stepMs, peaks: Uint8Array.from({ length: peaks.length }, (_, i) => peaks[i] ?? 0), durationMs: Math.round(endMs), max };
  } catch {
    // Unreadable container, no WebCodecs, no audio track: all the same answer to the caller.
    return null;
  } finally {
    try {
      input?.dispose?.();
    } catch {
      // Disposing a reader that never opened has nothing to undo.
    }
  }
}

/**
 * An offline context, at the lowest rate this browser will build one at.
 *
 * Offline rather than a plain `AudioContext` for the reason `video-composer/web/audio.ts` gives:
 * it needs no audio device and no user gesture. That matters more here than it does there, because
 * a waveform is measured when the MANIFEST changes - reopening a draft, or an undo - and not from
 * a tap, so a context that waits to be resumed would simply never decode.
 */
function audioContext(): BaseAudioContext | null {
  const Offline =
    typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Offline) return null;
  for (const rate of DECODE_RATES) {
    try {
      return new Offline(1, 1, rate);
    } catch {
      // This browser will not build a context at that rate. Try the next one up.
    }
  }
  return null;
}

/** `decodeAudioData` in both of its shapes: the promise, and the callback pair Safari once had. */
function decodeAudioData(context: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((ok, fail) => {
    const reject = (error: unknown) => fail(error instanceof Error ? error : new Error('could not decode audio'));
    let maybe: Promise<AudioBuffer> | undefined;
    try {
      maybe = context.decodeAudioData(bytes, ok, reject);
    } catch (error) {
      reject(error);
      return;
    }
    if (maybe && typeof maybe.then === 'function') maybe.then(ok, reject);
  });
}
