import type { FilterOp } from '../video-composer/definitions';

/**
 * What a customer did to their clips, in a form that can be put down and picked up again.
 *
 * Framework-free on purpose: an Angular editor, a React one and a plain script can all build and
 * read the same manifest, and all of them hand it to [toComposeSpec] to get something the native
 * composer can render. Clips are referred to by a caller-chosen `clipKey` - the manifest never
 * needs to know what the host's own clip objects look like.
 *
 * Text overlays keep their TEXT rather than a rasterised bitmap: a bitmap cannot be edited, and
 * reopening an edit has to bring back something the customer can still change. The PNG is produced
 * at render time.
 */

export interface EditClip {
  /** The host's own identifier for the clip. */
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

export interface EditOverlay {
  id: string;
  text: string;
  color: string;
  /** `null` draws the text with no plate behind it. */
  background: string | null;
  /** Centre, 0..1, top-left origin - the same coordinates the composer takes. */
  cx: number;
  cy: number;
  /** Clockwise, as CSS means it. */
  rotationDeg: number;
  /** Fraction of the output width used as the text size. */
  fontScale: number;
  /** Output-timeline window. `endMs` of 0 means "until the end". */
  startMs: number;
  endMs: number;
}

export interface EditMusic {
  uri: string;
  fileName: string;
  volume: number;
  loop: boolean;
  startMs: number;
}

export interface EditVoice {
  uri: string;
  durationMs: number;
  volume: number;
  startMs: number;
}

export interface EditManifest {
  clips: EditClip[];
  /** Id from [FILTER_PRESETS]. */
  filterId: string;
  fit: 'contain' | 'cover';
  /** Mutes every clip's own sound without touching music or voiceover. */
  originalMuted: boolean;
  overlays: EditOverlay[];
  music: EditMusic | null;
  voice: EditVoice | null;
}

/* -------------------------------------------------------------------------------------------- */

export interface FilterPreset {
  id: string;
  label: string;
  ops: FilterOp[];
}

/**
 * Every preset is CSS Filter Effects maths. That is what lets a preview drawn by the WebView with
 * `filter:` and the frames the native encoder writes agree without anyone tuning one against the
 * other - both read the same numbers.
 */
export const FILTER_PRESETS: FilterPreset[] = [
  { id: 'none', label: 'Original', ops: [] },
  {
    id: 'crisp',
    label: 'Crisp',
    ops: [
      { op: 'contrast', amount: 1.1 },
      { op: 'saturate', amount: 1.1 },
    ],
  },
  {
    id: 'warm',
    label: 'Warm',
    ops: [
      { op: 'saturate', amount: 1.15 },
      { op: 'brightness', amount: 1.03 },
      { op: 'tint', rgb: [255, 168, 72], alpha: 0.1 },
    ],
  },
  {
    id: 'golden',
    label: 'Golden',
    ops: [
      { op: 'saturate', amount: 1.25 },
      { op: 'contrast', amount: 1.05 },
      { op: 'tint', rgb: [255, 186, 66], alpha: 0.18 },
    ],
  },
  {
    id: 'cool',
    label: 'Cool',
    ops: [
      { op: 'saturate', amount: 1.05 },
      { op: 'tint', rgb: [72, 148, 255], alpha: 0.12 },
    ],
  },
  {
    id: 'vivid',
    label: 'Vivid',
    ops: [
      { op: 'saturate', amount: 1.4 },
      { op: 'contrast', amount: 1.12 },
    ],
  },
  {
    id: 'fade',
    label: 'Fade',
    ops: [
      { op: 'contrast', amount: 0.85 },
      { op: 'brightness', amount: 1.08 },
      { op: 'saturate', amount: 0.85 },
    ],
  },
  {
    id: 'mono',
    label: 'Mono',
    ops: [
      { op: 'grayscale', amount: 1 },
      { op: 'contrast', amount: 1.08 },
    ],
  },
  {
    id: 'noir',
    label: 'Noir',
    ops: [
      { op: 'grayscale', amount: 1 },
      { op: 'contrast', amount: 1.35 },
      { op: 'brightness', amount: 0.92 },
    ],
  },
];

export const SPEED_CHIPS = [0.5, 1, 1.5, 2] as const;

export const TEXT_COLORS = ['#ffffff', '#000000', '#9fe870', '#ffd166', '#ff6b6b', '#4d96ff'];

/** 720x1280 at 30 fps - portrait, and what a vertical feed plays. */
export const DEFAULT_OUTPUT = { width: 720, height: 1280, fps: 30 } as const;

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

export function filterPreset(id: string): FilterPreset {
  return FILTER_PRESETS.find((preset) => preset.id === id) ?? FILTER_PRESETS[0];
}

/**
 * The browser's reading of a filter stack, for a live preview: a CSS `filter` string plus the tint,
 * which CSS has no filter function for and a host draws as a translucent layer on top.
 */
export function cssFor(ops: FilterOp[]): { filter: string; tint: string | null } {
  const parts: string[] = [];
  let tint: string | null = null;
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
        tint = `rgba(${op.rgb[0]}, ${op.rgb[1]}, ${op.rgb[2]}, ${op.alpha})`;
        break;
    }
  }
  return { filter: parts.join(' ') || 'none', tint };
}

/* -------------------------------------------------------------------------------------------- */

export function defaultClipEdit(clipKey: string, durationMs: number): EditClip {
  return {
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
    clips: [],
    filterId: 'none',
    fit: 'contain',
    originalMuted: false,
    overlays: [],
    music: null,
    voice: null,
  };
}

/**
 * Brings a saved manifest back in line with the host's clip list, which may have changed in the
 * meantime: clips added since are appended, clips removed are dropped, and the order the manifest
 * remembers wins.
 *
 * @param clipKeys the host's clips, in their own order.
 * @param durations source duration per clip key, for trimming new clips to their full length.
 */
export function reconcileManifest(
  manifest: EditManifest | undefined,
  clipKeys: string[],
  durations: ReadonlyMap<string, number>,
): EditManifest {
  const known = new Set(clipKeys);
  const kept = (manifest?.clips ?? []).filter((edit) => known.has(edit.clipKey));
  const seen = new Set(kept.map((edit) => edit.clipKey));
  const added = clipKeys
    .filter((key) => !seen.has(key))
    .map((key) => defaultClipEdit(key, durations.get(key) ?? 0));

  return { ...emptyManifest(), ...manifest, clips: [...kept, ...added] };
}

/** How long the finished video runs, after every trim and speed change. */
export function totalDurationMs(manifest: EditManifest): number {
  return manifest.clips.reduce(
    (sum, clip) => sum + Math.max(0, clip.outMs - clip.inMs) / (clip.speed || 1),
    0,
  );
}

/**
 * Whether anything was actually changed. A single clip left exactly as it was can be posted as it
 * is rather than re-encoded, which is faster and kinder to the picture.
 */
export function isUntouched(manifest: EditManifest, durations: ReadonlyMap<string, number>): boolean {
  if (manifest.filterId !== 'none') return false;
  if (manifest.originalMuted) return false;
  if (manifest.overlays.length > 0) return false;
  if (manifest.music || manifest.voice) return false;
  return manifest.clips.every((clip) => {
    const source = durations.get(clip.clipKey) ?? 0;
    const untrimmed = clip.inMs === 0 && (source === 0 || Math.abs(clip.outMs - source) <= 100);
    return untrimmed && clip.speed === 1 && clip.volume === 1 && !clip.muted;
  });
}
