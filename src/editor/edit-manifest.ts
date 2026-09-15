import type { FilterOp } from '../video-composer/definitions';

/**
 * What a customer did to their clips, in a form that can be put down and picked up again.
 *
 * Framework-free on purpose: an Angular editor, a React one and a plain script can all build and
 * read the same manifest, and all of them hand it to [toComposeSpec] to get something the native
 * composer can render. Clips are referred to by a caller-chosen `clipKey` - the manifest never
 * needs to know what the host's own clip objects look like.
 *
 * Overlays keep what they ARE (text and its style, an emoji, a sticker id, a photo path, an effect
 * id) rather than a rasterised bitmap: a bitmap cannot be edited, and reopening an edit has to bring
 * back something the customer can still change. The PNG is produced when it is needed - for the
 * preview and for the render, by the same rasteriser, which is what keeps the two identical.
 */

export const MANIFEST_VERSION = 2;

export interface EditClip {
  /**
   * The segment's own id, unique within the manifest. Split and duplicate put two segments over the
   * same source, so `clipKey` alone can no longer tell them apart.
   */
  id: string;
  /** The host's own identifier for the source clip. Several segments may share one. */
  clipKey: string;
  /** Trim, in source milliseconds. */
  inMs: number;
  outMs: number;
  /** 0.25 .. 4. */
  speed: number;
  /** 0..1. */
  volume: number;
  muted: boolean;
}

export type TextAlign = 'left' | 'center' | 'right';

/**
 * How a text's colour is used. `plate` and `plateSoft` paint the colour BEHIND the text (solid and
 * translucent) and pick black or white for the letters; the others paint the letters.
 */
export type TextEffect = 'none' | 'plate' | 'plateSoft' | 'outline' | 'shadow';

/** What every layer on the video shares. */
export interface OverlayCommon {
  id: string;
  /** Centre, 0..1, top-left origin - the same coordinates the composer takes. */
  cx: number;
  cy: number;
  /** Multiplies the kind's base size (see [OVERLAY_BASE]). Baked into the bitmap, never scaled natively. */
  scale: number;
  /** Clockwise, as CSS means it. */
  rotationDeg: number;
  /** 0..1. For an effect this is its strength. */
  opacity: number;
  /** Output-timeline window. `endMs` of 0 means "until the end". */
  startMs: number;
  endMs: number;
}

export interface TextOverlay extends OverlayCommon {
  kind: 'text';
  /** Raw, with `\n` for the line breaks the customer typed. Wrapping is the rasteriser's job. */
  text: string;
  /** A text style id from the host's style registry (font, weight, glow...). */
  styleId: string;
  color: string;
  effect: TextEffect;
  align: TextAlign;
}

export interface StickerOverlay extends OverlayCommon {
  kind: 'sticker';
  /** Exactly one of the two. An emoji is drawn with the device's own emoji font. */
  emoji: string | null;
  /** A sticker from the host's bundled pack, resolved to a URL by the rasteriser's context. */
  assetId: string | null;
}

export interface ImageOverlay extends OverlayCommon {
  kind: 'image';
  /** `file://` or `content://` of the picked photo. */
  uri: string;
  fileName: string;
  /** Natural width / height, so a layout never has to wait for the photo to decode. */
  aspect: number;
}

/**
 * A full-frame look (vignette, film frame, grain...) for a window of the video. It is a bitmap like
 * every other layer, which is what lets it render natively with no shader of its own. Position,
 * scale and rotation are fixed at the frame; `opacity` is its strength.
 */
export interface EffectOverlay extends OverlayCommon {
  kind: 'effect';
  effectId: string;
}

export type EditOverlay = TextOverlay | StickerOverlay | ImageOverlay | EffectOverlay;
export type OverlayKind = EditOverlay['kind'];

export interface EditMusic {
  uri: string;
  fileName: string;
  /** Length of the whole track, 0 when it could not be read. */
  sourceDurationMs: number;
  /** The section of the track that is used. `outMs` of 0 means "to the end of the track". */
  inMs: number;
  outMs: number;
  /** Where the track starts on the OUTPUT timeline. */
  startMs: number;
  volume: number;
  /** Repeat the section until the video ends. */
  loop: boolean;
  fadeOutMs: number;
}

export interface EditVoiceover {
  id: string;
  uri: string;
  /** Where the take starts on the OUTPUT timeline. Takes never overlap. */
  startMs: number;
  durationMs: number;
  volume: number;
}

/** Each -1..1 with 0 as "untouched", except `fade` which is 0..1. */
export interface EditAdjust {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  /** Negative is green, positive is magenta. */
  tint: number;
  fade: number;
}

export interface EditManifest {
  version: typeof MANIFEST_VERSION;
  clips: EditClip[];
  /** Id from [FILTER_PRESETS]. */
  filterId: string;
  /** 0..1, how far the preset is applied. */
  filterIntensity: number;
  adjust: EditAdjust;
  fit: 'contain' | 'cover';
  /** Mutes every clip's own sound without touching music or voiceover. */
  originalMuted: boolean;
  /** Bottom to top: a later layer is drawn over an earlier one, in the preview and in the render. */
  overlays: EditOverlay[];
  music: EditMusic | null;
  /** Sorted by `startMs`, never overlapping. */
  voiceovers: EditVoiceover[];
}

/* -------------------------------------------------------------------------------------------- */

/** 720x1280 at 30 fps - portrait, and what a vertical feed plays. */
export const DEFAULT_OUTPUT = { width: 720, height: 1280, fps: 30 } as const;

/**
 * The size of each layer kind at `scale` 1, as fractions of the OUTPUT width. The rasteriser draws
 * at `base * scale`, and the preview sizes the resulting bitmap by `wPx / DEFAULT_OUTPUT.width` of
 * its own width - so both agree without either knowing the other's pixel density.
 */
export const OVERLAY_BASE = {
  /** Font size of a text layer. */
  textFont: 0.065,
  /** Widest a line of text may run before it wraps, at scale 1. */
  textWrap: 0.86,
  /** Glyph size of an emoji. */
  emoji: 0.2,
  /** Width of a bundled sticker. */
  sticker: 0.34,
  /** Width of a photo. */
  image: 0.5,
} as const;

/** Every layer kind together. More than this and a mid-range phone runs out of bitmap memory. */
export const MAX_LAYERS = 30;

/** The shortest a clip segment may become. */
export const MIN_CLIP_MS = 200;

/** The shortest a layer, a music section or a voiceover may become. */
export const MIN_LAYER_MS = 100;

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 6;

export const SPEED_CHIPS = [0.5, 1, 1.5, 2, 3] as const;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

export const TEXT_COLORS = [
  '#ffffff',
  '#000000',
  '#ff3b5c',
  '#ff8a3d',
  '#ffd23f',
  '#a6ff2e',
  '#2ee6a6',
  '#3dc2ff',
  '#3d6bff',
  '#9b5cff',
  '#ff5cc8',
  '#f5e6c8',
  '#8e8e93',
  '#0b8e87',
  '#4b1b5a',
];

/** The client-side upload ceiling a render has to stay under. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Enough bitrate to look good, never so much that the finished file cannot be uploaded. The cap
 * only bites on long timelines: at 30 seconds the ladder is still above 4 Mbps.
 */
export function videoBitrateFor(totalMs: number): number {
  const seconds = Math.max(1, totalMs / 1000);
  const budget = Math.floor((0.85 * MAX_UPLOAD_BYTES * 8) / seconds);
  return Math.max(1_200_000, Math.min(4_000_000, budget));
}

/* -------------------------------------------------------------------------------------------- */
/* Colour                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export type FilterCategory = 'trending' | 'food' | 'portrait' | 'landscape' | 'vintage' | 'mono';

export interface FilterPreset {
  id: string;
  label: string;
  category: FilterCategory;
  ops: FilterOp[];
}

export const FILTER_CATEGORIES: { id: FilterCategory; label: string }[] = [
  { id: 'trending', label: 'Trending' },
  { id: 'food', label: 'Food' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'landscape', label: 'Landscape' },
  { id: 'vintage', label: 'Vintage' },
  { id: 'mono', label: 'B&W' },
];

/**
 * Every preset is CSS Filter Effects maths. That is what lets a preview drawn by the WebView with
 * `filter:` and the frames the native encoder writes agree without anyone tuning one against the
 * other - both read the same numbers. Tints always come last in a preset, for the reason given on
 * [resolveFilterOps].
 */
export const FILTER_PRESETS: FilterPreset[] = [
  { id: 'none', label: 'Original', category: 'trending', ops: [] },
  {
    id: 'crisp',
    label: 'Crisp',
    category: 'trending',
    ops: [
      { op: 'contrast', amount: 1.1 },
      { op: 'saturate', amount: 1.1 },
    ],
  },
  {
    id: 'vivid',
    label: 'Vivid',
    category: 'trending',
    ops: [
      { op: 'saturate', amount: 1.4 },
      { op: 'contrast', amount: 1.12 },
    ],
  },
  {
    id: 'warm',
    label: 'Warm',
    category: 'trending',
    ops: [
      { op: 'saturate', amount: 1.15 },
      { op: 'brightness', amount: 1.03 },
      { op: 'tint', rgb: [255, 168, 72], alpha: 0.1 },
    ],
  },
  {
    id: 'golden',
    label: 'Golden',
    category: 'trending',
    ops: [
      { op: 'saturate', amount: 1.25 },
      { op: 'contrast', amount: 1.05 },
      { op: 'tint', rgb: [255, 186, 66], alpha: 0.18 },
    ],
  },
  {
    id: 'cool',
    label: 'Cool',
    category: 'trending',
    ops: [
      { op: 'saturate', amount: 1.05 },
      { op: 'tint', rgb: [72, 148, 255], alpha: 0.12 },
    ],
  },
  {
    id: 'fade',
    label: 'Fade',
    category: 'trending',
    ops: [
      { op: 'contrast', amount: 0.85 },
      { op: 'brightness', amount: 1.08 },
      { op: 'saturate', amount: 0.85 },
    ],
  },
  {
    id: 'tasty',
    label: 'Tasty',
    category: 'food',
    ops: [
      { op: 'saturate', amount: 1.3 },
      { op: 'contrast', amount: 1.08 },
      { op: 'tint', rgb: [255, 150, 60], alpha: 0.06 },
    ],
  },
  {
    id: 'fresh',
    label: 'Fresh',
    category: 'food',
    ops: [
      { op: 'saturate', amount: 1.2 },
      { op: 'brightness', amount: 1.05 },
      { op: 'tint', rgb: [140, 255, 170], alpha: 0.05 },
    ],
  },
  {
    id: 'bakery',
    label: 'Bakery',
    category: 'food',
    ops: [
      { op: 'sepia', amount: 0.2 },
      { op: 'saturate', amount: 1.15 },
      { op: 'brightness', amount: 1.05 },
    ],
  },
  {
    id: 'espresso',
    label: 'Espresso',
    category: 'food',
    ops: [
      { op: 'contrast', amount: 1.15 },
      { op: 'saturate', amount: 0.9 },
      { op: 'sepia', amount: 0.25 },
      { op: 'brightness', amount: 0.95 },
    ],
  },
  {
    id: 'pure',
    label: 'Pure',
    category: 'portrait',
    ops: [
      { op: 'brightness', amount: 1.06 },
      { op: 'contrast', amount: 0.95 },
      { op: 'saturate', amount: 0.95 },
    ],
  },
  {
    id: 'glow',
    label: 'Glow',
    category: 'portrait',
    ops: [
      { op: 'brightness', amount: 1.08 },
      { op: 'saturate', amount: 1.05 },
      { op: 'tint', rgb: [255, 200, 200], alpha: 0.06 },
    ],
  },
  {
    id: 'peach',
    label: 'Peach',
    category: 'portrait',
    ops: [
      { op: 'saturate', amount: 1.05 },
      { op: 'tint', rgb: [255, 170, 140], alpha: 0.1 },
    ],
  },
  {
    id: 'sunrise',
    label: 'Sunrise',
    category: 'landscape',
    ops: [
      { op: 'saturate', amount: 1.2 },
      { op: 'tint', rgb: [255, 140, 90], alpha: 0.12 },
    ],
  },
  {
    id: 'ocean',
    label: 'Ocean',
    category: 'landscape',
    ops: [
      { op: 'saturate', amount: 1.1 },
      { op: 'hueRotate', degrees: -8 },
      { op: 'tint', rgb: [60, 160, 255], alpha: 0.1 },
    ],
  },
  {
    id: 'forest',
    label: 'Forest',
    category: 'landscape',
    ops: [
      { op: 'saturate', amount: 1.15 },
      { op: 'hueRotate', degrees: 8 },
      { op: 'contrast', amount: 1.05 },
    ],
  },
  {
    id: 'retro',
    label: 'Retro',
    category: 'vintage',
    ops: [
      { op: 'sepia', amount: 0.35 },
      { op: 'contrast', amount: 0.95 },
      { op: 'brightness', amount: 1.05 },
      { op: 'tint', rgb: [255, 210, 150], alpha: 0.08 },
    ],
  },
  {
    id: 'polaroid',
    label: 'Polaroid',
    category: 'vintage',
    ops: [
      { op: 'contrast', amount: 0.9 },
      { op: 'brightness', amount: 1.1 },
      { op: 'saturate', amount: 0.8 },
      { op: 'tint', rgb: [255, 240, 200], alpha: 0.08 },
    ],
  },
  {
    id: 'seventies',
    label: '1970',
    category: 'vintage',
    ops: [
      { op: 'sepia', amount: 0.5 },
      { op: 'saturate', amount: 1.2 },
      { op: 'hueRotate', degrees: -10 },
    ],
  },
  {
    id: 'mono',
    label: 'Mono',
    category: 'mono',
    ops: [
      { op: 'grayscale', amount: 1 },
      { op: 'contrast', amount: 1.08 },
    ],
  },
  {
    id: 'noir',
    label: 'Noir',
    category: 'mono',
    ops: [
      { op: 'grayscale', amount: 1 },
      { op: 'contrast', amount: 1.35 },
      { op: 'brightness', amount: 0.92 },
    ],
  },
  {
    id: 'silver',
    label: 'Silver',
    category: 'mono',
    ops: [
      { op: 'grayscale', amount: 1 },
      { op: 'brightness', amount: 1.1 },
      { op: 'contrast', amount: 0.9 },
    ],
  },
];

export interface AdjustSlider {
  id: keyof EditAdjust;
  label: string;
  /** -1 for the two-sided sliders, 0 for `fade`. */
  min: -1 | 0;
}

export const ADJUST_SLIDERS: AdjustSlider[] = [
  { id: 'brightness', label: 'Brightness', min: -1 },
  { id: 'contrast', label: 'Contrast', min: -1 },
  { id: 'saturation', label: 'Saturation', min: -1 },
  { id: 'warmth', label: 'Warmth', min: -1 },
  { id: 'tint', label: 'Tint', min: -1 },
  { id: 'fade', label: 'Fade', min: 0 },
];

export function neutralAdjust(): EditAdjust {
  return { brightness: 0, contrast: 0, saturation: 0, warmth: 0, tint: 0, fade: 0 };
}

export function filterPreset(id: string): FilterPreset {
  return FILTER_PRESETS.find((preset) => preset.id === id) ?? FILTER_PRESETS[0];
}

/**
 * A preset's ops pulled toward identity. `k` of 1 is the preset as designed and 0 is no change:
 * multiplicative amounts move toward 1, the "how much" ops toward 0, angles toward 0 degrees and a
 * tint toward transparent.
 */
export function scaleOps(ops: FilterOp[], k: number): FilterOp[] {
  const t = clamp(k, 0, 1);
  if (t === 1) return ops;
  return ops.map((op): FilterOp => {
    switch (op.op) {
      case 'brightness':
      case 'contrast':
      case 'saturate':
        return { op: op.op, amount: round4(1 + (op.amount - 1) * t) };
      case 'sepia':
      case 'grayscale':
        return { op: op.op, amount: round4(op.amount * t) };
      case 'hueRotate':
        return { op: 'hueRotate', degrees: round4(op.degrees * t) };
      case 'tint':
        return { op: 'tint', rgb: op.rgb, alpha: round4(op.alpha * t) };
    }
  });
}

/** The Adjust sliders as CSS maths. Neutral sliders contribute nothing at all. */
export function adjustOps(adjust: EditAdjust): FilterOp[] {
  const ops: FilterOp[] = [];
  const a = { ...neutralAdjust(), ...adjust };
  if (a.brightness) ops.push({ op: 'brightness', amount: round4(1 + 0.4 * a.brightness) });
  if (a.contrast) ops.push({ op: 'contrast', amount: round4(1 + 0.4 * a.contrast) });
  if (a.saturation) ops.push({ op: 'saturate', amount: round4(1 + 0.6 * a.saturation) });
  if (a.fade > 0) {
    ops.push({ op: 'contrast', amount: round4(1 - 0.3 * a.fade) });
    ops.push({ op: 'saturate', amount: round4(1 - 0.15 * a.fade) });
  }
  if (a.warmth > 0) ops.push({ op: 'tint', rgb: [255, 160, 60], alpha: round4(0.14 * a.warmth) });
  if (a.warmth < 0) ops.push({ op: 'tint', rgb: [60, 140, 255], alpha: round4(0.14 * -a.warmth) });
  if (a.tint > 0) ops.push({ op: 'tint', rgb: [255, 60, 220], alpha: round4(0.1 * a.tint) });
  if (a.tint < 0) ops.push({ op: 'tint', rgb: [60, 230, 90], alpha: round4(0.1 * -a.tint) });
  return ops;
}

/**
 * The whole colour pipeline the render runs: the preset at its intensity, then the Adjust sliders.
 *
 * Tints are moved to the end. The preview can only draw a tint as a translucent layer ON TOP of a
 * CSS-filtered video, so every tint lands after every other op there whatever order the list says;
 * putting them last here is what makes the native render do the same thing.
 */
export function resolveFilterOps(manifest: Pick<EditManifest, 'filterId' | 'filterIntensity' | 'adjust'>): FilterOp[] {
  const all = [
    ...scaleOps(filterPreset(manifest.filterId).ops, manifest.filterIntensity ?? 1),
    ...adjustOps(manifest.adjust ?? neutralAdjust()),
  ].filter((op) => !isIdentityOp(op));
  return [...all.filter((op) => op.op !== 'tint'), ...all.filter((op) => op.op === 'tint')];
}

/**
 * The browser's reading of a filter stack, for a live preview: a CSS `filter` string plus the tints,
 * which CSS has no filter function for and a host draws as translucent layers on top, in order.
 * `tint` is the last of them, for callers that only ever had one.
 */
export function cssFor(ops: FilterOp[]): { filter: string; tints: string[]; tint: string | null } {
  const parts: string[] = [];
  const tints: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'brightness':
        parts.push(`brightness(${op.amount})`);
        break;
      case 'contrast':
        parts.push(`contrast(${op.amount})`);
        break;
      case 'saturate':
        parts.push(`saturate(${op.amount})`);
        break;
      case 'sepia':
        parts.push(`sepia(${op.amount})`);
        break;
      case 'grayscale':
        parts.push(`grayscale(${op.amount})`);
        break;
      case 'hueRotate':
        parts.push(`hue-rotate(${op.degrees}deg)`);
        break;
      case 'tint':
        tints.push(`rgba(${op.rgb[0]}, ${op.rgb[1]}, ${op.rgb[2]}, ${op.alpha})`);
        break;
    }
  }
  return { filter: parts.join(' ') || 'none', tints, tint: tints[tints.length - 1] ?? null };
}

function isIdentityOp(op: FilterOp): boolean {
  switch (op.op) {
    case 'brightness':
    case 'contrast':
    case 'saturate':
      return op.amount === 1;
    case 'sepia':
    case 'grayscale':
      return op.amount === 0;
    case 'hueRotate':
      return op.degrees === 0;
    case 'tint':
      return op.alpha === 0;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Construction                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export function defaultClipEdit(clipKey: string, durationMs: number, id: string = clipKey): EditClip {
  return {
    id,
    clipKey,
    inMs: 0,
    outMs: Math.max(100, Math.round(durationMs)),
    speed: 1,
    volume: 1,
    muted: false,
  };
}

export function emptyManifest(): EditManifest {
  return {
    version: MANIFEST_VERSION,
    clips: [],
    filterId: 'none',
    filterIntensity: 1,
    adjust: neutralAdjust(),
    fit: 'contain',
    originalMuted: false,
    overlays: [],
    music: null,
    voiceovers: [],
  };
}

/**
 * Brings any manifest this package has ever written up to the current shape, filling what an older
 * one did not have. Version 1 had one voiceover, no segment ids, text-only overlays sized by
 * `fontScale`, and no filter intensity or Adjust.
 */
export function normaliseManifest(input: unknown): EditManifest {
  const raw = (input ?? {}) as Record<string, any>;
  const base = emptyManifest();

  const usedIds = new Set<string>();
  const clips: EditClip[] = Array.isArray(raw['clips'])
    ? raw['clips'].map((c: any) => {
        let id = typeof c.id === 'string' && c.id ? c.id : String(c.clipKey);
        while (usedIds.has(id)) id = `${id}~`;
        usedIds.add(id);
        return {
          id,
          clipKey: String(c.clipKey),
          inMs: num(c.inMs, 0),
          outMs: num(c.outMs, 100),
          speed: clamp(num(c.speed, 1), MIN_SPEED, MAX_SPEED),
          volume: clamp(num(c.volume, 1), 0, 1),
          muted: !!c.muted,
        };
      })
    : [];

  const overlays: EditOverlay[] = Array.isArray(raw['overlays'])
    ? raw['overlays'].map((o: any): EditOverlay => {
        const common: OverlayCommon = {
          id: String(o.id),
          cx: num(o.cx, 0.5),
          cy: num(o.cy, 0.5),
          scale: clamp(
            typeof o.scale === 'number' ? o.scale : typeof o.fontScale === 'number' ? o.fontScale / OVERLAY_BASE.textFont : 1,
            MIN_SCALE,
            MAX_SCALE,
          ),
          rotationDeg: num(o.rotationDeg, 0),
          opacity: clamp(num(o.opacity, 1), 0, 1),
          startMs: Math.max(0, num(o.startMs, 0)),
          endMs: Math.max(0, num(o.endMs, 0)),
        };
        switch (o.kind) {
          case 'sticker':
            return { ...common, kind: 'sticker', emoji: o.emoji ?? null, assetId: o.assetId ?? null };
          case 'image':
            return { ...common, kind: 'image', uri: String(o.uri), fileName: String(o.fileName ?? ''), aspect: num(o.aspect, 1) };
          case 'effect':
            return { ...common, kind: 'effect', effectId: String(o.effectId) };
          default: {
            // Version 1 drew its letters on a dark translucent plate when it had a background. A
            // plate now takes the colour and picks the letters itself, so the nearest look is a
            // dark soft plate - the letters come out white.
            const v1Plate = !o.effect && !!o.background;
            const effect: TextEffect = o.effect ?? (v1Plate ? 'plateSoft' : 'shadow');
            return {
              ...common,
              kind: 'text',
              text: String(o.text ?? ''),
              styleId: String(o.styleId ?? 'classic'),
              color: v1Plate ? '#000000' : String(o.color ?? '#ffffff'),
              effect,
              align: o.align ?? 'center',
            };
          }
        }
      })
    : [];

  const voiceovers: EditVoiceover[] = Array.isArray(raw['voiceovers'])
    ? raw['voiceovers'].map((v: any, i: number) => ({
        id: String(v.id ?? `vo-${i}`),
        uri: String(v.uri),
        startMs: Math.max(0, num(v.startMs, 0)),
        durationMs: Math.max(0, num(v.durationMs, 0)),
        volume: clamp(num(v.volume, 1), 0, 1),
      }))
    : raw['voice']
      ? [
          {
            id: 'vo-0',
            uri: String(raw['voice'].uri),
            startMs: Math.max(0, num(raw['voice'].startMs, 0)),
            durationMs: Math.max(0, num(raw['voice'].durationMs, 0)),
            volume: clamp(num(raw['voice'].volume, 1), 0, 1),
          },
        ]
      : [];

  const m = raw['music'];
  const music: EditMusic | null = m
    ? {
        uri: String(m.uri),
        fileName: String(m.fileName ?? 'Music'),
        sourceDurationMs: Math.max(0, num(m.sourceDurationMs, 0)),
        inMs: Math.max(0, num(m.inMs, 0)),
        outMs: Math.max(0, num(m.outMs, 0)),
        startMs: Math.max(0, num(m.startMs, 0)),
        volume: clamp(num(m.volume, 0.6), 0, 1),
        loop: m.loop ?? true,
        fadeOutMs: Math.max(0, num(m.fadeOutMs, 400)),
      }
    : null;

  return {
    version: MANIFEST_VERSION,
    clips,
    filterId: typeof raw['filterId'] === 'string' ? raw['filterId'] : base.filterId,
    filterIntensity: clamp(num(raw['filterIntensity'], 1), 0, 1),
    adjust: { ...neutralAdjust(), ...(raw['adjust'] ?? {}) },
    fit: raw['fit'] === 'cover' ? 'cover' : 'contain',
    originalMuted: !!raw['originalMuted'],
    overlays,
    music,
    voiceovers: voiceovers.sort((a, b) => a.startMs - b.startMs),
  };
}

/**
 * Brings a saved manifest back in line with the host's clip list, which may have changed in the
 * meantime: clips added since are appended, segments of clips removed are dropped, and the order
 * the manifest remembers wins.
 *
 * @param clipKeys the host's clips, in their own order.
 * @param durations source duration per clip key, for trimming new clips to their full length.
 */
export function reconcileManifest(
  manifest: EditManifest | undefined,
  clipKeys: string[],
  durations: ReadonlyMap<string, number>,
): EditManifest {
  const current = manifest ? normaliseManifest(manifest) : emptyManifest();
  const known = new Set(clipKeys);
  const kept = current.clips.filter((edit) => known.has(edit.clipKey));
  const seen = new Set(kept.map((edit) => edit.clipKey));
  const usedIds = new Set(kept.map((edit) => edit.id));
  const added = clipKeys
    .filter((key) => !seen.has(key))
    .map((key) => {
      let id = key;
      while (usedIds.has(id)) id = `${id}~`;
      usedIds.add(id);
      return defaultClipEdit(key, durations.get(key) ?? 0, id);
    });

  return { ...current, clips: [...kept, ...added] };
}

/** How long the finished video runs, after every trim and speed change. */
export function totalDurationMs(manifest: Pick<EditManifest, 'clips'>): number {
  return manifest.clips.reduce(
    (sum, clip) => sum + Math.max(0, clip.outMs - clip.inMs) / (clip.speed || 1),
    0,
  );
}

/** Each source clip once, in the order it first appears on the timeline. */
export function uniqueClipKeys(manifest: Pick<EditManifest, 'clips'>): string[] {
  return [...new Set(manifest.clips.map((clip) => clip.clipKey))];
}

/**
 * Whether anything was actually changed. A single clip left exactly as it was can be posted as it
 * is rather than re-encoded, which is faster and kinder to the picture.
 */
export function isUntouched(manifest: EditManifest, durations: ReadonlyMap<string, number>): boolean {
  if (manifest.clips.length !== 1) return false;
  if (resolveFilterOps(manifest).length > 0) return false;
  if (manifest.originalMuted || manifest.fit !== 'contain') return false;
  if (manifest.overlays.length > 0) return false;
  if (manifest.music || manifest.voiceovers.length > 0) return false;
  return manifest.clips.every((clip) => {
    const source = durations.get(clip.clipKey) ?? 0;
    const untrimmed = clip.inMs === 0 && (source === 0 || Math.abs(clip.outMs - source) <= 100);
    return untrimmed && clip.speed === 1 && clip.volume === 1 && !clip.muted;
  });
}

/* -------------------------------------------------------------------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
