import { resolve } from '../../web-runtime/files';

import { musicForSource, type MusicItem, type MusicPlan, type PlannedClip, type RenderPlan, type VoiceItem } from './plan';
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
 * repetition at its own start under the one pair of fades the music's whole window has, each
 * voiceover take at the instant it was recorded against - so the sound and the picture are cut from
 * the same numbers.
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
  /**
   * How long the file's container says its sound runs, in µs, for a file [SourceDecoder] was told
   * to measure (the music's) and whose container says; see [soundLengthUs].
   */
  presentedUs?: number | null;
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

  const musicPlans = [...(plan.music ? [plan.music] : []), ...plan.musicTracks];
  const decoder = new SourceDecoder(
    sourceUses(plan),
    musicPlans.map(music => music.uri),
  );
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

    for (const planned of musicPlans) {
      throwIfAborted(signal);
      const source = await decoder.get(planned.uri);
      // Laid again against the file's own length, which the web reads for itself: a spec asks for
      // "the end of the file" when the sound is not trimmed at its end. See [soundLengthUs].
      const music = source ? musicForSource(planned, soundLengthUs(source)) : null;
      if (source && music) {
        for (let i = 0; i < music.items.length; i++) {
          throwIfAborted(signal);
          const item = music.items[i];
          if (item) anything = placeMusic(mix, source, item, music, music.items[i + 1]) || anything;
        }
      }
      decoder.done(planned.uri);
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

/**
 * One repetition of the music into the mix, under the fades of the music's whole window rather than
 * any of its own: the ramps are counted from where the music starts on the output timeline, so the
 * fade in runs on across a seam when it is longer than the first pass, and the fade out starts in
 * whichever pass it has to - an earlier one, when the last is shorter than the fade - to reach
 * silence exactly where the music stops ([MusicPlan]).
 *
 * A repetition of music played at another speed is stretched first, at its own pitch, and laid at the
 * length the plan gave it on the output; see [stretchedPass] for what `next` is for.
 */
function placeMusic(mix: MixedAudio, source: DecodedSource, item: MusicItem, music: MusicPlan, next?: MusicItem): boolean {
  const from = samplesAt(item.inUs, mix.sampleRate);
  const to = samplesAt(item.outUs, mix.sampleRate);
  const at = samplesAt(item.atUs, mix.sampleRate);
  const speed = music.speed ?? 1;
  const sped = speed !== 1 && item.lengthUs !== undefined;
  const count = Math.min(sped ? samplesAt(item.lengthUs ?? 0, mix.sampleRate) : to - from, mix.length - at);
  if (count <= 0) return false;

  // Where this repetition's first sample falls in the window, and the fades in the window's terms.
  // The fade out's start is before the window's own when the fade is longer than the music.
  const start = samplesAt(music.startUs, mix.sampleRate);
  const into = at - start;
  const fadeIn = samplesAt(music.fadeInUs, mix.sampleRate);
  const fadeOut = samplesAt(music.fadeOutUs, mix.sampleRate);
  const fadeOutFrom = samplesAt(music.stopUs, mix.sampleRate) - start - fadeOut;

  // A mono file is both channels; it is stretched once, not once for each.
  const stretched = new Map<Float32Array, Float32Array>();
  for (let channel = 0; channel < MIX_CHANNELS; channel++) {
    const whole = channelOf(source, channel);
    const out = mix.channels[channel];
    if (!out) continue;
    let input = whole;
    let offset = from;
    if (sped) {
      input = stretched.get(whole) ?? stretchedPass(whole, from, to, next, speed, mix.sampleRate);
      stretched.set(whole, input);
      offset = 0;
    }
    for (let i = 0; i < count; i++) {
      const sample = input[offset + i];
      if (sample === undefined) break;
      out[at + i] = (out[at + i] ?? 0) + sample * fadeGain(music.volume, into + i, fadeIn, fadeOutFrom, fadeOut);
    }
  }
  return true;
}

/** How much of what follows a sped-up repetition is stretched along with it, in seconds of the file. */
const STRETCH_RUN_ON_S = 0.1;

/**
 * One repetition of sped-up music, `from..to` of the file, stretched to its speed at its own pitch.
 *
 * Stretched with a little of what FOLLOWS it in the post - the start of the next repetition, or the
 * file running on past `to` when this is the last - and then cut at its length by the caller. The
 * stretch works a frame at a time and runs out of input a frame or so short of the end of what it is
 * given, which on a loop would be a gap of silence at every seam; with the next pass's first moments
 * behind it, it reaches its length, and its last frames blend into the very sound that comes next.
 */
function stretchedPass(whole: Float32Array, from: number, to: number, next: MusicItem | undefined, speed: number, sampleRate: number): Float32Array {
  const own = whole.subarray(Math.min(from, whole.length), Math.min(to, whole.length));
  const followFrom = next ? samplesAt(next.inUs, sampleRate) : to;
  const runOn = Math.round(STRETCH_RUN_ON_S * sampleRate);
  const follow = whole.subarray(Math.min(followFrom, whole.length), Math.min(followFrom + runOn, whole.length));
  const input = new Float32Array(own.length + follow.length);
  input.set(own);
  input.set(follow, own.length);
  return timeStretch(input, speed, sampleRate);
}

/**
 * `gain` as a fade leaves it at sample `i` of a placed stream: a linear ramp up over the first
 * `fadeIn` samples, and a linear ramp down over `fadeOut` samples from `fadeOutFrom`, which may be
 * negative for a ramp that began before the stream did (a `fadeOut` of 0 is none). One function for
 * music and for transitions, so the two cannot come to mean different curves, and the product of
 * the two where they overlap, as the preview's `musicFadeAt` and both native engines have it.
 */
function fadeGain(gain: number, i: number, fadeIn: number, fadeOutFrom: number, fadeOut: number): number {
  if (fadeIn > 0 && i < fadeIn) gain *= i / fadeIn;
  if (fadeOut > 0 && i >= fadeOutFrom) {
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

/**
 * How long a decoded sound runs, in µs, for a pass that goes to the end of its file: what was decoded,
 * held to the length its container presents where that is shorter.
 *
 * WHY NOT THE DECODE ALONE. An AAC `.m4a` holds whole frames of 1024 samples, and the encoder puts a
 * frame's worth of priming before the sound and pads the last frame out; the container's edit list
 * says which stretch of those samples is the sound. `qa-sample.m4a`, the seeded 12 s tone, is 518
 * frames - 12.028 s of samples - presented as 12.000 s (priming 1024, then 529200 samples at 44.1
 * kHz). Measured on 2026-09-29 on a local page, Chromium 153 decodes it to exactly 576000 samples at
 * 48 kHz, 12.000 s; WebKit 26.6 trims the priming as well - the tone starts on the same sample in both
 * - but keeps the padding, and decodes it to 576226, 12.0047 s. Looped at that, every pass on WebKit
 * ended in 4.7 ms of silence and came round that much later at every seam, where iOS's render (the
 * audio track's end), Android's and Chromium's loop at 12.000 s, and so does the preview of a sound
 * picked on iOS or in Chromium. So the container is read too, and the shorter of the two is the
 * length: the padding goes, and nothing that was decoded as sound does.
 *
 * Never the longer. A decode that came out SHORT of what the container presents has no more samples
 * to give; a pass laid past them would only be silence. And a browser that kept the priming too
 * (none measured does: the priming would be 23 ms of near-silence at the start of the decode) would
 * lose the last 23 ms of each pass here rather than gain a gap - the length still the one every
 * other engine loops at.
 *
 * `<audio>`'s own measure is not used: WebKit's is 11.975 s for the same file, short of both.
 */
function soundLengthUs(source: DecodedSource): number {
  const decodedUs = (channelOf(source, 0).length / source.sampleRate) * 1_000_000;
  const presentedUs = source.presentedUs;
  return presentedUs && presentedUs > 0 && presentedUs < decodedUs ? presentedUs : decodedUs;
}

/**
 * How long the sound in an MP4 or QuickTime file runs as the container presents it - its first sound
 * track, from its first presented sample to the end of its edit list - in µs, or null for any other
 * kind of file, a file with no sound track, or one the demuxer cannot read. Read from the packets'
 * timing alone (the sample table, already in memory), with nothing decoded; see [soundLengthUs].
 *
 * Only those two containers, because theirs is the edit list the decoders were measured against.
 * Other kinds carry their encoder's delay and padding in other ways (an MP3's LAME header, Opus's
 * pre-skip) that nobody has checked a browser's decode against, and there the decode stands, as it
 * did before.
 *
 * The demuxer is loaded on first use, as [readFrameTimes]'s is, so a post with no music never loads
 * it. It reads `bytes` before `decodeAudioData` takes them: decoding detaches the buffer.
 */
export async function presentedSoundUs(bytes: ArrayBuffer): Promise<number | null> {
  let input: { dispose(): void } | null = null;
  try {
    const { BufferSource, Input, MP4, QTFF } = await import('mediabunny');
    const reader = new Input({ source: new BufferSource(bytes), formats: [MP4, QTFF] });
    input = reader;
    const track = await reader.getPrimaryAudioTrack();
    if (!track) return null;
    // The end of the last packet, less where the first is presented when that is after 0: a sound
    // that starts late decodes from its first sample, with no silence put in front of it. Priming
    // is presented before 0, so it takes nothing off.
    const seconds = (await track.computeDuration()) - Math.max(0, await track.getFirstTimestamp());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1_000_000) : null;
  } catch {
    return null;
  } finally {
    input?.dispose();
  }
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
  for (const music of plan.musicTracks) use(music.uri);
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
 *
 * The files in `measured` - the music's - also have their container's own length read before they
 * are decoded ([presentedSoundUs]). By file rather than by ask, because the one decode is shared:
 * a music file that is also a clip or a take is measured whichever of them asks for it first.
 */
class SourceDecoder {
  private readonly cache = new Map<string, DecodedSource | null>();
  private context: BaseAudioContext | null = null;
  private readonly measured: ReadonlySet<string>;

  constructor(
    private readonly uses: Map<string, number>,
    measured: Iterable<string> = [],
  ) {
    this.measured = new Set(measured);
  }

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
    // Before the decode, which detaches `bytes`.
    const presentedUs = this.measured.has(uri) ? await presentedSoundUs(bytes) : null;
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
        presentedUs,
      };
    }
    return { sampleRate: buffer.sampleRate, channels, presentedUs };
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
