import { MAX_SOUND_OPS, type ComposeSoundEffect, type SoundOp } from '../video-composer/definitions';

/**
 * What a sound can be put through: a megaphone today, and whatever is added beside it.
 *
 * A sound in the manifest names its effect by id ([EditMusic.effect]) and nothing more, the way a
 * post names its filter. What the effect IS - the filters, the drive, the level - is here, and goes
 * on the wire as plain steps ([ComposeSoundEffect]) for the engines to run. So the sound of an effect
 * is decided in one place: a new one built from the same steps needs no new engine, and the preview,
 * the web render and both phones hear the same arithmetic.
 */

/** One effect, as the Effects sheet offers it. */
export interface SoundEffectPreset {
  /** Stored in a manifest, so permanent: renaming one is a migration. */
  id: string;
  label: string;
  /** What it is made of, exactly as it goes on the wire. */
  effect: ComposeSoundEffect;
}

/** A second-order Butterworth: the flattest pass band a biquad has, with no bump at the corner. */
const BUTTERWORTH_Q = Math.SQRT1_2;

/**
 * Every effect, in the order the sheet offers them.
 *
 * THE MEGAPHONE is a voice through a small horn speaker driven too hard: only the middle of the voice
 * comes through, it buzzes on every loud syllable, and it is a little louder than it was. Each step
 * is that, in order:
 *  - the horn passes nothing much under 600 Hz, so two high-passes there take away the body of the
 *    voice, and a low-pass at 5 kHz keeps a sibilant's hiss out of the drive, where it would only
 *    turn to noise;
 *  - a presence peak at 1.8 kHz is the horn's honk;
 *  - the drive is the overdriven amplifier, measured against the sound's own peak ([ComposeSoundEffect]),
 *    so a quiet phone recording buzzes exactly as a loud one does and stays as quiet as it was;
 *  - two low-passes at 3.5 kHz are what the horn cannot reproduce, and take the drive's harshest
 *    harmonics with them;
 *  - and 4 dB off the top leaves the result a little louder than the dry sound and well under it at
 *    its peaks, so a word put through it stands out without clipping the mix.
 * Measured on 2026-10-09 against a synthesised voice at -19.7 LUFS: -16.5 LUFS and -4.0 dBFS true
 * peak out, from -0.3 in; the same 3.2 LU and the same spectrum at 12 and 24 dB quieter.
 */
export const SOUND_EFFECTS: readonly SoundEffectPreset[] = freezeAll([
  {
    id: 'megaphone',
    label: 'Megaphone',
    effect: {
      mono: true,
      ops: [
        { op: 'highpass', hz: 600, q: BUTTERWORTH_Q },
        { op: 'highpass', hz: 600, q: BUTTERWORTH_Q },
        { op: 'lowpass', hz: 5000, q: BUTTERWORTH_Q },
        { op: 'peak', hz: 1800, q: 1, db: 6 },
        { op: 'drive', db: 20, followMs: 300 },
        { op: 'lowpass', hz: 3500, q: BUTTERWORTH_Q },
        { op: 'lowpass', hz: 3500, q: BUTTERWORTH_Q },
        { op: 'gain', db: -4 },
      ],
    },
  },
]);

/** The effect `id` names, or null for none and for an id this version does not know. */
export function soundEffectPreset(id: unknown): SoundEffectPreset | null {
  return typeof id === 'string' ? (SOUND_EFFECTS.find(preset => preset.id === id) ?? null) : null;
}

/**
 * An effect id as a manifest keeps one: an id from [SOUND_EFFECTS], or `undefined` - the absent key -
 * for none and for anything else, an id from a later version included. Dropped rather than kept, as a
 * transition this version does not know is: an engine could not play it, and a post that kept it
 * would sound different here from the post that was saved.
 */
export function normaliseSoundEffectId(value: unknown): string | undefined {
  return soundEffectPreset(value)?.id;
}

/* -------------------------------------------------------------------------------------------- */
/* The parser's rules                                                                            */
/* -------------------------------------------------------------------------------------------- */

/** An effect no engine could play, and where in it: see [normaliseSoundEffect]. */
export class SoundEffectError extends Error {
  constructor(
    readonly field: string,
    readonly detail = '',
  ) {
    super(`effect${field ? `.${field}` : ''}${detail}`);
    this.name = 'SoundEffectError';
  }
}

/** A number a step takes, in the order a parser reads it, and the range it is held to. */
interface OpField {
  name: string;
  min: number;
  max: number;
  optional?: true;
}

const HZ: OpField = { name: 'hz', min: 10, max: 20_000 };
const Q: OpField = { name: 'q', min: 0.1, max: 10 };

/** Each step's numbers, in the order [ComposeSoundEffect] declares them. */
const OP_FIELDS: Readonly<Record<SoundOp['op'], readonly OpField[]>> = {
  highpass: [HZ, Q],
  lowpass: [HZ, Q],
  peak: [HZ, Q, { name: 'db', min: -24, max: 24 }],
  drive: [
    { name: 'db', min: 0, max: 40 },
    { name: 'followMs', min: 1, max: 10_000, optional: true },
  ],
  gain: [{ name: 'db', min: -40, max: 24 }],
};

const EFFECT_KEYS: readonly string[] = ['mono', 'ops'];

/**
 * A sound's effect made safe to run: the parser's rules, shared by the web engine and the tests and
 * mirrored check for check by the Kotlin and Swift parsers (see [ComposeSoundEffect]). A NEW object,
 * with every number held to its range. Null for none: no effect at all, and one that would leave
 * the sound as it is. Throws [SoundEffectError] for an effect no engine could play.
 */
export function normaliseSoundEffect(value: unknown): ComposeSoundEffect | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new SoundEffectError('');
  const mono = value['mono'];
  if (mono !== undefined && mono !== null && typeof mono !== 'boolean') throw new SoundEffectError('mono');
  const raw = value['ops'];
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) throw new SoundEffectError('ops');
  const unknown = firstUnknownKey(value, EFFECT_KEYS);
  if (unknown !== undefined) throw new SoundEffectError(unknown);
  const ops: readonly unknown[] = Array.isArray(raw) ? raw : [];
  if (ops.length > MAX_SOUND_OPS) throw new SoundEffectError('ops', ` at most ${MAX_SOUND_OPS} steps`);
  const steps = ops.map((op, i) => readOp(op, `ops[${i}]`));
  if (steps.length === 0 && mono !== true) return null;
  return mono === true ? { mono: true, ops: steps } : { ops: steps };
}

function readOp(raw: unknown, path: string): SoundOp {
  if (!isRecord(raw)) throw new SoundEffectError(path);
  const name = raw['op'];
  // Own keys only: `toString` is not a step, whatever the prototype says.
  const fields = typeof name === 'string' && Object.prototype.hasOwnProperty.call(OP_FIELDS, name) ? OP_FIELDS[name as SoundOp['op']] : undefined;
  if (!fields) throw new SoundEffectError(`${path}.op`);
  const op: Record<string, unknown> = { op: name };
  for (const field of fields) {
    const value = raw[field.name];
    if ((value === undefined || value === null) && field.optional) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new SoundEffectError(`${path}.${field.name}`);
    op[field.name] = Math.min(field.max, Math.max(field.min, value));
  }
  const unknown = firstUnknownKey(raw, ['op', ...fields.map(field => field.name)]);
  if (unknown !== undefined) throw new SoundEffectError(`${path}.${unknown}`);
  return op as SoundOp;
}

/**
 * The first key of `record` that is not one of `known`, in ALPHABETICAL order: iOS reads an object
 * with no order of its own, so the order every engine names one in has to be one none of them chose.
 */
function firstUnknownKey(record: Record<string, unknown>, known: readonly string[]): string | undefined {
  return Object.keys(record)
    .filter(key => !known.includes(key))
    .sort()[0];
}

/* -------------------------------------------------------------------------------------------- */
/* The arithmetic                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** Under this a filter's state or the drive's level is set to 0, so silence never goes denormal. */
const TINY = 1e-20;
/** The quietest level the drive measures a sound against: -50 dBFS. */
const DRIVE_FLOOR = Math.pow(10, -50 / 20);
/** The highest a filter's frequency goes, as a fraction of the rate: a 4 kHz low-pass on an 8 kHz file is a 3.6 kHz one. */
const MAX_HZ_OF_RATE = 0.45;

interface Step {
  run(x: number): number;
}

/** One cookbook biquad in transposed direct form II, its coefficients already divided by `a0`. */
class Biquad implements Step {
  private z1 = 0;
  private z2 = 0;

  constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  run(x: number): number {
    const y = this.b0 * x + this.z1;
    const z1 = this.b1 * x - this.a1 * y + this.z2;
    const z2 = this.b2 * x - this.a2 * y;
    // Both at once or neither: zeroing one alone leaves the other feeding a recurrence it no longer
    // balances, and a low-pass then sat at 1e-19 for ever, just over the line, instead of falling silent.
    if (z1 < TINY && z1 > -TINY && z2 < TINY && z2 > -TINY) {
      this.z1 = 0;
      this.z2 = 0;
    } else {
      this.z1 = z1;
      this.z2 = z2;
    }
    return y;
  }
}

class Drive implements Step {
  private level = 0;

  constructor(
    private readonly g: number,
    /** The level's fall per sample, or null for a drive measured against full scale. */
    private readonly decay: number | null,
  ) {}

  run(x: number): number {
    if (this.decay === null) return Math.tanh(this.g * x);
    const a = x < 0 ? -x : x;
    let level = a > this.level ? a : this.level * this.decay;
    if (level < TINY) level = 0;
    this.level = level;
    const e = level > DRIVE_FLOOR ? level : DRIVE_FLOOR;
    return e * Math.tanh((this.g * x) / e);
  }
}

class Gain implements Step {
  constructor(private readonly g: number) {}

  run(x: number): number {
    return this.g * x;
  }
}

function stepFor(op: SoundOp, rate: number): Step {
  switch (op.op) {
    case 'drive':
      return new Drive(Math.pow(10, op.db / 20), op.followMs ? Math.exp(-1000 / (op.followMs * rate)) : null);
    case 'gain':
      return new Gain(Math.pow(10, op.db / 20));
    default: {
      const w0 = (2 * Math.PI * Math.min(op.hz, MAX_HZ_OF_RATE * rate)) / rate;
      const cos = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * op.q);
      if (op.op === 'lowpass') return biquad((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
      if (op.op === 'highpass') return biquad((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
      const A = Math.pow(10, op.db / 40);
      return biquad(1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A);
    }
  }
}

function biquad(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
}

/**
 * A [ComposeSoundEffect] running on a stream of sound at `sampleRate`: the arithmetic every engine
 * runs, as the web render and the preview's copy run it. It keeps its state from one call of
 * [process] to the next, so a sound handed over in pieces comes out exactly as it would in one; a
 * new pass of a sound is a new runner.
 */
export class SoundEffectRunner {
  /** One chain for a folded sound, else one per channel, made as each channel is first seen. */
  private readonly chains: Step[][] = [];

  constructor(
    private readonly effect: ComposeSoundEffect,
    private readonly sampleRate: number,
  ) {}

  /** `count` frames of `channels` from `from` through the effect, in place. Every channel is as long. */
  process(channels: readonly Float32Array[], from = 0, count = (channels[0]?.length ?? 0) - from): void {
    const n = channels.length;
    if (n === 0 || count <= 0) return;
    const to = from + count;
    if (this.effect.mono) {
      const chain = this.chain(0);
      for (let i = from; i < to; i++) {
        let sum = 0;
        for (let c = 0; c < n; c++) sum += channels[c]![i] ?? 0;
        const y = held(runChain(chain, sum / n));
        for (let c = 0; c < n; c++) channels[c]![i] = y;
      }
      return;
    }
    for (let c = 0; c < n; c++) {
      const samples = channels[c]!;
      const chain = this.chain(c);
      for (let i = from; i < to; i++) samples[i] = held(runChain(chain, samples[i] ?? 0));
    }
  }

  private chain(index: number): Step[] {
    let chain = this.chains[index];
    if (!chain) {
      chain = this.effect.ops.map(op => stepFor(op, this.sampleRate));
      this.chains[index] = chain;
    }
    return chain;
  }
}

function runChain(chain: readonly Step[], x: number): number {
  for (const step of chain) x = step.run(x);
  return x;
}

function held(y: number): number {
  return y > 1 ? 1 : y < -1 ? -1 : y;
}

/* -------------------------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The catalogue, frozen to its leaves: a step mutated in place would be a different sound everywhere. */
function freezeAll<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) freezeAll(inner);
    Object.freeze(value);
  }
  return value;
}
