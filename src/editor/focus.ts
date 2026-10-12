import { MAX_FOCUS_BLUR, MAX_FOCUS_KEYS, type ComposeFocus, type ComposeFocusSubject, type SubjectInfo } from '../video-composer/definitions';
import type { EditClip, EditFocus, EditFocusChange, FocusSubjects } from './edit-manifest';

/**
 * A clip's focus: which of its subjects stay sharp, what happens to everything else, and when the
 * focus moves from one subject to another.
 *
 * The manifest keeps what the customer CHOSE - "the main subject", "everybody", "the two on the
 * left" - in the subject ids of the footage's own subject track, and how soft, how grey and how dark
 * the rest is on 0..1 scales. [compileFocus] turns that, with the track's list of subjects, into the
 * keys a render is handed ([ComposeFocus]), which is where 'main' and 'all' become ids and a change
 * of focus becomes a straight line between two sets of them.
 */

/** How soft the world is on a focus nobody has touched: about a 1.5% sigma, a phone's portrait mode. */
export const DEFAULT_FOCUS_BLUR = 0.5;

/**
 * The sigma a [EditFocus.blur] of 1 asks for, a fraction of the source's shorter side: 32 pixels on
 * 1080p footage, as soft as a background can go and still read as a place rather than a wash.
 */
export const FOCUS_MAX_SIGMA = 0.03;

/** How long a change of focus takes when it says nothing: a pull an eye can follow, and short of a beat at 120 BPM. */
export const DEFAULT_FOCUS_PULL_MS = 500;

/** The longest pull a change may ask for. Past three seconds a pull is a fade nobody is waiting for. */
export const MAX_FOCUS_PULL_MS = 3000;

/** The most changes of focus one clip keeps, far past anything a sheet is used for. */
export const MAX_FOCUS_CHANGES = 20;

/** The subject track a clip's focus is drawn from: the file, and the subjects it found, strongest first. */
export interface SubjectTrackRef {
  uri: string;
  subjects: readonly Pick<SubjectInfo, 'id'>[];
}

/** A new focus: the main subject sharp and everything else softened, nothing grey, nothing dark. */
export function defaultFocus(): EditFocus {
  return { subjects: 'main', blur: DEFAULT_FOCUS_BLUR };
}

/**
 * A stored focus as the manifest keeps one, or `undefined` for anything that is not one. Numbers
 * are held to their ranges, a subject list to unique ids 1..255 in order, the changes to their
 * times in order - one per time, the later kept - and every key that says nothing is left off, so
 * a focus with no grey carries no `mono` and one whose pulls are all the default carries no
 * `pullMs`.
 */
export function normaliseFocus(value: unknown): EditFocus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const focus: EditFocus = {
    subjects: normaliseFocusSubjects(raw['subjects']) ?? 'main',
    blur: unit(raw['blur'], DEFAULT_FOCUS_BLUR),
  };
  const mono = unit(raw['mono'], 0);
  if (mono > 0) focus.mono = mono;
  const dim = unit(raw['dim'], 0);
  if (dim > 0) focus.dim = dim;
  if (raw['invert'] === true) focus.invert = true;
  const changes = normaliseFocusChanges(raw['changes']);
  if (changes.length > 0) focus.changes = changes;
  return focus;
}

/** `all`, `main`, or unique whole ids 1..255 in increasing order; `undefined` for anything else. */
export function normaliseFocusSubjects(value: unknown): FocusSubjects | undefined {
  if (value === 'all' || value === 'main') return value;
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<number>();
  for (const id of value) if (typeof id === 'number' && Number.isInteger(id) && id >= 1 && id <= 255) ids.add(id);
  return [...ids].sort((a, b) => a - b);
}

function normaliseFocusChanges(value: unknown): EditFocusChange[] {
  if (!Array.isArray(value)) return [];
  const byTime = new Map<number, EditFocusChange>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const atMs = raw['atMs'];
    const subjects = normaliseFocusSubjects(raw['subjects']);
    if (typeof atMs !== 'number' || !Number.isFinite(atMs) || !subjects) continue;
    const change: EditFocusChange = { atMs: Math.max(0, Math.round(atMs)), subjects };
    const pull = raw['pullMs'];
    if (typeof pull === 'number' && Number.isFinite(pull)) {
      const pullMs = Math.round(Math.min(MAX_FOCUS_PULL_MS, Math.max(0, pull)));
      if (pullMs !== DEFAULT_FOCUS_PULL_MS) change.pullMs = pullMs;
    }
    // One change per instant: two at one time would be a pull nobody can see, and the later one is
    // what a sheet that wrote them both meant.
    byTime.delete(change.atMs);
    byTime.set(change.atMs, change);
  }
  return [...byTime.values()].sort((a, b) => a.atMs - b.atMs).slice(0, MAX_FOCUS_CHANGES);
}

/** How long a change takes: its own `pullMs`, or [DEFAULT_FOCUS_PULL_MS]. */
export function focusPullMs(change: Pick<EditFocusChange, 'pullMs'>): number {
  return change.pullMs ?? DEFAULT_FOCUS_PULL_MS;
}

/** Whether the focus changes the picture at all: some blur, some grey or some dark. */
export function focusChangesPicture(focus: EditFocus | undefined): boolean {
  return !!focus && (focus.blur > 0 || (focus.mono ?? 0) > 0 || (focus.dim ?? 0) > 0);
}

/** Two focuses that say the same thing, key for key. */
export function sameFocus(a: EditFocus | undefined, b: EditFocus | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.blur !== b.blur || (a.mono ?? 0) !== (b.mono ?? 0) || (a.dim ?? 0) !== (b.dim ?? 0) || !!a.invert !== !!b.invert) return false;
  if (!sameSubjects(a.subjects, b.subjects)) return false;
  const x = a.changes ?? [];
  const y = b.changes ?? [];
  return x.length === y.length && x.every((change, i) => change.atMs === y[i]!.atMs && focusPullMs(change) === focusPullMs(y[i]!) && sameSubjects(change.subjects, y[i]!.subjects));
}

export function sameSubjects(a: FocusSubjects, b: FocusSubjects): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Which choice of subjects is in effect at source time `sourceMs`: `-1` for the focus's own
 * [EditFocus.subjects], which holds until its first change, or the index of the last change at or
 * before the instant. What a sheet edits when the customer taps a subject with the playhead there.
 */
export function focusEntryAt(focus: EditFocus, sourceMs: number): number {
  const changes = focus.changes ?? [];
  let entry = -1;
  for (let i = 0; i < changes.length; i++) if (changes[i]!.atMs <= sourceMs) entry = i;
  return entry;
}

/** The choice of subjects of an entry [focusEntryAt] named. */
export function focusEntrySubjects(focus: EditFocus, entry: number): FocusSubjects {
  return entry < 0 ? focus.subjects : (focus.changes?.[entry]?.subjects ?? focus.subjects);
}

/**
 * The ids a choice stands for in a track: every subject for `all`, the strongest for `main` - the
 * track lists them strongest first - and of a list, the ids the track has.
 */
export function resolveFocusSubjects(subjects: FocusSubjects, track: Pick<SubjectTrackRef, 'subjects'>): number[] {
  const ids = track.subjects.map(subject => subject.id);
  if (subjects === 'all') return ids;
  if (subjects === 'main') return ids.length > 0 ? [ids[0]!] : [];
  const known = new Set(ids);
  return subjects.filter(id => known.has(id));
}

/**
 * The focus a render is handed for this segment, or null for one it changes nothing on: no focus, a
 * focus with no blur, no grey and no dark, or footage in which nothing stood out - where `main` and
 * `all` name nobody, and softening the whole frame would be a look nobody chose.
 *
 * Every change of focus becomes two keys: where it starts, the subjects as they were, and where its
 * pull ends, the subjects as it chose them, with a straight line between - which the contract's ease
 * (`e = m * m * (3 - 2 * m)`) turns into a pull that starts and settles gently. A change made before
 * the last one had finished pulling starts from wherever that one had got to. The keys are cut to the
 * segment's own trim, so a split puts on each piece only the changes it shows, and a picture's are
 * moved to start at 0, where its wire trim does ([ComposeClip.image]).
 */
export function compileFocus(edit: Pick<EditClip, 'focus' | 'inMs' | 'outMs' | 'image'>, track: SubjectTrackRef): ComposeFocus | null {
  const focus = edit.focus;
  if (!focusChangesPicture(focus) || !focus || track.subjects.length === 0) return null;

  // Every id any choice stands for, so each gets a value at every key.
  const choices = [focus.subjects, ...(focus.changes ?? []).map(change => change.subjects)];
  const sets = choices.map(choice => new Set(resolveFocusSubjects(choice, track)));
  const ids = [...new Set(sets.flatMap(set => [...set]))].sort((a, b) => a - b);
  const weights = (set: ReadonlySet<number>): number[] => ids.map(id => (set.has(id) ? 1 : 0));

  // The whole line from the start of the file, then cut to the segment.
  let keys: FocusKey[] = [{ atMs: 0, values: weights(sets[0]!) }];
  (focus.changes ?? []).forEach((change, k) => {
    const start = change.atMs;
    const from = valuesAt(keys, start);
    keys = keys.filter(key => key.atMs <= start);
    keys.push({ atMs: start, values: from });
    keys.push({ atMs: start + focusPullMs(change), values: weights(sets[k + 1]!) });
  });
  const shift = edit.image ? edit.inMs : 0;
  keys = cutTo(keys, edit.inMs, Math.max(edit.inMs, edit.outMs)).map(key => ({ atMs: Math.round(key.atMs - shift), values: key.values }));
  if (keys.length > MAX_FOCUS_KEYS) keys = keys.slice(0, MAX_FOCUS_KEYS);
  // One key holds for ever, so a line that never moves needs no more.
  if (keys.every(key => sameValues(key.values, keys[0]!.values))) keys = [keys[0]!];

  const subjects: ComposeFocusSubject[] = [];
  ids.forEach((id, i) => {
    const values = keys.map(key => round4(key.values[i]!));
    if (values.some(value => value > 0)) subjects.push({ id, focus: values });
  });

  const wire: ComposeFocus = {
    uri: track.uri,
    atMs: keys.map(key => key.atMs),
    subjects,
    blur: round4(focus.blur * FOCUS_MAX_SIGMA),
  };
  // Only what says something, for the reason a clip's crop is left off when it has none.
  if (focus.mono) wire.mono = round4(focus.mono);
  if (focus.dim) wire.dim = round4(focus.dim);
  if (focus.invert) wire.invert = true;
  return wire;
}

/**
 * What [normaliseComposeFocus] refuses a focus with. `field` is the part that broke - `uri`,
 * `atMs[3]`, `subjects[1].id` - or empty for the focus as a whole, and `detail` is the words a refusal
 * of the whole adds after its path. A parser turns the pair into its own `invalid_spec:<path>`, with
 * the clip's path in front.
 */
export class FocusError extends Error {
  constructor(
    readonly field: string,
    readonly detail = '',
  ) {
    super(`focus${field ? `.${field}` : ''}${detail}`);
    this.name = 'FocusError';
  }
}

/**
 * A clip's focus off the wire made safe to draw: the parser rules [ComposeFocus] states, shared by the
 * web engine and the tests, and checked by the Kotlin and Swift parsers in the same order - `uri`,
 * then `atMs`, then each subject's `id` and `focus` in turn, then `blur`, `mono` and `dim`. A NEW
 * object, every value clamped and every key it does not know left behind; `null` for an absent focus
 * and for one that changes nothing. Throws [FocusError] for a focus no engine could honour.
 */
export function normaliseComposeFocus(value: unknown): ComposeFocus | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new FocusError('');
  const uri = value['uri'];
  if (typeof uri !== 'string' || uri.length === 0) throw new FocusError('uri');

  const times = value['atMs'];
  if (!Array.isArray(times)) throw new FocusError('atMs');
  if (times.length === 0 || times.length > MAX_FOCUS_KEYS) throw new FocusError('atMs', ` must have 1 to ${MAX_FOCUS_KEYS} keys`);
  const atMs: number[] = [];
  times.forEach((t: unknown, i) => {
    if (typeof t !== 'number' || !Number.isFinite(t) || (i > 0 && t < atMs[i - 1]!)) throw new FocusError(`atMs[${i}]`);
    atMs.push(t);
  });

  const rawSubjects = value['subjects'];
  if (!Array.isArray(rawSubjects)) throw new FocusError('subjects');
  const seen = new Set<number>();
  const subjects: ComposeFocusSubject[] = rawSubjects.map((raw: unknown, i) => {
    if (!isRecord(raw)) throw new FocusError(`subjects[${i}]`);
    const id = raw['id'];
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 255 || seen.has(id)) throw new FocusError(`subjects[${i}].id`);
    seen.add(id);
    const levels = raw['focus'];
    if (!Array.isArray(levels) || levels.length !== atMs.length) throw new FocusError(`subjects[${i}].focus`);
    const focus = levels.map((level: unknown, k) => {
      if (typeof level !== 'number' || !Number.isFinite(level)) throw new FocusError(`subjects[${i}].focus[${k}]`);
      return Math.min(1, Math.max(0, level));
    });
    return { id, focus };
  });

  const look = (name: 'blur' | 'mono' | 'dim', max: number): number => {
    const raw = value[name];
    if (raw === undefined || raw === null) return 0;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new FocusError(name);
    return Math.min(max, Math.max(0, raw));
  };
  const blur = look('blur', MAX_FOCUS_BLUR);
  const mono = look('mono', 1);
  const dim = look('dim', 1);
  if (blur === 0 && mono === 0 && dim === 0) return null;

  const focus: ComposeFocus = { uri, atMs, subjects, blur };
  if (mono > 0) focus.mono = mono;
  if (dim > 0) focus.dim = dim;
  if (value['invert'] === true) focus.invert = true;
  return focus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface FocusKey {
  atMs: number;
  values: number[];
}

/** The line at `atMs`: the key before held, a straight line between two, the last key held after. */
function valuesAt(keys: readonly FocusKey[], atMs: number): number[] {
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.atMs <= atMs) i++;
  const a = keys[i]!;
  const b = keys[i + 1];
  if (!b || !(atMs > a.atMs)) return [...a.values];
  const t = (atMs - a.atMs) / (b.atMs - a.atMs);
  return a.values.map((value, j) => value + (b.values[j]! - value) * t);
}

/** The keys inside `from..to`, with the line's value at each end put on as a key of its own. */
function cutTo(keys: readonly FocusKey[], from: number, to: number): FocusKey[] {
  const inside = keys.filter(key => key.atMs > from && key.atMs < to);
  return [{ atMs: from, values: valuesAt(keys, from) }, ...inside, { atMs: to, values: valuesAt(keys, to) }];
}

function sameValues(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]!) < 1e-6);
}

function unit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? round4(Math.min(1, Math.max(0, value))) : fallback;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
