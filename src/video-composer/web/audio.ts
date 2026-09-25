import { resolve } from '../../web-runtime/files';

import type { MusicItem, PlannedClip, RenderPlan, VoiceItem } from './plan';
import { timeStretch } from './time-stretch';

/**
 * The soundtrack, mixed in one pass over sample arrays.
 *
 * Not a Web Audio graph. `OfflineAudioContext` would render a graph faster than real time and is
 * the obvious tool, but the two things this mix actually needs are the two things a graph makes
 * hard: a speed change that keeps its pitch, which no node does (see `time-stretch.ts`), and a
 * result identical on every machine, which a graph is not obliged to give - resampler quality and
 * node scheduling both vary between browsers. Adding numbers into a `Float32Array` happens to be
 * both simpler and exactly reproducible.
 *
 * What the graph IS used for is decoding: `decodeAudioData` is the browser's own demuxer plus
 * decoder for every audio format it can play, and it resamples to the context's rate on the way
 * out, so everything below is at one rate with one channel count and nothing has to negotiate.
 *
 * The layout mirrors the plan exactly - each clip at its place on the output timeline, each music
 * repetition at its own start with its own fade, each voiceover take at the instant it was recorded
 * against - so the sound and the picture are cut from the same numbers.
 */

/** 48 kHz stereo: the rate AAC encoders are happiest at, and what every phone records. */
export const MIX_SAMPLE_RATE = 48_000;
export const MIX_CHANNELS = 2;

export interface MixedAudio {
  sampleRate: number;
  /**
   * One array per channel, all the same length.
   *
   * Explicitly backed by an `ArrayBuffer` rather than by `ArrayBufferLike`: `copyToChannel` will
   * not take a view that might be over a `SharedArrayBuffer`, and the mix goes straight into one.
   */
  channels: Float32Array<ArrayBuffer>[];
  length: number;
}

/** A decoded source, cached for the life of one render. */
interface DecodedSource {
  channels: Float32Array[];
  sampleRate: number;
}

const EMPTY = new Float32Array(0);

/**
 * Everything audible in the post, or null when there is nothing at all - which is what lets the
 * renderer skip the AAC encoder and the audio track entirely rather than muxing silence.
 */
export async function mixdown(plan: RenderPlan, signal: AbortSignal): Promise<MixedAudio | null> {
  if (!plan.hasAudio) return null;

  const length = Math.max(1, Math.ceil((plan.totalUs / 1_000_000) * MIX_SAMPLE_RATE));
  const channels = Array.from({ length: MIX_CHANNELS }, () => new Float32Array(length));
  const mix: MixedAudio = { sampleRate: MIX_SAMPLE_RATE, channels, length };

  const decoder = new SourceDecoder(sourceUses(plan));
  let anything = false;

  // How long each base clip fades in for: the length of the transition bringing it in, if any.
  // Worked out once, and empty for a post with no transitions, whose clips then take exactly the
  // unfaded path they always did.
  const fadeInUs = new Map<number, number>();
  for (const transition of plan.transitions) fadeInUs.set(transition.index, transition.durUs);

  try {
    // The base track, each clip at the instant the plan put it.
    for (let i = 0; i < plan.clips.length; i++) {
      throwIfAborted(signal);
      const clip = plan.clips[i];
      if (!clip || clip.removeAudio) continue;
      const fadeIn = fadeInUs.get(i);
      anything = (await placeClip(mix, clip, plan.prefixOutUs[i] ?? 0, decoder, fadeIn ? { fadeInUs: fadeIn } : undefined)) || anything;
      decoder.done(clip.clip.uri);
    }

    // ...then every transition's tail: the outgoing clip's sound carrying on UNDER the incoming
    // clip's, across the same window the pictures cross in. Linear both ways, so the two gains sum
    // to one at every sample and a clip dissolving into more of the same scene does not dip or
    // swell at the join. The tail is held to the window, which is the most of it anyone will see.
    for (const transition of plan.transitions) {
      throwIfAborted(signal);
      if (transition.tail.removeAudio) continue;
      anything = (await placeClip(mix, transition.tail, transition.startUs, decoder, { roomUs: transition.durUs, fadeOutWhole: true })) || anything;
      decoder.done(transition.tail.clip.uri);
    }

    // ...then every extra layer's clips, which contribute sound exactly as base clips do.
    for (const track of plan.tracks) {
      for (let i = 0; i < track.clips.length; i++) {
        throwIfAborted(signal);
        const clip = track.clips[i];
        const placement = track.placements[i];
        if (!clip || !placement || clip.removeAudio) continue;
        anything = (await placeClip(mix, clip, placement.startUs, decoder)) || anything;
        decoder.done(clip.clip.uri);
      }
    }

    if (plan.music) {
      const source = await decoder.get(plan.music.uri);
      if (source) {
        for (const item of plan.music.items) {
          throwIfAborted(signal);
          anything = placeMusic(mix, source, item, plan.music.volume) || anything;
        }
      }
      decoder.done(plan.music.uri);
    }

    for (const take of plan.voice) {
      throwIfAborted(signal);
      const source = await decoder.get(take.uri);
      decoder.done(take.uri);
      if (!source) continue;
      anything = placeVoice(mix, source, take) || anything;
    }
  } finally {
    decoder.close();
  }

  if (!anything) return null;

  // One clamp at the end rather than a limiter. Two full-level sources summed do clip, and so do
  // they on both native engines; a limiter here would quietly change the loudness of a post
  // depending on which platform rendered it.
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const value = channel[i] ?? 0;
      if (value > 1) channel[i] = 1;
      else if (value < -1) channel[i] = -1;
    }
  }
  return mix;
}

/* -------------------------------------------------------------------------------------------- */

/**
 * How a clip's sound is shaped on its way into the mix, for the two cases a transition makes. Absent
 * is the plain placement every clip had before transitions existed.
 */
interface ClipFade {
  /** A linear fade in over this much of the start: the incoming side of a transition. */
  fadeInUs?: number;
  /** A linear fade out over the WHOLE placed length: the outgoing side, which is all window. */
  fadeOutWhole?: boolean;
  /** Where the clip must stop on the output timeline, when that is sooner than its own length. */
  roomUs?: number;
}

async function placeClip(mix: MixedAudio, clip: PlannedClip, atUs: number, decoder: SourceDecoder, fade?: ClipFade): Promise<boolean> {
  const source = await decoder.get(clip.clip.uri);
  if (!source) return false;

  const from = samplesAt(clip.inUs, mix.sampleRate);
  const to = samplesAt(clip.outUs, mix.sampleRate);
  // What the clip occupies on the OUTPUT timeline, which the stretch has to land inside: the plan
  // floored that number and the picture is cut to it, so a sample over would be sound with no
  // frames under it.
  const room = samplesAt(Math.min(clip.outDurUs, fade?.roomUs ?? clip.outDurUs), mix.sampleRate);
  if (room <= 0 || to <= from) return false;

  const at = samplesAt(atUs, mix.sampleRate);
  let wrote = false;
  for (let channel = 0; channel < MIX_CHANNELS; channel++) {
    const whole = channelOf(source, channel);
    const input = whole.subarray(Math.min(from, whole.length), Math.min(to, whole.length));
    if (input.length === 0) continue;
    const stretched = timeStretch(input, clip.speed, mix.sampleRate);
    const count = Math.min(room, stretched.length);
    if (fade) {
      // The same arithmetic as a music fade, so a transition's crossfade and a music fade out are
      // the same curve: gain ramps in over `fadeIn` samples and out over `fadeOut` from `fadeOutFrom`.
      // The fade out spans the whole ROOM - the window - and not merely the samples the stretch
      // happened to produce: the incoming clip fades in across exactly that many, and only a ramp of
      // the same length leaves the two gains summing to one at every sample. A tail whose sound runs
      // out before the window closes falls silent there, as any clip whose sound is short does.
      const fadeIn = fade.fadeInUs ? samplesAt(fade.fadeInUs, mix.sampleRate) : 0;
      addFaded(mix.channels[channel], stretched, at, clip.gain, count, fadeIn, fade.fadeOutWhole ? 0 : -1, fade.fadeOutWhole ? room : 0);
    } else {
      addInto(mix.channels[channel], stretched, at, clip.gain, count);
    }
    wrote = true;
  }
  return wrote;
}

function placeMusic(mix: MixedAudio, source: DecodedSource, item: MusicItem, volume: number): boolean {
  const from = samplesAt(item.inUs, mix.sampleRate);
  const to = samplesAt(item.outUs, mix.sampleRate);
  const at = samplesAt(item.atUs, mix.sampleRate);
  const count = Math.min(to - from, mix.length - at);
  if (count <= 0) return false;

  const fadeIn = samplesAt(item.fadeInUs, mix.sampleRate);
  const fadeOutFrom = item.fadeOutStartUs >= 0 ? samplesAt(item.fadeOutStartUs, mix.sampleRate) : -1;
  const fadeOut = samplesAt(item.fadeOutUs, mix.sampleRate);

  for (let channel = 0; channel < MIX_CHANNELS; channel++) {
    const input = channelOf(source, channel);
    const out = mix.channels[channel];
    if (!out) continue;
    for (let i = 0; i < count; i++) {
      const sample = input[from + i];
      if (sample === undefined) break;
      out[at + i] = (out[at + i] ?? 0) + sample * fadeGain(volume, i, fadeIn, fadeOutFrom, fadeOut);
    }
  }
  return true;
}

/**
 * `gain` as a fade leaves it at sample `i` of a placed stream: a linear ramp up over the first
 * `fadeIn` samples, and a linear ramp down over `fadeOut` samples from `fadeOutFrom` (-1 for none).
 * One function for music and for transitions, so the two cannot come to mean different curves - and
 * the multiplications run in the order the music fade always ran them, so its samples are the same
 * bits they were.
 */
function fadeGain(gain: number, i: number, fadeIn: number, fadeOutFrom: number, fadeOut: number): number {
  if (fadeIn > 0 && i < fadeIn) gain *= i / fadeIn;
  if (fadeOutFrom >= 0 && fadeOut > 0 && i >= fadeOutFrom) {
    gain *= Math.max(0, 1 - (i - fadeOutFrom) / fadeOut);
  }
  return gain;
}

/** [addInto] with a fade, for the clips a transition joins. Kept apart so an unfaded clip pays nothing. */
function addFaded(out: Float32Array | undefined, input: Float32Array, at: number, gain: number, count: number, fadeIn: number, fadeOutFrom: number, fadeOut: number): void {
  if (!out) return;
  const room = Math.min(count, input.length, out.length - at);
  for (let i = 0; i < room; i++) out[at + i] = (out[at + i] ?? 0) + (input[i] ?? 0) * fadeGain(gain, i, fadeIn, fadeOutFrom, fadeOut);
}

function placeVoice(mix: MixedAudio, source: DecodedSource, take: VoiceItem): boolean {
  const at = samplesAt(take.atUs, mix.sampleRate);
  const count = Math.min(samplesAt(take.lengthUs, mix.sampleRate), mix.length - at);
  if (count <= 0) return false;
  for (let channel = 0; channel < MIX_CHANNELS; channel++) {
    addInto(mix.channels[channel], channelOf(source, channel), at, take.level, count);
  }
  return true;
}

function addInto(out: Float32Array | undefined, input: Float32Array, at: number, gain: number, count: number): void {
  if (!out) return;
  const room = Math.min(count, input.length, out.length - at);
  for (let i = 0; i < room; i++) out[at + i] = (out[at + i] ?? 0) + (input[i] ?? 0) * gain;
}

/**
 * One channel of a source, spread to stereo where the file is mono.
 *
 * A mono recording - which is what every phone's microphone produces, so every voiceover - has to
 * come out of both speakers rather than only the left one, and duplicating the single channel is
 * what the native mixers do with it.
 */
function channelOf(source: DecodedSource, channel: number): Float32Array {
  return source.channels[Math.min(channel, source.channels.length - 1)] ?? EMPTY;
}

function samplesAt(microseconds: number, sampleRate: number): number {
  return Math.round((microseconds / 1_000_000) * sampleRate);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
}

/* -------------------------------------------------------------------------------------------- */

/**
 * How many times [mixdown] will ask [SourceDecoder] for each source, counted with exactly the skip
 * rules its loops use: a base clip, a transition's tail and an extra layer's clip unless its audio
 * was removed (and, for a layer, only with a placement), the music once, and every voiceover take.
 * A change to which placements those loops ask for has to be made here too. Counting one too few
 * would only decode that file a second time, into the same samples; one too many keeps it until the
 * mix is done, which is what every source did before the count existed.
 *
 * Exported for the unit tests, which pin it against the loops it has to match.
 */
export function sourceUses(plan: RenderPlan): Map<string, number> {
  const uses = new Map<string, number>();
  const use = (uri: string): void => void uses.set(uri, (uses.get(uri) ?? 0) + 1);
  for (const clip of plan.clips) if (clip && !clip.removeAudio) use(clip.clip.uri);
  for (const transition of plan.transitions) if (!transition.tail.removeAudio) use(transition.tail.clip.uri);
  for (const track of plan.tracks) {
    track.clips.forEach((clip, i) => {
      if (clip && track.placements[i] && !clip.removeAudio) use(clip.clip.uri);
    });
  }
  if (plan.music) use(plan.music.uri);
  for (const take of plan.voice) use(take.uri);
  return uses;
}

/**
 * Decodes each source once, and remembers it until its last placement.
 *
 * A clip split into six segments is six entries in the plan and one file, and decoding it six times
 * would be six full decodes of a minute of audio. A source that will not decode is remembered as a
 * miss so it is not tried again either - which is the normal case for a video with no audio track.
 *
 * Remembered only until [done] has been called once for every ask [sourceUses] counted, and then let
 * go. Every placement copies what it needs into the mix and keeps nothing, so a source past its last
 * placement is about 23 MB a minute of stereo holding nothing up; holding every one to the end made
 * the peak the sum of every distinct file in the post rather than the few in use at once. When a
 * source is let go changes nothing about what is mixed, or in which order.
 */
class SourceDecoder {
  private readonly cache = new Map<string, DecodedSource | null>();
  private context: BaseAudioContext | null = null;

  constructor(private readonly uses: Map<string, number>) {}

  async get(uri: string): Promise<DecodedSource | null> {
    const cached = this.cache.get(uri);
    if (cached !== undefined) return cached;
    const decoded = await this.decode(uri);
    this.cache.set(uri, decoded);
    return decoded;
  }

  /**
   * One counted ask for `uri` has been placed. The last lets go of the source, a miss included, so
   * nothing asks for it again to find it missing. A uri that was never counted is kept, as before.
   */
  done(uri: string): void {
    const left = this.uses.get(uri);
    if (left === undefined) return;
    if (left > 1) {
      this.uses.set(uri, left - 1);
      return;
    }
    this.uses.delete(uri);
    this.cache.delete(uri);
  }

  close(): void {
    this.context = null;
    this.cache.clear();
  }

  private async decode(uri: string): Promise<DecodedSource | null> {
    const context = this.audioContext();
    if (!context) return null;
    let bytes: ArrayBuffer;
    try {
      bytes = await (await resolve(uri)).arrayBuffer();
    } catch {
      // The picture is already handled by the video decoder's own failure; a file that cannot be
      // read for its sound simply contributes none.
      return null;
    }
    let buffer: AudioBuffer;
    try {
      buffer = await decodeAudioData(context, bytes);
    } catch {
      // A video with no audio track lands here on every browser, and it is not an error.
      return null;
    }

    const channels: Float32Array[] = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    if (channels.length === 0) return null;
    // Belt and braces: every browser resamples to the context's rate on decode, and one that did
    // not would put the whole post out of time rather than one clip out of tune.
    if (buffer.sampleRate !== MIX_SAMPLE_RATE) {
      return {
        sampleRate: MIX_SAMPLE_RATE,
        channels: channels.map(channel => resampleLinear(channel, buffer.sampleRate, MIX_SAMPLE_RATE)),
      };
    }
    return { sampleRate: buffer.sampleRate, channels };
  }

  private audioContext(): BaseAudioContext | null {
    if (this.context) return this.context;
    const Offline =
      typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!Offline) return null;
    try {
      // One frame long: nothing is ever rendered through it, it is here only because
      // `decodeAudioData` is a method of a context and because its rate is what decoding resamples
      // to. An offline context needs no audio device and no user gesture, which an `AudioContext`
      // on iOS very much does.
      this.context = new Offline(MIX_CHANNELS, 1, MIX_SAMPLE_RATE);
      return this.context;
    } catch {
      return null;
    }
  }
}

/** `decodeAudioData` in both of its shapes: the promise, and the callback pair Safari once had. */
function decodeAudioData(context: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolveWith, reject) => {
    let settled = false;
    const ok = (buffer: AudioBuffer): void => {
      if (settled) return;
      settled = true;
      resolveWith(buffer);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error('could not decode the audio'));
    };
    try {
      const maybe = context.decodeAudioData(bytes, ok, fail);
      if (maybe && typeof maybe.then === 'function') void maybe.then(ok, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const at = i * ratio;
    const index = Math.floor(at);
    const frac = at - index;
    const a = input[Math.min(index, input.length - 1)] ?? 0;
    const b = input[Math.min(index + 1, input.length - 1)] ?? 0;
    output[i] = a + (b - a) * frac;
  }
  return output;
}
