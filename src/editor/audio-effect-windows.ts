import {
  AUDIO_EFFECT_MIN_TAIL_MS,
  AUDIO_EFFECT_RAMP_MS,
  MAX_AUDIO_EFFECTS,
  MIN_AUDIO_EFFECT_SPEED,
  type ComposeAudioEffect,
  type ComposeSoundEffect,
} from '../video-composer/definitions';

import { SoundEffectError, SoundEffectRunner, normaliseSoundEffect } from './sound-effects';

/**
 * Effects over windows of the finished mix: the editor's audio effect layers as the wire carries them
 * ([ComposeAudioEffect]) and as every engine runs them. The parser's rules and the arithmetic are here
 * once, for the web render, the preview's copy and the tests; the Kotlin and Swift engines mirror both,
 * check for check and step for step, and are held to the same golden numbers.
 */

/** A window list no engine could play, and where in it: see [normaliseAudioEffectWindows]. */
export class AudioEffectWindowError extends Error {
  constructor(
    /** The path under `audio.effects`: `[2].endMs`, `[0].effect.ops[1].db`, or empty for the list. */
    readonly field: string,
    readonly detail = '',
  ) {
    super(`effects${field}${detail}`);
    this.name = 'AudioEffectWindowError';
  }
}

const WINDOW_KEYS: readonly string[] = ['effect', 'endMs', 'speed', 'startMs'];

/**
 * A window list made safe to run, by the rules [ComposeAudioEffect] states: a NEW array of new windows
 * in the order they came - the order they stack in, whatever their times - every number held to its
 * range, and a window that would change nothing left out. Empty for none. Throws
 * [AudioEffectWindowError] for a list no engine could play.
 */
export function normaliseAudioEffectWindows(value: unknown): ComposeAudioEffect[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AudioEffectWindowError('');
  if (value.length > MAX_AUDIO_EFFECTS) throw new AudioEffectWindowError('', ` at most ${MAX_AUDIO_EFFECTS} windows`);
  const kept: ComposeAudioEffect[] = [];
  value.forEach((raw: unknown, i) => {
    const at = `[${i}]`;
    if (!isRecord(raw)) throw new AudioEffectWindowError(at);
    const startMs = raw['startMs'];
    if (typeof startMs !== 'number' || !Number.isFinite(startMs)) throw new AudioEffectWindowError(`${at}.startMs`);
    const endMs = raw['endMs'];
    if (typeof endMs !== 'number' || !Number.isFinite(endMs)) throw new AudioEffectWindowError(`${at}.endMs`);
    const start = Math.max(0, startMs);
    if (!(endMs > start)) throw new AudioEffectWindowError(`${at}.endMs`);
    const rawSpeed = raw['speed'];
    if (rawSpeed !== undefined && rawSpeed !== null && (typeof rawSpeed !== 'number' || !Number.isFinite(rawSpeed))) {
      throw new AudioEffectWindowError(`${at}.speed`);
    }
    const speed = typeof rawSpeed === 'number' ? Math.min(1, Math.max(MIN_AUDIO_EFFECT_SPEED, rawSpeed)) : 1;
    let effect: ComposeSoundEffect | null;
    try {
      effect = normaliseSoundEffect(raw['effect']);
    } catch (error) {
      if (!(error instanceof SoundEffectError)) throw error;
      throw new AudioEffectWindowError(`${at}.effect${error.field ? `.${error.field}` : ''}`, error.detail);
    }
    // Alphabetically, as every engine names one: iOS reads an object with no order of its own.
    const unknown = Object.keys(raw)
      .filter(key => !WINDOW_KEYS.includes(key))
      .sort()[0];
    if (unknown !== undefined) throw new AudioEffectWindowError(`${at}.${unknown}`);
    if (!effect && speed === 1) return;
    kept.push({ startMs: start, endMs, ...(speed !== 1 ? { speed } : {}), ...(effect ? { effect } : {}) });
  });
  return kept;
}

/**
 * How long a window's steps run on after it, in ms: twice the longest reverb step's `decayMs` - 120 dB
 * down, past anything a 16-bit file carries - and never under [AUDIO_EFFECT_MIN_TAIL_MS].
 */
export function audioEffectTailMs(effect: ComposeSoundEffect | null | undefined): number {
  let decayMs = 0;
  for (const op of effect?.ops ?? []) if (op.op === 'reverb') decayMs = Math.max(decayMs, op.decayMs);
  return Math.max(AUDIO_EFFECT_MIN_TAIL_MS, 2 * decayMs);
}

/** A time on the stream as a frame number, rounded half up as every engine rounds it. */
export function frameAt(ms: number, sampleRate: number): number {
  return Math.floor((ms * sampleRate) / 1000 + 0.5);
}

/**
 * Every window of a list running on a stream of sound: [ComposeAudioEffect]'s arithmetic, frame for
 * frame. The stream comes in order, in pieces of any size, and leaves exactly as it would in one; the
 * first frame of the first piece is output frame `firstFrame`. Each window is run on what the ones
 * before it in the list left - where they cover the same frames, that is the stack - and keeps what
 * it has not yet read of that: for a slowed window, what it has fallen behind.
 */
export class AudioEffectRunner {
  private readonly stages: WindowStage[];
  private frame: number;

  constructor(windows: readonly ComposeAudioEffect[], sampleRate: number, firstFrame = 0) {
    this.stages = windows.map(window => new WindowStage(window, sampleRate));
    this.frame = firstFrame;
  }

  /** The output frame past which nothing is changed: where the last tail ends. 0 for no window. */
  get endFrame(): number {
    return this.stages.reduce((end, stage) => Math.max(end, stage.tailEnd), 0);
  }

  /** `count` frames of `channels` from `from` through every window, in place. Every channel is as long. */
  process(channels: readonly Float32Array[], from = 0, count = (channels[0]?.length ?? 0) - from): void {
    if (channels.length === 0 || count <= 0) return;
    for (const stage of this.stages) stage.process(channels, from, count, this.frame);
    this.frame += count;
  }
}

/** How many frames a window works through at a time: a bound on its scratch, nothing more. */
const BLOCK = 4096;

/** One window of the list, with its own steps and its own memory of its input. */
class WindowStage {
  readonly start: number;
  readonly end: number;
  readonly tailEnd: number;
  private readonly ramp: number;
  private readonly speed: number;
  private readonly steps: SoundEffectRunner | null;
  /** The block's input, and what goes through the steps; one of each per channel, made at first use. */
  private dry: Float32Array[] = [];
  private wet: Float32Array[] = [];
  /**
   * A slowed window's input, per channel: entry `i` is frame `historyFrom + i`, the first
   * `historyLength` entries are filled, and the first `historyDead` of those it will never read again.
   */
  private history: Float32Array[] = [];
  private historyFrom = 0;
  private historyLength = 0;
  private historyDead = 0;

  constructor(window: ComposeAudioEffect, sampleRate: number) {
    this.start = frameAt(window.startMs, sampleRate);
    this.end = Math.max(this.start, frameAt(window.endMs, sampleRate));
    this.tailEnd = this.end + frameAt(audioEffectTailMs(window.effect), sampleRate);
    this.ramp = Math.min(frameAt(AUDIO_EFFECT_RAMP_MS, sampleRate), Math.floor((this.end - this.start) / 2));
    this.speed = window.speed ?? 1;
    this.steps = window.effect ? new SoundEffectRunner(window.effect, sampleRate) : null;
  }

  private get slows(): boolean {
    return this.speed < 1;
  }

  process(channels: readonly Float32Array[], from: number, count: number, at: number): void {
    if (this.dry.length !== channels.length) this.allocate(channels.length);
    // A slowed window remembers the frame before it as well: its first frames read it.
    const first = Math.max(at, this.slows ? this.start - 1 : this.start);
    const last = Math.min(at + count, this.tailEnd);
    for (let n = first; n < last; n += BLOCK) this.run(channels, from + (n - at), n, Math.min(BLOCK, last - n));
  }

  private allocate(width: number): void {
    this.dry = Array.from({ length: width }, () => new Float32Array(BLOCK));
    this.wet = Array.from({ length: width }, () => new Float32Array(BLOCK));
    this.history = this.slows ? Array.from({ length: width }, () => new Float32Array(BLOCK)) : [];
    this.historyLength = 0;
  }

  /** Frames `n .. n + count` of the stream, which sit at `offset` in `channels`. */
  private run(channels: readonly Float32Array[], offset: number, n: number, count: number): void {
    const width = channels.length;
    for (let c = 0; c < width; c++) this.dry[c]!.set(channels[c]!.subarray(offset, offset + count));
    if (this.slows) this.remember(n, count);
    // The frame before the window is only remembered, never changed.
    const skip = Math.max(0, this.start - n);
    if (skip >= count) return;

    for (let j = skip; j < count; j++) {
      const frame = n + j;
      const g = this.gate(frame);
      for (let c = 0; c < width; c++) {
        const w = frame >= this.end ? 0 : this.slows ? this.slowed(c, frame) : this.dry[c]![j]!;
        this.wet[c]![j] = g * w;
      }
    }
    if (this.steps) {
      this.steps.process(
        this.wet.map(channel => channel.subarray(skip, count)),
        0,
        count - skip,
      );
    }
    for (let j = skip; j < count; j++) {
      const keep = 1 - this.gate(n + j);
      for (let c = 0; c < width; c++) channels[c]![offset + j] = held(keep * this.dry[c]![j]! + this.wet[c]![j]!);
    }
    if (this.slows) this.forget(n + count);
  }

  /** g(n): 0 at the start, up over the ramp, 1, down over the ramp to 0 at the end; 0 outside. */
  private gate(frame: number): number {
    if (frame < this.start || frame >= this.end) return 0;
    if (this.ramp <= 0) return 1;
    const g = Math.min(frame - this.start, this.end - frame) / this.ramp;
    return g < 1 ? g : 1;
  }

  /** w(n) of a slowed window: the input read at `start + (n - start) * speed`, by Catmull-Rom. */
  private slowed(c: number, frame: number): number {
    const position = this.start + (frame - this.start) * this.speed;
    const k = Math.floor(position);
    const t = position - k;
    const x0 = this.input(c, k - 1, frame);
    const x1 = this.input(c, k, frame);
    const x2 = this.input(c, k + 1, frame);
    const x3 = this.input(c, k + 2, frame);
    return x1 + 0.5 * t * (x2 - x0 + t * (2 * x0 - 5 * x1 + 4 * x2 - x3 + t * (3 * (x1 - x2) + x3 - x0)));
  }

  /**
   * x(k) as the slowed mix reads it: a frame after `now` reads `now`, and one before 0 reads 0. A frame
   * before what is remembered - only for a stream handed over from inside the window - reads the
   * earliest there is.
   */
  private input(c: number, k: number, now: number): number {
    const frame = k > now ? now : k < 0 ? 0 : k;
    const index = Math.min(Math.max(0, frame - this.historyFrom), this.historyLength - 1);
    return this.history[c]![index]!;
  }

  /** Keeps the block's input from the frame before the window to its end, for the slowed mix to read. */
  private remember(n: number, count: number): void {
    const from = Math.max(n, this.start - 1);
    const to = Math.min(n + count, this.end);
    if (to <= from || this.history.length === 0) return;
    if (this.historyLength === 0) {
      this.historyFrom = from;
      this.historyDead = 0;
    }
    const capacity = this.history[0]!.length;
    if (this.historyLength + (to - from) > capacity) {
      // What it will never read again goes first, once that is half the room: the copy down is then
      // paid for by what it frees. Otherwise there is room to be made.
      if (2 * this.historyDead >= capacity) {
        for (const channel of this.history) channel.copyWithin(0, this.historyDead, this.historyLength);
        this.historyFrom += this.historyDead;
        this.historyLength -= this.historyDead;
        this.historyDead = 0;
      }
      const needed = this.historyLength + (to - from);
      if (needed > capacity) {
        const size = Math.max(needed, 2 * capacity);
        this.history = this.history.map(old => {
          const grown = new Float32Array(size);
          grown.set(old.subarray(0, this.historyLength));
          return grown;
        });
      }
    }
    for (let c = 0; c < this.history.length; c++) this.history[c]!.set(this.dry[c]!.subarray(from - n, to - n), this.historyLength);
    this.historyLength += to - from;
  }

  /** Marks what the slowed mix will never read again, from frame `next` on: everything before `k - 1`. */
  private forget(next: number): void {
    if (next >= this.end) {
      // Past the window nothing reads its input at all.
      this.history = [];
      this.historyLength = 0;
      return;
    }
    const oldest = Math.floor(this.start + (next - this.start) * this.speed) - 1;
    this.historyDead = Math.max(0, Math.min(this.historyLength, oldest - this.historyFrom));
  }
}

function held(y: number): number {
  return y > 1 ? 1 : y < -1 ? -1 : y;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
