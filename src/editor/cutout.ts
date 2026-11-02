import { MAX_CUTOUT_OUTLINE, type ComposeCutout, type ComposeCutoutOutline, type MatteTarget } from '../video-composer/definitions';
import type { EditClip, EditCutout, EditCutoutOutline } from './edit-manifest';

/**
 * A clip's or a photo's background taken away: what the customer CHOSE - keep whatever stands out or
 * only the people, how soft the edge is and where it sits, what fills the space, a line round the
 * subject - kept on 0..1 scales and `#rrggbb` colours, and [compileCutout] turning it, with the matte
 * track `findMatte` wrote for the source, into what a render is handed ([ComposeCutout]).
 */

/** How wide an outline is when the customer first turns one on: a sticker's border, 30% of the widest. */
export const DEFAULT_OUTLINE_WIDTH = 0.3;

/** The outline a sticker has: white. */
export const DEFAULT_OUTLINE_COLOR = '#ffffff';

/**
 * Below this much of the frame, on average, a matte found nothing worth keeping: a cutout of it would
 * take the whole picture away, which is a look nobody chose. The sheet says so instead.
 */
export const MIN_CUTOUT_COVERAGE = 0.002;

/** The matte track a cutout is drawn from: the file, and how much of the frame its subject covers. */
export interface MatteRef {
  uri: string;
  coverage: number;
}

/** What a cutout keeps, as the matte it needs is asked for: `subject` unless it says `people`. */
export function cutoutTarget(cutout: Pick<EditCutout, 'target'> | undefined): MatteTarget {
  return cutout?.target === 'people' ? 'people' : 'subject';
}

/**
 * The name a source's matte is filed under, by the clip key or photo it is of and what it keeps: two
 * segments of one source keeping the same thing share one matte, and keeping the people instead is
 * another search.
 */
export function matteKey(source: string, target: MatteTarget): string {
  return `${target}:${source}`;
}

/**
 * A new cutout keeping `target` - whatever stands out unless it says people - with everything else
 * see-through and the edge as the refinement leaves it.
 */
export function defaultCutout(target: MatteTarget = 'subject'): EditCutout {
  return target === 'people' ? { target: 'people' } : {};
}

/**
 * A stored cutout as the manifest keeps one, or `undefined` for anything that is not one. Numbers are
 * held to their ranges and every key that says nothing is left off, so a cutout with a crisp edge
 * carries no `soft` and one with no fill no `fill`.
 */
export function normaliseCutout(value: unknown): EditCutout | undefined {
  if (!isRecord(value)) return undefined;
  const cutout: EditCutout = {};
  if (value['target'] === 'people') cutout.target = 'people';
  const soft = unitOr(value['soft'], 0, 0, 1);
  if (soft > 0) cutout.soft = soft;
  const shift = unitOr(value['shift'], 0, -1, 1);
  if (shift !== 0) cutout.shift = shift;
  const fill = hexColour(value['fill']);
  if (fill) cutout.fill = fill;
  const outline = normaliseOutline(value['outline']);
  if (outline) cutout.outline = outline;
  if (value['shadow'] === true) cutout.shadow = true;
  return cutout;
}

function normaliseOutline(value: unknown): EditCutoutOutline | undefined {
  if (!isRecord(value)) return undefined;
  const width = unitOr(value['width'], DEFAULT_OUTLINE_WIDTH, 0, 1);
  if (width <= 0) return undefined;
  return { color: hexColour(value['color']) ?? DEFAULT_OUTLINE_COLOR, width };
}

/** Two cutouts that say the same thing, key for key. */
export function sameCutout(a: EditCutout | undefined, b: EditCutout | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    cutoutTarget(a) === cutoutTarget(b) &&
    (a.soft ?? 0) === (b.soft ?? 0) &&
    (a.shift ?? 0) === (b.shift ?? 0) &&
    (a.fill ?? '') === (b.fill ?? '') &&
    !!a.shadow === !!b.shadow &&
    (a.outline?.color ?? '') === (b.outline?.color ?? '') &&
    (a.outline?.width ?? 0) === (b.outline?.width ?? 0)
  );
}

/**
 * The cutout a render is handed for this segment, or null for one it does nothing for: no cutout, or a
 * matte in which nothing stood out - whose cutout would take the whole picture away. A photo layer's
 * shadow is no part of it: that is drawn into the layer's own bitmap, and a clip has none.
 */
export function compileCutout(edit: Pick<EditClip, 'cutout'>, matte: MatteRef): ComposeCutout | null {
  const cutout = edit.cutout;
  if (!cutout || !(matte.coverage >= MIN_CUTOUT_COVERAGE)) return null;
  const wire: ComposeCutout = { uri: matte.uri };
  // Only what says something, for the reason a clip's crop is left off when it has none.
  if (cutout.soft) wire.soft = round4(cutout.soft);
  if (cutout.shift) wire.shift = round4(cutout.shift);
  if (cutout.fill) wire.fill = rgbOf(cutout.fill);
  if (cutout.outline && cutout.outline.width > 0) {
    wire.outline = { color: rgbOf(cutout.outline.color), width: round4(cutout.outline.width * MAX_CUTOUT_OUTLINE) };
  }
  return wire;
}

/**
 * What [normaliseComposeCutout] refuses a cutout with. `field` is the part that broke - `uri`,
 * `outline.width` - or empty for the cutout as a whole. A parser turns it into its own
 * `invalid_spec:<path>`, with the clip's path in front.
 */
export class CutoutError extends Error {
  constructor(readonly field: string) {
    super(`cutout${field ? `.${field}` : ''}`);
    this.name = 'CutoutError';
  }
}

/**
 * A clip's cutout off the wire made safe to draw: the parser rules [ComposeCutout] states, shared by
 * the web engine and the tests, and checked by the Kotlin parser in the same order - `uri`, `soft`,
 * `shift`, `fill`, then `outline`'s `color` and `width`. A NEW object, every value clamped and every
 * key it does not know left behind; `null` for an absent cutout. Throws [CutoutError] for a cutout no
 * engine could honour.
 */
export function normaliseComposeCutout(value: unknown): ComposeCutout | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new CutoutError('');
  const uri = value['uri'];
  if (typeof uri !== 'string' || uri.length === 0) throw new CutoutError('uri');
  const cutout: ComposeCutout = { uri };

  const number = (raw: unknown, field: string, min: number, max: number): number => {
    if (raw === undefined || raw === null) return 0;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new CutoutError(field);
    return Math.min(max, Math.max(min, raw));
  };
  const soft = number(value['soft'], 'soft', 0, 1);
  if (soft > 0) cutout.soft = soft;
  const shift = number(value['shift'], 'shift', -1, 1);
  if (shift !== 0) cutout.shift = shift;

  if (value['fill'] !== undefined && value['fill'] !== null) cutout.fill = rgbTriple(value['fill'], 'fill');

  const rawOutline = value['outline'];
  if (rawOutline !== undefined && rawOutline !== null) {
    if (!isRecord(rawOutline)) throw new CutoutError('outline');
    const color = rgbTriple(rawOutline['color'], 'outline.color');
    const width = rawOutline['width'];
    if (typeof width !== 'number' || !Number.isFinite(width)) throw new CutoutError('outline.width');
    const held = Math.min(MAX_CUTOUT_OUTLINE, Math.max(0, width));
    if (held > 0) cutout.outline = { color, width: held } satisfies ComposeCutoutOutline;
  }
  return cutout;
}

/** Three finite numbers, each held to 0..1, or a [CutoutError] naming `field`. */
function rgbTriple(value: unknown, field: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new CutoutError(field);
  return value.map((channel: unknown) => {
    if (typeof channel !== 'number' || !Number.isFinite(channel)) throw new CutoutError(field);
    return Math.min(1, Math.max(0, channel));
  }) as [number, number, number];
}

/** A `#rrggbb` colour as the wire carries one: three 0..1 channels. */
export function rgbOf(colour: string): [number, number, number] {
  const channel = (at: number): number => round4(parseInt(colour.slice(at, at + 2), 16) / 255);
  return [channel(1), channel(3), channel(5)];
}

/** `#rrggbb` in lower case, or undefined for anything that is not one. */
function hexColour(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unitOr(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? round4(Math.min(max, Math.max(min, value))) : fallback;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
