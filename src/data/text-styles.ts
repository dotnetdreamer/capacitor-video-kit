import type { TextStyleSpec } from '../editor';

/**
 * The text style registry behind the font grid (Trending | Basic | Handwritten | Retro | Fun).
 *
 * Every family here is a font bundled with the package and registered by `installEditorFonts()`
 * under a "VE " name. Bundling is what makes a text layer look the same on the preview and in the
 * posted video: the rasteriser draws the text to a canvas whose bitmap is burned into the render,
 * so a font that was only on a CDN would draw in the fallback the moment the phone is offline. A
 * canvas also never waits for a face to arrive, so the rasteriser loads the face first with
 * `document.fonts.load(font, text)`, passing the real text so the latin-ext subset is fetched when
 * a Turkish caption needs it.
 *
 * A manifest stores only the style id, so ids are permanent: renaming one would silently turn
 * saved drafts back into Classic. Labels and fonts can change; ids cannot.
 */

export type TextStyleCategory = 'trending' | 'basic' | 'handwritten' | 'retro' | 'fun';

export const TEXT_STYLE_CATEGORIES: { id: TextStyleCategory; label: string }[] = [
  { id: 'trending', label: 'Trending' },
  { id: 'basic', label: 'Basic' },
  { id: 'handwritten', label: 'Handwritten' },
  { id: 'retro', label: 'Retro' },
  { id: 'fun', label: 'Fun' },
];

/**
 * A style and the one tab it lives in. Trending is never a style's own category - it is a curated
 * list on top of the others (see [TRENDING_TEXT_STYLE_IDS]), so a style never has two entries that
 * could drift apart.
 */
export interface TextStyleEntry extends TextStyleSpec {
  /** Never 'trending'. */
  category: TextStyleCategory;
}

/*
 * Fallback stacks end in a generic family Android really has (sans-serif is Roboto, serif is Noto
 * Serif, cursive is Dancing Script, monospace is Droid Sans Mono), so a face that has not loaded
 * yet still draws something in the right spirit rather than plain Roboto for everything.
 */
const SANS = 'system-ui, Roboto, "Helvetica Neue", Arial, sans-serif';
const CONDENSED = 'Impact, "Arial Narrow", "Roboto Condensed", sans-serif-condensed, sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const HEAVY = '"Arial Black", Impact, system-ui, Roboto, sans-serif';

export const DEFAULT_TEXT_STYLE_ID = 'classic';

export const TEXT_STYLES: TextStyleEntry[] = [
  // Classic comes first: it is the default for every new text layer and the fallback for an id
  // this build does not know.
  {
    id: 'classic',
    label: 'Classic',
    family: 'VE Inter',
    fallback: SANS,
    weight: 700,
    category: 'basic',
  },
  {
    id: 'elegance',
    label: 'Elegance',
    family: 'VE Playfair Display',
    fallback: SERIF,
    weight: 700,
    italic: true,
    category: 'basic',
  },
  {
    id: 'neon',
    label: 'Neon',
    family: 'VE Poppins',
    fallback: SANS,
    weight: 600,
    glow: true,
    category: 'fun',
  },
  // Shrikhand is an italic design declared as an italic face, so asking for italic selects it as
  // drawn instead of slanting it a second time.
  {
    id: 'retro',
    label: 'Retro',
    family: 'VE Shrikhand',
    fallback: HEAVY,
    weight: 400,
    italic: true,
    category: 'retro',
  },
  {
    id: 'comic',
    label: 'Comic',
    family: 'VE Comic Relief',
    fallback: '"Comic Sans MS", "Chalkboard SE", cursive',
    weight: 700,
    lineHeight: 1.25,
    category: 'fun',
  },
  {
    id: 'tallhaus',
    label: 'Tallhaus',
    family: 'VE Bebas Neue',
    fallback: CONDENSED,
    weight: 400,
    uppercase: true,
    letterSpacingEm: 0.02,
    // Capitals only, so nothing hangs below the baseline and the lines can stack tighter.
    lineHeight: 1.1,
    category: 'basic',
  },
  {
    id: 'vintage',
    label: 'Vintage',
    family: 'VE DM Serif Display',
    fallback: SERIF,
    weight: 400,
    category: 'retro',
  },
  {
    id: 'bomb',
    label: 'Bomb',
    family: 'VE Baloo 2',
    fallback: '"Arial Rounded MT Bold", ' + HEAVY,
    weight: 800,
    category: 'fun',
  },
  {
    id: 'signature',
    label: 'Signature',
    family: 'VE Great Vibes',
    fallback: '"Snell Roundhand", "Brush Script MT", cursive',
    weight: 400,
    // Its swashes reach well past the em box; at 1.2 a second line's capitals run into the first.
    lineHeight: 1.3,
    category: 'handwritten',
  },
  {
    id: 'headline',
    label: 'Headline',
    family: 'VE Anton',
    fallback: CONDENSED,
    weight: 400,
    // Very tall capitals: accented ones would touch the descenders above at the default.
    lineHeight: 1.25,
    category: 'basic',
  },
  {
    id: 'marker',
    label: 'Marker',
    family: 'VE Sedgwick Ave',
    fallback: '"Marker Felt", "Comic Sans MS", cursive',
    weight: 400,
    // Its capitals are nearly a full em tall, taller than any other face here.
    lineHeight: 1.35,
    category: 'handwritten',
  },
  {
    id: 'notes',
    label: 'Notes',
    family: 'VE Caveat',
    fallback: '"Bradley Hand", "Comic Sans MS", cursive',
    weight: 700,
    category: 'handwritten',
  },
  {
    id: 'script',
    label: 'Script',
    family: 'VE Pacifico',
    fallback: '"Brush Script MT", cursive',
    weight: 400,
    // Pacifico's loops are the tallest of the set.
    lineHeight: 1.4,
    category: 'handwritten',
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    family: 'VE Special Elite',
    fallback: '"Courier New", Courier, monospace',
    weight: 400,
    category: 'retro',
  },
  {
    id: 'arcade',
    label: 'Arcade',
    family: 'VE Bungee',
    fallback: HEAVY,
    weight: 400,
    category: 'retro',
  },
  {
    id: 'pop',
    label: 'Pop',
    family: 'VE Bangers',
    fallback: '"Comic Sans MS", ' + HEAVY,
    weight: 400,
    category: 'fun',
  },
];

/** TikTok's Trending tab, in its order. Ids only, so each style keeps a single definition. */
export const TRENDING_TEXT_STYLE_IDS: string[] = [
  'classic',
  'elegance',
  'neon',
  'retro',
  'comic',
  'tallhaus',
  'vintage',
  'bomb',
  'signature',
];

const BY_ID = new Map(TEXT_STYLES.map((style) => [style.id, style]));
const CLASSIC = BY_ID.get(DEFAULT_TEXT_STYLE_ID) as TextStyleEntry;

/**
 * Never misses: a draft saved by a newer build, or one whose style was retired, still draws - in
 * Classic - instead of breaking the preview or the render.
 */
export function textStyleById(id: string): TextStyleEntry {
  return BY_ID.get(id) ?? CLASSIC;
}

export function textStylesIn(category: TextStyleCategory): TextStyleEntry[] {
  if (category === 'trending') {
    return TRENDING_TEXT_STYLE_IDS.map((id) => BY_ID.get(id)).filter(
      (style): style is TextStyleEntry => !!style
    );
  }
  return TEXT_STYLES.filter((style) => style.category === category);
}

/**
 * CSS for a font grid tile that shows a style's name in the style itself. It mirrors what the
 * rasteriser draws (family, weight, slant, capitals, tracking, glow) so the tile is an honest
 * sample. The tiles also warm the font cache: rendering a name makes the WebView fetch that
 * family's latin file, so the first bitmap in a newly picked style rarely waits for it.
 *
 * `family` is a bare family name, so it is quoted here; the glow uses `currentColor` because the
 * Neon look glows in whatever colour the text is.
 */
export function textStyleCss(style: TextStyleSpec): {
  'font-family': string;
  'font-weight': string;
  'font-style': string;
  'text-transform': string;
  'letter-spacing': string;
  'text-shadow': string;
} {
  return {
    'font-family': `"${style.family}", ${style.fallback}`,
    'font-weight': String(style.weight),
    'font-style': style.italic ? 'italic' : 'normal',
    'text-transform': style.uppercase ? 'uppercase' : 'none',
    'letter-spacing': style.letterSpacingEm ? `${style.letterSpacingEm}em` : 'normal',
    'text-shadow': style.glow ? '0 0 0.08em currentColor, 0 0 0.3em currentColor' : 'none',
  };
}
