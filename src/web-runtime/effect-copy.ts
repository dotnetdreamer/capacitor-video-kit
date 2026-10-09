/**
 * What an audio effect layer makes of the post's sound, for the preview to play in the place of
 * everything the layer covers.
 *
 * An `<audio>` element plays a file and nothing else; it cannot be handed a filter, and a layer's
 * effect is on the MIX - every clip's own sound, every sound, every voiceover under it at once, which
 * the preview plays on elements of their own and never adds together. The other way to treat what
 * they play, Web Audio, is the one the preview keeps sound out of wherever it can (`PreviewMixer`): an
 * element given to the graph can never be taken back, WebKit reads it at real time whatever its rate,
 * a clip's `<video>` cannot go into it at all, and on iOS the graph is ambient sound the ringer
 * silences. So the layer goes into a FILE instead: the post's sound over the layer's window, mixed by
 * the web render's own arithmetic (`mixWindow`), put through the layer by the arithmetic every engine
 * runs (`AudioEffectRunner`), and written out as a WAV - so what is heard in the editor is what is
 * posted, a slowed window and its jump back to the timeline included.
 *
 * On the post's timeline: the copy starts where the layer does and runs on past its end for as long
 * as the preview lets its steps ring ([copyTailMs]), and the preview plays it there INSTEAD of every
 * sound it covers. At its first moment the copy is the mix itself - the layer comes in over its ramp -
 * so the hand over from the sounds to the copy is a hand over between two copies of one sound. Layers
 * close enough for one's copy to reach the next ([copyGroups]) are one copy, with each window run on
 * what the one before it left, as every engine runs them.
 *
 * At [COPY_RATES]' first rate the browser takes, 32 kHz: a preview on a phone's speaker, and a third
 * of the memory of 48 kHz for every source it decodes. In steps, giving the page back between them, so
 * a long layer does not hold the editor up while it is made.
 */
import { AudioEffectRunner, frameAt } from '../editor/audio-effect-windows';
import type { ComposeAudioEffect, ComposeSoundEffect } from '../video-composer/definitions';
import { decodeSource, mixWindow, offlineContext, type AudioSourceReader, type DecodedSource } from '../video-composer/web/audio';
import type { RenderPlan } from '../video-composer/web/plan';

/** The rates a copy is made at, the first the browser will build a context at. */
export const COPY_RATES: readonly number[] = [32_000, 44_100, 48_000];

/**
 * The longest a copy rings on past its layer: the longest room the editor's effects make (slow +
 * reverb's Room at the top, 6 s to fall 60 dB). What [copySoundKey] looks that far past the layer for,
 * so moving a slider never changes which sound the copy is made of.
 */
export const MAX_COPY_TAIL_MS = 6000;

/** How much sound is put through the layer before the page is given back, in seconds of it. */
const STEP_S = 1;

/**
 * How long the preview lets a layer ring on after it: its longest reverb's `decayMs` - 60 dB down,
 * under any sound that goes on after it - and a moment for a filter to settle otherwise. Shorter than
 * the render's tail (`audioEffectTailMs`, 120 dB): past this the copy only holds the sound up.
 */
export function copyTailMs(effect: ComposeSoundEffect | null | undefined): number {
  let decayMs = 0;
  for (const op of effect?.ops ?? []) if (op.op === 'reverb') decayMs = Math.max(decayMs, op.decayMs);
  return Math.min(MAX_COPY_TAIL_MS, Math.max(50, decayMs));
}

/** A copy made: the file, and where on the post its first moment and its end are heard. */
export interface EffectCopyFile {
  blob: Blob;
  startMs: number;
  endMs: number;
}

/**
 * The windows that make one copy each, in time: a window starts a new copy only [MAX_COPY_TAIL_MS] or
 * more after every window before it in time has ended, so no copy rings on into another, and windows
 * stacked over the same moment always share one. Settled by where the windows are and by nothing
 * about their effects, so a slider never regroups them. Each group keeps the order the windows were
 * given in, which is the stack.
 */
export function copyGroups<T extends Pick<ComposeAudioEffect, 'startMs' | 'endMs'>>(windows: readonly T[]): T[][] {
  const byTime = windows.map((window, index) => ({ window, index })).sort((a, b) => a.window.startMs - b.window.startMs || a.index - b.index);
  const groups: { window: T; index: number }[][] = [];
  let reach = -Infinity;
  for (const one of byTime) {
    const group = groups[groups.length - 1];
    if (group && one.window.startMs < reach + MAX_COPY_TAIL_MS) {
      group.push(one);
      reach = Math.max(reach, one.window.endMs);
    } else {
      groups.push([one]);
      reach = one.window.endMs;
    }
  }
  return groups.map(group => group.sort((a, b) => a.index - b.index).map(one => one.window));
}

/**
 * `windows` of `plan` - one of [copyGroups] - as a copy, or null when there is nothing under them to
 * hear, which they then change nothing of, and when a source cannot be read ([CopySources]). Throws an
 * `AbortError` once `signal` is.
 */
export async function makeEffectCopy(plan: RenderPlan, windows: readonly ComposeAudioEffect[], sources: CopySources, signal: AbortSignal): Promise<EffectCopyFile | null> {
  const rate = sources.sampleRate;
  if (!rate || windows.length === 0) return null;
  // The earliest window, wherever it is in the stack.
  const start = Math.min(...windows.map(window => frameAt(window.startMs, rate)));
  const last = Math.ceil((plan.totalUs / 1_000_000) * rate);
  const to = Math.min(last, Math.max(...windows.map(window => frameAt(window.endMs, rate) + frameAt(copyTailMs(window.effect), rate))));
  // From the frame before the first layer, which a slowed one reads at its first frames.
  const from = Math.max(0, start - 1);
  if (to <= start) return null;
  const mix = await mixWindow(plan, from, to, rate, sources, signal);
  if (!mix || sources.refused) return null;
  const runner = new AudioEffectRunner(windows, rate, from);
  const step = Math.max(1, Math.round(rate * STEP_S));
  for (let at = 0; at < mix.length; at += step) {
    runner.process(mix.channels, at, Math.min(step, mix.length - at));
    await pageTurn();
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
  }
  const skip = start - from;
  return {
    blob: wav(
      mix.channels.map(channel => channel.subarray(skip)),
      rate,
    ),
    startMs: (start * 1000) / rate,
    endMs: (to * 1000) / rate,
  };
}

/**
 * What a copy of `windows` is made of, but for the layers' own effects, sliders and Slow: where each
 * layer is, and every placement of every sound heard from just before the first to [MAX_COPY_TAIL_MS]
 * after the last, as `plan` lays it. Equal for two plans exactly when a copy made from one plays right
 * in the other - so an edit anywhere else, or to a layer's sliders, leaves it alone, and one under the
 * layers does not.
 */
export function copySoundKey(plan: RenderPlan, windows: readonly Pick<ComposeAudioEffect, 'startMs' | 'endMs'>[]): string {
  const fromUs = Math.round((windows.length ? Math.min(...windows.map(window => window.startMs)) : 0) * 1000) - 1000;
  const toUs = Math.round((Math.max(0, ...windows.map(window => window.endMs)) + MAX_COPY_TAIL_MS) * 1000);
  const heard = (startUs: number, endUs: number): boolean => endUs > fromUs && startUs < toUs;
  // Where the layers are, in time: their order in the stack is an effect of theirs, not the sound's.
  const spans = windows.map(window => [Math.round(window.startMs), Math.round(window.endMs)]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  const parts: unknown[] = [spans, plan.totalUs];
  plan.clips.forEach((clip, i) => {
    const atUs = plan.prefixOutUs[i] ?? 0;
    if (!clip.removeAudio && heard(atUs, atUs + clip.outDurUs)) parts.push(['c', i, clip.clip.uri, clip.inUs, clip.outUs, clip.speed, clip.gain, atUs]);
  });
  for (const transition of plan.transitions) {
    const tail = transition.tail;
    if (!tail.removeAudio && heard(transition.startUs, transition.startUs + transition.durUs)) {
      parts.push(['t', transition.index, tail.clip.uri, tail.inUs, tail.outUs, tail.speed, tail.gain, transition.startUs, transition.durUs]);
    }
  }
  for (const track of plan.tracks) {
    track.clips.forEach((clip, i) => {
      const placement = track.placements[i];
      if (placement && !clip.removeAudio && heard(placement.startUs, placement.startUs + clip.outDurUs)) {
        parts.push(['l', clip.clip.uri, clip.inUs, clip.outUs, clip.speed, clip.gain, placement.startUs]);
      }
    });
  }
  for (const music of [...(plan.music ? [plan.music] : []), ...plan.musicTracks]) {
    if (heard(music.startUs, music.stopUs)) parts.push(['m', music]);
  }
  for (const take of plan.voice) if (heard(take.atUs, take.atUs + take.lengthUs)) parts.push(['v', take]);
  return JSON.stringify(parts);
}

/**
 * The sources a copy is mixed from, decoded once and kept for the next: a slider let go makes the same
 * layer again from the same sound, and decoding a song again for it would be most of the wait. Kept
 * to [budgetBytes] of decoded sound, the least recently used let go first.
 *
 * A source [tooLong] says is past what a phone can decode whole is never read: the copy is then not
 * made ([refused]), and the preview plays the sounds as they are - the render has the layer either way.
 */
export class CopySources implements AudioSourceReader {
  readonly sampleRate: number;
  /** Set once a source was too long to read: the copy being made is not one to play. */
  refused = false;
  private context: BaseAudioContext | null;
  private readonly kept = new Map<string, Promise<DecodedSource | null>>();
  private readonly sizes = new Map<string, number>();
  private bytes = 0;

  constructor(
    private readonly tooLong: (uri: string) => boolean = () => false,
    private readonly budgetBytes = 64 * 1024 * 1024,
  ) {
    let context: BaseAudioContext | null = null;
    let sampleRate = 0;
    for (const rate of COPY_RATES) {
      context = offlineContext(rate);
      if (context) {
        sampleRate = rate;
        break;
      }
    }
    this.context = context;
    this.sampleRate = sampleRate;
  }

  get(uri: string, measure: boolean): Promise<DecodedSource | null> {
    const kept = this.kept.get(uri);
    if (kept) {
      // The most recently used goes to the back of the line.
      this.kept.delete(uri);
      this.kept.set(uri, kept);
      return kept;
    }
    if (!this.context) return Promise.resolve(null);
    if (this.tooLong(uri)) {
      this.refused = true;
      return Promise.resolve(null);
    }
    const decoding = decodeSource(uri, this.context, this.sampleRate, measure).then(decoded => {
      const size = decoded ? decoded.channels.reduce((sum, channel) => sum + channel.byteLength, 0) : 0;
      if (this.kept.get(uri) === decoding) {
        this.sizes.set(uri, size);
        this.bytes += size;
        this.trim(uri);
      }
      return decoded;
    });
    this.kept.set(uri, decoding);
    return decoding;
  }

  done(): void {
    // Kept for the next copy; see [trim].
  }

  close(): void {
    // Kept for the next copy; see [clear].
  }

  /** A new copy starts with nothing refused. */
  begin(): void {
    this.refused = false;
  }

  /** Lets go of every source, for an editor that is closing. */
  clear(): void {
    this.kept.clear();
    this.sizes.clear();
    this.bytes = 0;
    this.context = null;
  }

  /** Lets go of the least recently used sources until what is kept fits, never the one just decoded. */
  private trim(keep: string): void {
    for (const uri of this.kept.keys()) {
      if (this.bytes <= this.budgetBytes) return;
      if (uri === keep) continue;
      this.bytes -= this.sizes.get(uri) ?? 0;
      this.sizes.delete(uri);
      this.kept.delete(uri);
    }
  }
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
