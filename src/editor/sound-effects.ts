import { MAX_SOUND_OPS, MIN_AUDIO_EFFECT_SPEED, type ComposeSoundEffect, type SoundOp } from '../video-composer/definitions';

/**
 * What the sound of a post can be put through - a megaphone, a slowed and reverberant edit, a man's or a
 * woman's voice, a phone line - and how far.
 *
 * An audio effect layer names its effect by id ([EditAudioEffect.effect]) and keeps where the customer
 * left its sliders ([EditAudioEffect.effectSettings]), the way a post names its filter and keeps its
 * strength. What the effect IS at those settings - the filters, the drive, the reverb, the level - is
 * here, and goes on the wire as plain steps ([ComposeSoundEffect]) for the engines to run over the
 * layer's window of the mix ([ComposeAudioEffect]). So the sound of an effect is decided in one place:
 * a new one built from the same steps needs no new engine, a slider moves numbers in steps every
 * engine already runs, and the preview, the web render and both phones hear the same arithmetic.
 */

/**
 * One adjustment an effect offers: a slider in the Audio effects sheet, in whole steps from 0 to
 * [SOUND_EFFECT_SETTING_MAX], which the effect turns into the numbers of its steps.
 */
export interface SoundEffectControl {
  /** Stored in a manifest ([EditAudioEffect.effectSettings]), so permanent: renaming one is a migration. */
  key: string;
  /** The word beside the slider. */
  label: string;
  /** The slider's name to a screen reader, and the undo step a drag of it is: "Undo: Megaphone tone". */
  name: string;
  /** Where the slider is on a layer just made, and what a layer with no value has. */
  default: number;
}

/** The top of every [SoundEffectControl]'s scale; the bottom is 0. */
export const SOUND_EFFECT_SETTING_MAX = 100;

/** A layer's settings for its effect, by [SoundEffectControl.key]. */
export type SoundEffectSettings = Readonly<Record<string, number>>;

/**
 * An effect that slows what its layer covers, as a record played under its speed is slowed - lower as
 * well as slower - and offers that speed as its first slider, Slow ([EditAudioEffect.speed]). The
 * layer plays the mix from its own start at that speed ([ComposeAudioEffect.speed]) and goes back to
 * where the timeline is at its end, so nothing outside it moves.
 */
export interface SoundEffectSpeed {
  label: string;
  name: string;
  /** How slow a layer just made plays, and what a layer with no value plays at. */
  default: number;
  /** The slider's range, as speeds. */
  min: number;
  max: number;
}

/** One effect, as the Effects sheet offers it. */
export interface SoundEffectPreset {
  /** Stored in a manifest, so permanent: renaming one is a migration. */
  id: string;
  label: string;
  /** Its sliders, in the order the sheet shows them under [speed]'s. */
  controls: readonly SoundEffectControl[];
  /** How slow it plays what it covers, for an effect that slows; see [SoundEffectSpeed]. */
  speed?: SoundEffectSpeed;
  /** What it is made of at its default settings, exactly as it goes on the wire. */
  effect: ComposeSoundEffect;
  /**
   * What it is made of at `settings`, which has a value for every one of its [controls], already held
   * to the scale. A new object on every call; [soundEffectSteps] is the way in from a manifest.
   */
  steps(settings: SoundEffectSettings): ComposeSoundEffect;
}

/** A second-order Butterworth: the flattest pass band a biquad has, with no bump at the corner. */
const BUTTERWORTH_Q = Math.SQRT1_2;

/**
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
 *
 * Those are its settings at the middle of both sliders, exactly - a megaphone put on before the
 * sliders existed is that one. INTENSITY is the drive, 0 to 40 dB with 20 at the middle, and the level
 * after it moves the other way by [MEGAPHONE_LEVEL_PER_DB] for each decibel, so a harder megaphone
 * buzzes more without getting much louder. TONE moves the whole horn together, every corner and the
 * honk, by up to [MEGAPHONE_TONE_OCTAVES] either side: down is a bigger, duller horn, up a tinny one.
 */
function megaphone(settings: SoundEffectSettings): ComposeSoundEffect {
  const drive = (40 * setting(settings, 'intensity')) / SOUND_EFFECT_SETTING_MAX;
  const scale = Math.pow(2, ((setting(settings, 'tone') - 50) / 50) * MEGAPHONE_TONE_OCTAVES);
  const hz = (at: number) => Math.round(at * scale);
  return {
    mono: true,
    ops: [
      { op: 'highpass', hz: hz(600), q: BUTTERWORTH_Q },
      { op: 'highpass', hz: hz(600), q: BUTTERWORTH_Q },
      { op: 'lowpass', hz: hz(5000), q: BUTTERWORTH_Q },
      { op: 'peak', hz: hz(1800), q: 1, db: 6 },
      { op: 'drive', db: drive, followMs: 300 },
      { op: 'lowpass', hz: hz(3500), q: BUTTERWORTH_Q },
      { op: 'lowpass', hz: hz(3500), q: BUTTERWORTH_Q },
      { op: 'gain', db: -4 - MEGAPHONE_LEVEL_PER_DB * (drive - 20) },
    ],
  };
}

/** How far the megaphone's Tone takes the horn, in octaves either side of the middle. */
const MEGAPHONE_TONE_OCTAVES = 0.6;
/** How much quieter the megaphone is put for each decibel more drive; see [megaphone]. */
const MEGAPHONE_LEVEL_PER_DB = 0.15;

/**
 * SLOW + REVERB is the slowed and reverberant edit of a song: slower and lower together, as a record
 * played under its speed is ([SoundEffectSpeed]), in a big, soft room. The slowing is the layer's own
 * Slow, so all the steps have to make is the room:
 *  - REVERB is how much of the room is heard: the tail comes up from nothing to as loud as the sound,
 *    and the sound itself goes down to 0.6 of what it was;
 *  - ROOM is how big it is: the tail takes from 1 to 6 seconds to fall 60 dB, and a bigger room is a
 *    darker one, its damping coming down from 8 kHz to 3 kHz.
 * The tail is about as loud as the sound at any length ([ComposeSoundEffect]), so neither slider moves
 * the level much, and nothing after the reverb has to make room for it. Measured on 2026-10-09 with
 * three songs from the catalogue at -14 LUFS, slowed to 0.8: within 1.7 LU of the song at every corner
 * of both sliders and 1.1 to 1.5 under it at the middle, never over -0.4 dBTP from songs peaking at
 * -1.2 to -2.8, and a tail that dies away in 0.8 to 4.9 seconds - the damping takes the top of it
 * sooner - with its two channels all but unrelated (0.02 to 0.06), so it is as wide as the speakers.
 */
function slowReverb(settings: SoundEffectSettings): ComposeSoundEffect {
  const amount = setting(settings, 'reverb') / SOUND_EFFECT_SETTING_MAX;
  const room = setting(settings, 'room') / SOUND_EFFECT_SETTING_MAX;
  return {
    ops: [
      {
        op: 'reverb',
        decayMs: Math.round(1000 + 5000 * room),
        dampHz: Math.round(8000 - 5000 * room),
        wet: round3(amount),
        dry: round3(1 - 0.4 * amount),
      },
    ],
  };
}

/**
 * THE MALE AND FEMALE VOICES move a voice's pitch and, apart from it, its resonances - the length of
 * the throat that makes a voice a man's or a woman's - with the pitch step ([ComposeSoundEffect]). A
 * woman's voice sits some ten semitones above a man's and her resonances 15 to 20% higher, so each
 * moves both the same way, the resonances half as far as the pitch: moved as far, a man comes out a
 * cartoon rather than a woman.
 *
 * PITCH runs from an octave down at 0 to none at 100 for the male voice, six semitones at the
 * middle, and from none to an octave up for the female voice; TONE moves the resonances the same way
 * by up to half an octave, three semitones at the middle. Both fold the sound to one channel - a pitch
 * step on each channel would place the two channels' peaks a little apart - and put back what moving
 * the voice costs it, [VOICE_LEVEL_PER_SEMITONE].
 *
 * Measured on 2026-10-09 with Windows' Zira and David voices: the male voice takes Zira from 174 Hz to
 * 123 and David from 89 to 64, the female voice David to 127 and Zira to 246; within 1.3 LU of the
 * voice at every corner of both sliders; and as harmonic as Rubber Band's pitch shift at the same
 * pitch, but for 1 to 1.8 dB of harmonics-to-noise ratio.
 */
function maleVoice(settings: SoundEffectSettings): ComposeSoundEffect {
  return voiceShift(12 * (setting(settings, 'pitch') / SOUND_EFFECT_SETTING_MAX - 1), 6 * (setting(settings, 'tone') / SOUND_EFFECT_SETTING_MAX - 1));
}

/** See [maleVoice]: the same, up rather than down. */
function femaleVoice(settings: SoundEffectSettings): ComposeSoundEffect {
  return voiceShift((12 * setting(settings, 'pitch')) / SOUND_EFFECT_SETTING_MAX, (6 * setting(settings, 'tone')) / SOUND_EFFECT_SETTING_MAX);
}

function voiceShift(semitones: number, formant: number): ComposeSoundEffect {
  return {
    mono: true,
    ops: [
      { op: 'pitch', semitones: round3(semitones), formant: round3(formant) },
      { op: 'gain', db: round3(VOICE_LEVEL_PER_SEMITONE * Math.abs(semitones)) },
    ],
  };
}

/**
 * How much louder a voice is put for each semitone it is moved: what the phase vocoder loses of it,
 * about 1 LU at six semitones and 2 at twelve, the further the more.
 */
const VOICE_LEVEL_PER_SEMITONE = 0.12;

/**
 * THE TELEPHONE is a voice down a phone line: only the 300 Hz to 3.4 kHz a narrowband line carries,
 * through three high-passes and three low-passes, a little of an earpiece's honk at 1.4 kHz, and the
 * crackle of a line driven a little hard - the drive measured against the voice's own peak, as the
 * megaphone's is, so a quiet recording crackles as a loud one does - folded to one channel.
 *
 * INTENSITY narrows the band and drives it harder together: from 200 Hz-4.8 kHz and no drive at all
 * at 0 to 455 Hz-2.4 kHz and 20 dB at 100, the level after it coming down [TELEPHONE_LEVEL_PER_DB]
 * for each decibel more, so a worse line is not a louder one. TONE moves the whole band by up to
 * [TELEPHONE_TONE_OCTAVES] either side: down is an old landline, up a tinny little speaker.
 *
 * Measured on 2026-10-09 with Windows' Zira and David voices at the middle of its sliders: 1.1 LU
 * under the voice and 1.3 over, and within 3.1 LU at every Intensity, peaking well under full scale.
 */
function telephone(settings: SoundEffectSettings): ComposeSoundEffect {
  const k = (setting(settings, 'intensity') - 50) / 50;
  const scale = Math.pow(2, ((setting(settings, 'tone') - 50) / 50) * TELEPHONE_TONE_OCTAVES);
  const low = Math.round(300 * Math.pow(2, 0.6 * k) * scale);
  const high = Math.round(3400 * Math.pow(2, -0.5 * k) * scale);
  const drive = 10 + 10 * k;
  return {
    mono: true,
    ops: [
      { op: 'highpass', hz: low, q: BUTTERWORTH_Q },
      { op: 'highpass', hz: low, q: BUTTERWORTH_Q },
      { op: 'lowpass', hz: high, q: BUTTERWORTH_Q },
      { op: 'peak', hz: Math.round(1400 * scale), q: 1.2, db: 5 },
      { op: 'drive', db: round3(drive), followMs: 300 },
      { op: 'highpass', hz: low, q: BUTTERWORTH_Q },
      { op: 'lowpass', hz: high, q: BUTTERWORTH_Q },
      { op: 'lowpass', hz: high, q: BUTTERWORTH_Q },
      { op: 'gain', db: round3(-3.5 - TELEPHONE_LEVEL_PER_DB * (drive - 10)) },
    ],
  };
}

/** How much quieter the telephone is put for each decibel more drive; see [telephone]. */
const TELEPHONE_LEVEL_PER_DB = 0.3;

/** How far the telephone's Tone takes its band, in octaves either side of the middle. */
const TELEPHONE_TONE_OCTAVES = 0.5;

/** Every effect, in the order the sheet offers them. */
export const SOUND_EFFECTS: readonly SoundEffectPreset[] = freezeAll(
  [
    {
      id: 'megaphone',
      label: 'Megaphone',
      controls: [
        { key: 'intensity', label: 'Intensity', name: 'Megaphone intensity', default: 50 },
        { key: 'tone', label: 'Tone', name: 'Megaphone tone', default: 50 },
      ],
      steps: megaphone,
    },
    {
      id: 'slowReverb',
      label: 'Slow + reverb',
      speed: { label: 'Slow', name: 'Slow speed', default: 0.8, min: MIN_AUDIO_EFFECT_SPEED, max: 1 },
      controls: [
        { key: 'reverb', label: 'Reverb', name: 'Reverb amount', default: 50 },
        { key: 'room', label: 'Room', name: 'Room size', default: 50 },
      ],
      steps: slowReverb,
    },
    {
      id: 'maleVoice',
      label: 'Male voice',
      controls: [
        { key: 'pitch', label: 'Pitch', name: 'Male voice pitch', default: 50 },
        { key: 'tone', label: 'Tone', name: 'Male voice tone', default: 50 },
      ],
      steps: maleVoice,
    },
    {
      id: 'femaleVoice',
      label: 'Female voice',
      controls: [
        { key: 'pitch', label: 'Pitch', name: 'Female voice pitch', default: 50 },
        { key: 'tone', label: 'Tone', name: 'Female voice tone', default: 50 },
      ],
      steps: femaleVoice,
    },
    {
      id: 'telephone',
      label: 'Telephone',
      controls: [
        { key: 'intensity', label: 'Intensity', name: 'Telephone intensity', default: 50 },
        { key: 'tone', label: 'Tone', name: 'Telephone tone', default: 50 },
      ],
      steps: telephone,
    },
  ].map((preset: Omit<SoundEffectPreset, 'effect'>): SoundEffectPreset => ({ ...preset, effect: preset.steps(defaultsOf(preset.controls)) })),
);

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

/**
 * A layer's settings as a manifest keeps them, for the effect `effectId`: a value for each of that
 * effect's sliders that is not at its default, held to the scale and to whole steps, in the order the
 * effect lists them - or `undefined`, the absent key, when there is none, so a layer whose sliders were
 * never moved stores none. A key the effect has no slider for is dropped, a later version's included,
 * as an id this version does not know is.
 */
export function normaliseSoundEffectSettings(effectId: unknown, value: unknown): Record<string, number> | undefined {
  const preset = soundEffectPreset(effectId);
  if (!preset || !isRecord(value)) return undefined;
  const kept: Record<string, number> = {};
  for (const control of preset.controls) {
    const raw = value[control.key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const held = Math.round(Math.min(SOUND_EFFECT_SETTING_MAX, Math.max(0, raw)));
    if (held !== control.default) kept[control.key] = held;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Every slider of `effectId` where `settings` leaves it: the stored value, or the default. Empty for none. */
export function soundEffectSettings(effectId: unknown, settings: unknown): Record<string, number> {
  const preset = soundEffectPreset(effectId);
  if (!preset) return {};
  return { ...defaultsOf(preset.controls), ...(normaliseSoundEffectSettings(preset.id, settings) ?? {}) };
}

/** Whether two layers' stored settings are the same, a missing value being the default either way. */
export function sameSoundEffectSettings(a: SoundEffectSettings | undefined, b: SoundEffectSettings | undefined): boolean {
  const x = a ?? {};
  const y = b ?? {};
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const key of keys) if (x[key] !== y[key]) return false;
  return true;
}

/**
 * What `effectId` at `settings` is made of, as the wire carries it: a NEW object, so nothing that
 * holds a spec can change an effect for every post after it. Null for none and for an id this
 * version does not know.
 */
export function soundEffectSteps(effectId: unknown, settings?: unknown): ComposeSoundEffect | null {
  const preset = soundEffectPreset(effectId);
  return preset ? preset.steps(soundEffectSettings(preset.id, settings)) : null;
}

function defaultsOf(controls: readonly SoundEffectControl[]): Record<string, number> {
  return Object.fromEntries(controls.map(control => [control.key, control.default]));
}

/** A setting `steps` was handed, which [soundEffectSettings] has made sure is there. */
function setting(settings: SoundEffectSettings, key: string): number {
  return settings[key] ?? 0;
}

/** Three places: what a gain on the wire needs, and no float dust in a spec somebody reads. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
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
  reverb: [
    { name: 'decayMs', min: 100, max: 20_000 },
    { name: 'dampHz', min: 10, max: 20_000 },
    { name: 'wet', min: 0, max: 1 },
    { name: 'dry', min: 0, max: 1 },
  ],
  pitch: [
    { name: 'semitones', min: -12, max: 12 },
    { name: 'formant', min: -12, max: 12 },
  ],
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

/** Jezar's Freeverb tunings, in samples at [TUNING_RATE]: the combs' delays, then the allpasses'. */
const COMB_TUNING: readonly number[] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING: readonly number[] = [556, 441, 341, 225];
const TUNING_RATE = 44_100;
/** How many samples, at [TUNING_RATE], each channel's delays are longer than the one before it's. */
const STEREO_SPREAD = 23;

/**
 * The reverb, exactly as [ComposeSoundEffect] writes it down: Freeverb's combs and allpasses, every
 * comb tuned to fall 60 dB in the same time and fed in proportion, so the room's length and its level
 * are two separate numbers. Its buffers are made here, once, and a sample only reads and writes them.
 */
class Reverb implements Step {
  private readonly combs: Float64Array[];
  private readonly combAt: Int32Array;
  /** Each comb's `g` and `c`, and its damped value `f`. */
  private readonly feedback: Float64Array;
  private readonly take: Float64Array;
  private readonly damped: Float64Array;
  private readonly allpasses: Float64Array[];
  private readonly allpassAt: Int32Array;
  private readonly d: number;
  private readonly undamped: number;
  private readonly wet: number;
  private readonly dry: number;

  constructor(op: Extract<SoundOp, { op: 'reverb' }>, rate: number, channel: number) {
    this.wet = op.wet;
    this.dry = op.dry;
    const delay = (tuning: number) => Math.max(1, Math.floor(((tuning + STEREO_SPREAD * channel) * rate) / TUNING_RATE + 0.5));
    const combLengths = COMB_TUNING.map(delay);
    this.combs = combLengths.map(length => new Float64Array(length));
    this.combAt = new Int32Array(combLengths.length);
    this.feedback = Float64Array.from(combLengths, length => Math.pow(10, (-3 * length) / ((rate * op.decayMs) / 1000)));
    this.take = Float64Array.from(this.feedback, g => Math.sqrt((1 - g * g) / 8));
    this.damped = new Float64Array(combLengths.length);
    this.allpasses = ALLPASS_TUNING.map(tuning => new Float64Array(delay(tuning)));
    this.allpassAt = new Int32Array(ALLPASS_TUNING.length);
    this.d = Math.exp((-2 * Math.PI * Math.min(op.dampHz, MAX_HZ_OF_RATE * rate)) / rate);
    this.undamped = 1 - this.d;
  }

  run(x: number): number {
    let r = 0;
    for (let i = 0; i < this.combs.length; i++) {
      const buffer = this.combs[i]!;
      const p = this.combAt[i]!;
      const o = buffer[p]!;
      let f = this.undamped * o + this.d * this.damped[i]!;
      if (f < TINY && f > -TINY) f = 0;
      this.damped[i] = f;
      let stored = this.take[i]! * x + this.feedback[i]! * f;
      if (stored < TINY && stored > -TINY) stored = 0;
      buffer[p] = stored;
      this.combAt[i] = p + 1 === buffer.length ? 0 : p + 1;
      r = r + o;
    }
    for (let j = 0; j < this.allpasses.length; j++) {
      const buffer = this.allpasses[j]!;
      const p = this.allpassAt[j]!;
      const b = buffer[p]!;
      let v = r + 0.5 * b;
      if (v < TINY && v > -TINY) v = 0;
      buffer[p] = v;
      r = b - 0.5 * v;
      this.allpassAt[j] = p + 1 === buffer.length ? 0 : p + 1;
    }
    return this.dry * x + this.wet * r;
  }
}

/** A peak marks the pitch step's envelope when no bin this close to it, in Hz, is louder. */
const ENVELOPE_REACH_HZ = 100;
/**
 * And when it is no more than 60 dB, in power, under the frame's loudest peak: a tone's spectrum falls
 * to the noise of its own rounding far below it, and an envelope run down to that would take the tone
 * away wherever it moved.
 */
const ENVELOPE_FLOOR = 1e-6;
/** The most the pitch step's envelope lifts a peak by, 20 dB, and lowers one by: a peak moved out of a hush stays quiet. */
const PITCH_MAX_GAIN = 10;
/** What a frame's spectrum loses to its two windows overlapping four times: a periodic Hann's squares sum to 1.5. */
const HANN_OVERLAP = 1.5;

/** How long the pitch step's frame is, in ms: its output is that late, and runs on that long after its input. */
export const PITCH_FRAME_MS = 40;

/**
 * The pitch step's frame at `rate`, as [ComposeSoundEffect] sets it: it moves on `hop` samples at a
 * time, 10 ms, and reads `length` of them, four hops, [PITCH_FRAME_MS], padded to a transform of
 * `size`. Its output is `length - 1` samples behind its input.
 */
export function pitchFrame(rate: number): { length: number; hop: number; size: number } {
  const hop = Math.max(1, Math.floor(rate / 100 + 0.5));
  const length = 4 * hop;
  let size = 2;
  while (size < length) size *= 2;
  return { length, hop, size };
}

/**
 * The pitch step, exactly as [ComposeSoundEffect] writes it down: a phase vocoder that moves every peak
 * of the spectrum to its new pitch with the bins around it locked to it, and weighs each by the
 * spectrum's envelope where it lands, so the voice's resonances move by `formant` whatever the pitch
 * does. Every buffer is made here, once; a sample only reads and writes them.
 */
class Pitch implements Step {
  private readonly ratio: number;
  private readonly formant: number;
  private readonly length: number;
  private readonly hop: number;
  private readonly size: number;
  private readonly half: number;
  /** How many bins either side a peak has to be the loudest of to mark the envelope. */
  private readonly reach: number;
  /** `sqrt(ratio / formant)`: what keeps the sound as loud with its peaks spread or crowded. */
  private readonly loudness: number;
  /** What a bin's centre frequency turns through in a hop, per bin: `2 * PI * hop / size`. */
  private readonly turn: number;
  private readonly window: Float64Array;
  /** The window again, with the transform's and the overlap's scale in it. */
  private readonly synthesis: Float64Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  /** The last `length` inputs, the oldest at `at`. */
  private readonly input: Float64Array;
  private at = 0;
  /** Inputs since the last frame. */
  private count = 0;
  /** The overlap-add, from the oldest sample a frame still reaches; and the `hop` it finished last. */
  private readonly sum: Float64Array;
  private readonly ready: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  /** The frame before's spectrum, as it was read and as it was made, bins 0 to `half`. */
  private readonly lastRe: Float64Array;
  private readonly lastIm: Float64Array;
  private outRe: Float64Array;
  private outIm: Float64Array;
  private lastOutRe: Float64Array;
  private lastOutIm: Float64Array;
  private readonly power: Float64Array;
  private readonly peaks: Int32Array;
  /** The peaks that mark the envelope, and the log of each one's power. */
  private readonly marks: Int32Array;
  private readonly levels: Float64Array;
  private markCount = 0;

  constructor(op: Extract<SoundOp, { op: 'pitch' }>, rate: number) {
    this.ratio = Math.pow(2, op.semitones / 12);
    this.formant = Math.pow(2, op.formant / 12);
    const frame = pitchFrame(rate);
    this.length = frame.length;
    this.hop = frame.hop;
    this.size = frame.size;
    this.half = frame.size / 2;
    this.reach = Math.max(1, Math.floor((ENVELOPE_REACH_HZ * this.size) / rate + 0.5));
    this.loudness = Math.sqrt(this.ratio / this.formant);
    this.turn = (2 * Math.PI * this.hop) / this.size;
    this.window = new Float64Array(this.length);
    this.synthesis = new Float64Array(this.length);
    for (let n = 0; n < this.length; n++) {
      this.window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / this.length);
      this.synthesis[n] = this.window[n]! / (this.size * HANN_OVERLAP);
    }
    this.cos = new Float64Array(this.half);
    this.sin = new Float64Array(this.half);
    for (let k = 0; k < this.half; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / this.size);
      this.sin[k] = Math.sin((2 * Math.PI * k) / this.size);
    }
    this.input = new Float64Array(this.length);
    this.sum = new Float64Array(this.length);
    this.ready = new Float64Array(this.hop);
    this.re = new Float64Array(this.size);
    this.im = new Float64Array(this.size);
    const bins = this.half + 1;
    this.lastRe = new Float64Array(bins);
    this.lastIm = new Float64Array(bins);
    this.outRe = new Float64Array(bins);
    this.outIm = new Float64Array(bins);
    this.lastOutRe = new Float64Array(bins);
    this.lastOutIm = new Float64Array(bins);
    this.power = new Float64Array(bins);
    this.peaks = new Int32Array(bins);
    this.marks = new Int32Array(bins);
    this.levels = new Float64Array(bins);
  }

  run(x: number): number {
    this.input[this.at] = x;
    this.at = this.at + 1 === this.length ? 0 : this.at + 1;
    this.count++;
    if (this.count === this.hop) {
      this.count = 0;
      this.frame();
    }
    return this.ready[this.count]!;
  }

  private frame(): void {
    const { length, size, half, re, im, power } = this;
    const mid = length / 2;
    // The frame turned so its middle is the transform's first sample: a peak's neighbours then carry
    // its phase rather than a turn each, which is what lets them follow it.
    re.fill(0);
    im.fill(0);
    let p = this.at;
    for (let n = 0; n < length; n++) {
      re[n < mid ? size - mid + n : n - mid] = this.input[p]! * this.window[n]!;
      p = p + 1 === length ? 0 : p + 1;
    }
    fft(re, im, this.cos, this.sin, false);

    for (let k = 0; k <= half; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;

    this.outRe.fill(0);
    this.outIm.fill(0);
    let peaks = 0;
    for (let k = 1; k < half; k++) {
      const v = power[k]!;
      if (v > power[k - 1]! && (k < 2 || v > power[k - 2]!) && v >= power[k + 1]! && (k + 2 > half || v >= power[k + 2]!)) this.peaks[peaks++] = k;
    }
    // The envelope runs through the peaks nothing near them outshines - a voice's harmonics, and not
    // the ripples between them - straight from one to the next in decibels.
    let loudest = 0;
    for (let i = 0; i < peaks; i++) if (power[this.peaks[i]!]! > loudest) loudest = power[this.peaks[i]!]!;
    const floor = loudest * ENVELOPE_FLOOR;
    let marks = 0;
    for (let i = 0; i < peaks; i++) {
      const k = this.peaks[i]!;
      const v = power[k]!;
      if (v < floor) continue;
      const a = k - this.reach > 0 ? k - this.reach : 0;
      const b = k + this.reach < half ? k + this.reach : half;
      let top = true;
      for (let m = a; m <= b; m++) {
        if (power[m]! > v) {
          top = false;
          break;
        }
      }
      if (top) {
        this.marks[marks] = k;
        this.levels[marks] = Math.log(v);
        marks++;
      }
    }
    this.markCount = marks;
    // Each peak takes the bins from the last one's edge to the quietest bin before the next.
    let from = 1;
    for (let i = 0; i < peaks; i++) {
      const k = this.peaks[i]!;
      let to = half - 1;
      if (i + 1 < peaks) {
        const next = this.peaks[i + 1]!;
        to = k + 1;
        for (let b = k + 2; b < next; b++) if (power[b]! < power[to]!) to = b;
      }
      this.move(k, from, to);
      from = to + 1;
    }

    for (let k = 0; k <= half; k++) {
      this.lastRe[k] = re[k]!;
      this.lastIm[k] = im[k]!;
    }
    re.fill(0);
    im.fill(0);
    for (let k = 1; k < half; k++) {
      re[k] = this.outRe[k]!;
      im[k] = this.outIm[k]!;
      re[size - k] = this.outRe[k]!;
      im[size - k] = -this.outIm[k]!;
    }
    fft(re, im, this.cos, this.sin, true);
    for (let n = 0; n < length; n++) this.sum[n] = this.sum[n]! + re[n < mid ? size - mid + n : n - mid]! * this.synthesis[n]!;

    const hop = this.hop;
    for (let n = 0; n < hop; n++) this.ready[n] = this.sum[n]!;
    this.sum.copyWithin(0, hop);
    this.sum.fill(0, length - hop);
    const outRe = this.outRe;
    const outIm = this.outIm;
    this.outRe = this.lastOutRe;
    this.outIm = this.lastOutIm;
    this.lastOutRe = outRe;
    this.lastOutIm = outIm;
  }

  /** Bins `from` to `to`, the region of the peak at bin `k`, moved to where its pitch goes. */
  private move(k: number, from: number, to: number): void {
    const { re, im, half, ratio, turn } = this;
    const phase = Math.atan2(im[k]!, re[k]!);
    let d = phase - Math.atan2(this.lastIm[k]!, this.lastRe[k]!) - k * turn;
    d -= 2 * Math.PI * Math.floor(d / (2 * Math.PI) + 0.5);
    // Its true frequency, in bins, from how far its phase turned since the frame before.
    const bin = k + d / turn;
    const shift = Math.floor(bin * (ratio - 1) + 0.5);
    const j = k + shift;
    if (j < 1 || j >= half) return;
    // Carried on from the phase the frame before left at its new bin, so a held note stays one note.
    const lastRe = this.lastOutRe[j]!;
    const lastIm = this.lastOutIm[j]!;
    const theta = lastRe !== 0 || lastIm !== 0 ? Math.atan2(lastIm, lastRe) + bin * ratio * turn - phase : 0;
    // As loud as the envelope is where its resonances have moved to, against where it came from.
    const lift = Math.exp(0.5 * (this.level(j / this.formant) - this.level(k))) * this.loudness;
    const g = lift > PITCH_MAX_GAIN ? PITCH_MAX_GAIN : lift < 1 / PITCH_MAX_GAIN ? 1 / PITCH_MAX_GAIN : lift;
    const c = g * Math.cos(theta);
    const s = g * Math.sin(theta);
    for (let i = from; i <= to; i++) {
      const at = i + shift;
      if (at < 1 || at >= half) continue;
      const xr = re[i]!;
      const xi = im[i]!;
      this.outRe[at] = this.outRe[at]! + (xr * c - xi * s);
      this.outIm[at] = this.outIm[at]! + (xr * s + xi * c);
    }
  }

  /**
   * The log of the envelope's power at bin `at`, which need not be whole: straight between the marks
   * either side of it, the nearest one's own beyond the first and the last, and 0 with no mark at all.
   */
  private level(at: number): number {
    const count = this.markCount;
    const marks = this.marks;
    const levels = this.levels;
    if (count === 0) return 0;
    if (at <= marks[0]!) return levels[0]!;
    if (at >= marks[count - 1]!) return levels[count - 1]!;
    let lo = 0;
    let hi = count - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (marks[m]! <= at) lo = m;
      else hi = m;
    }
    const t = (at - marks[lo]!) / (marks[hi]! - marks[lo]!);
    return levels[lo]! + t * (levels[hi]! - levels[lo]!);
  }
}

/**
 * The discrete Fourier transform of `re + i im`, in place: radix 2, its length a power of two, with
 * `cos` and `sin` of `2 * PI * k / length` for the first half of `k`. Forward turns by `e^-i`, inverse
 * by `e^+i`, and neither scales.
 */
function fft(re: Float64Array, im: Float64Array, cos: Float64Array, sin: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const r = re[i]!;
      re[i] = re[j]!;
      re[j] = r;
      const m = im[i]!;
      im[i] = im[j]!;
      im[j] = m;
    }
  }
  for (let width = 2; width <= n; width *= 2) {
    const halfWidth = width / 2;
    const step = n / width;
    for (let i = 0; i < n; i += width) {
      for (let k = 0; k < halfWidth; k++) {
        const wr = cos[k * step]!;
        const wi = inverse ? sin[k * step]! : -sin[k * step]!;
        const a = i + k;
        const b = a + halfWidth;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

/** The step `op` stands for at `rate`, on the channel numbered `channel` - which only a reverb asks. */
function stepFor(op: SoundOp, rate: number, channel: number): Step {
  switch (op.op) {
    case 'pitch':
      return new Pitch(op, rate);
    case 'drive':
      return new Drive(Math.pow(10, op.db / 20), op.followMs ? Math.exp(-1000 / (op.followMs * rate)) : null);
    case 'gain':
      return new Gain(Math.pow(10, op.db / 20));
    case 'reverb':
      return new Reverb(op, rate, channel);
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
      chain = this.effect.ops.map(op => stepFor(op, this.sampleRate, index));
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
