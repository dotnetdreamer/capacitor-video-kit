/**
 * Rasterises layers to transparent PNGs at OUTPUT pixel scale.
 *
 * This is the caller's half of the overlay contract: the native engines place bitmaps and nothing
 * else - no fonts, no text layout, no SVG - which is what lets the same overlay land identically on
 * Android, iOS and a browser preview. The editor's preview shows exactly these PNGs and the render
 * places exactly these PNGs, so the two cannot disagree about a font, a wrap or a sticker's size.
 *
 * [rasteriseOverlay] draws a manifest layer. [rasteriseText] and [rasteriseArrow] are the video-kit
 * lab's simpler probes and stay as they were.
 */

import {
  DEFAULT_OUTPUT,
  OVERLAY_BASE,
  type EditOverlay,
  type ImageOverlay,
  type TextAlign,
  type TextEffect,
  type TextOverlay,
} from './edit-manifest';
import { drawEffect, effectRasterScale } from './effects';
import type { RasterContext, RasterisedOverlay, TextStyleSpec } from './raster-context';

export interface TextOverlayStyle {
  text: string;
  /** Cap height in output pixels. */
  fontSizePx: number;
  color: string;
  /** `null` draws the text with no plate behind it. */
  background: string | null;
  fontFamily: string;
}

const PADDING_RATIO = 0.35;
const LINE_HEIGHT_RATIO = 1.25;
const CORNER_RATIO = 0.25;

/**
 * Lines are split on explicit newlines only. A real editor wraps to a width; the lab keeps it
 * simple because what is being tested here is placement and timing, not typography.
 */
export function rasteriseText(style: TextOverlayStyle): RasterisedOverlay {
  const lines = style.text.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) {
    lines.push(' ');
  }

  const font = `700 ${style.fontSizePx}px ${style.fontFamily}`;
  const padding = Math.round(style.fontSizePx * PADDING_RATIO);
  const lineHeight = Math.round(style.fontSizePx * LINE_HEIGHT_RATIO);

  // Measure first on a throwaway context: the canvas has to be sized before anything is drawn on
  // it, and resizing a canvas clears it.
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) {
    throw new Error('2D canvas is unavailable');
  }
  measure.font = font;
  const widest = Math.max(...lines.map((line) => measure.measureText(line).width));

  const width = Math.ceil(widest + padding * 2);
  const height = Math.ceil(lineHeight * lines.length + padding * 2);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas is unavailable');
  }

  if (style.background) {
    ctx.fillStyle = style.background;
    ctx.beginPath();
    roundedRectPath(ctx, 0, 0, width, height, Math.round(style.fontSizePx * CORNER_RATIO));
    ctx.fill();
  }

  ctx.font = font;
  ctx.fillStyle = style.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2, padding + lineHeight * (index + 0.5));
  });

  return { png: canvas.toDataURL('image/png'), wPx: width, hPx: height };
}

/**
 * A solid arrow pointing right, used to prove which way a rotation actually turns. A symmetric
 * shape cannot tell clockwise from counter-clockwise; this one can.
 */
export function rasteriseArrow(sizePx: number, color: string): RasterisedOverlay {
  const width = sizePx;
  const height = Math.round(sizePx * 0.4);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas is unavailable');
  }

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, height * 0.3);
  ctx.lineTo(width * 0.6, height * 0.3);
  ctx.lineTo(width * 0.6, 0);
  ctx.lineTo(width, height * 0.5);
  ctx.lineTo(width * 0.6, height);
  ctx.lineTo(width * 0.6, height * 0.7);
  ctx.lineTo(0, height * 0.7);
  ctx.closePath();
  ctx.fill();

  return { png: canvas.toDataURL('image/png'), wPx: width, hPx: height };
}

/* -------------------------------------------------------------------------------------------- */
/* Manifest layers                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * No bitmap side may exceed the output frame's larger side times this. A photo pinched to scale 6 is
 * several thousand pixels across, most of it off the frame; drawing it at full size would cost tens
 * of megabytes on a phone that has thirty layers to hold. Past the cap the PNG is drawn smaller and
 * `wPx`/`hPx` still carry the full size, which the native side and the preview scale up to.
 */
const MAX_BITMAP_SIDE_RATIO = 1.5;

/** Enough for undo, redo and a pinch to reuse decoded images; small enough to not hoard photos. */
const IMAGE_CACHE_SIZE = 20;

/** A bundled face loads in milliseconds; this only stops a broken one from hanging a render. */
const FONT_LOAD_TIMEOUT_MS = 4000;

const EMOJI_FONTS = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';

/** How a layer's bitmap is to be drawn, beyond what the layer and the context already say. */
export interface RasteriseOptions {
  /**
   * Pixels per output pixel, 1 and up: how much sharper than its resting size the bitmap is drawn,
   * for a layer whose motion magnifies it (`overlayRasterDetail`). `wPx`/`hPx` are the resting size
   * whatever this is, and the side cap still holds. Absent is 1, the bitmap every layer always had.
   * An effect is the whole frame and never grows, and takes no notice of it.
   */
  detail?: number;
}

/**
 * Draws one manifest layer the way both the preview and the render show it: at OUTPUT pixel scale,
 * with `overlay.scale` baked in, and `wPx`/`hPx` being the size it covers on the output frame.
 * Position, rotation, opacity and time are NOT drawn - they are applied where the bitmap is placed -
 * so moving or fading a layer never needs a new bitmap (see [overlayRasterKey]).
 *
 * Asynchronous because a face has to be loaded before text can be measured and a photo or sticker
 * has to be decoded before it can be drawn. Rejects with a clear message when an image cannot be
 * loaded or a sticker layer has nothing to draw.
 */
export async function rasteriseOverlay(overlay: EditOverlay, ctx: RasterContext, options: RasteriseOptions = {}): Promise<RasterisedOverlay> {
  const detail = typeof options.detail === 'number' && options.detail > 1 && Number.isFinite(options.detail) ? options.detail : 1;
  switch (overlay.kind) {
    case 'text':
      return rasteriseTextLayer(overlay, ctx, detail);
    case 'sticker':
      if (overlay.emoji) return rasteriseEmoji(overlay.emoji, layerScale(overlay.scale), ctx, detail);
      if (overlay.assetId) return rasteriseSticker(overlay.assetId, layerScale(overlay.scale), ctx, detail);
      throw new Error(`sticker layer ${overlay.id} has neither an emoji nor a sticker asset`);
    case 'image':
      return rasteriseImage(overlay, ctx, detail);
    case 'effect':
      return rasteriseEffect(overlay.effectId, ctx);
  }
}

/**
 * Everything a layer's bitmap depends on, as one string: two layers (or one layer before and after an
 * edit) with the same key draw the same PNG. Position, rotation, opacity and time are left out on
 * purpose - they never change the bitmap - so dragging a layer never redraws it. The scale is
 * rounded so a pinch that settles within a thousandth reuses what is there. An effect's key has no
 * scale at all: it always covers the whole frame.
 */
export function overlayRasterKey(overlay: EditOverlay, outputWidth: number = DEFAULT_OUTPUT.width): string {
  const scale = Math.round(overlay.scale * 1000) / 1000;
  // The frame's WIDTH, because that is what every layer's size is a fraction of: the same sticker
  // at the same scale is 245px across a 720 post and 734px across a 4K one. Without it here, a
  // customer who chose a bigger frame kept the bitmaps drawn for the smaller one and posted a video
  // whose text was soft - the one part of the picture that is drawn rather than filmed.
  const frame = Math.round(outputWidth);
  switch (overlay.kind) {
    case 'text':
      return JSON.stringify(['text', overlay.text, overlay.styleId, overlay.color, overlay.effect, overlay.align, scale, frame]);
    case 'sticker':
      return JSON.stringify(['sticker', overlay.emoji, overlay.assetId, scale, frame]);
    case 'image':
      return JSON.stringify(['image', overlay.uri, scale, frame]);
    case 'effect':
      // An effect is the whole frame at any size: it carries no bitmap of its own to redraw.
      return JSON.stringify(['effect', overlay.effectId]);
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Text                                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** What a text effect and a style's glow turn into on the canvas. */
interface TextLook {
  /** The colour the letters are filled with. */
  letters: string;
  plate: { color: string; alpha: number } | null;
  stroke: { color: string; width: number } | null;
  shadow: { color: string; blur: number; offsetY: number } | null;
  /** `onPlate` glows the plate (the part carrying the colour) instead of the letters. */
  glow: { color: string; blur: number; onPlate: boolean } | null;
}

interface InkBox {
  /** Distances from the pen position (left end of the baseline); positive `left` is ink left of it. */
  left: number;
  right: number;
  ascent: number;
  descent: number;
}

interface PlacedLine {
  text: string;
  /** Pen position inside the text block. */
  x: number;
  baseline: number;
  top: number;
  advance: number;
  /** `null` for a blank line, which has nothing to draw and gets no plate. */
  ink: InkBox | null;
}

interface TextLayout {
  /** The whole bitmap, in output pixels. */
  width: number;
  height: number;
  /** Where the text block's top-left sits inside the bitmap. */
  originX: number;
  originY: number;
  lines: PlacedLine[];
  plates: { x: number; y: number; w: number; h: number }[];
  plateRadius: number;
}

/**
 * Measures and draws one line of text with a style's tracking. It is bound to one context, because
 * font and letter spacing are context state.
 */
interface TextPen {
  width(line: string): number;
  ink(line: string): InkBox | null;
  draw(line: string, x: number, y: number, mode: 'fill' | 'stroke'): void;
  /** Height of a capital, for centring a line on its capitals rather than on the em box. */
  capHeight: number;
}

async function rasteriseTextLayer(overlay: TextOverlay, ctx: RasterContext, detail: number): Promise<RasterisedOverlay> {
  const style = ctx.textStyle(overlay.styleId);
  const scale = layerScale(overlay.scale);
  const fontPx = Math.max(4, Math.round(ctx.output.width * OVERLAY_BASE.textFont * scale));
  const font = fontCss(style, fontPx);
  const spacingPx = (style.letterSpacingEm ?? 0) * fontPx;
  const lineHeight = fontPx * (style.lineHeight && style.lineHeight > 0 ? style.lineHeight : 1.2);
  const text = style.uppercase ? overlay.text.toLocaleUpperCase() : overlay.text;
  const empty = text.trim().length === 0;
  const look = textLook(overlay.effect, overlay.color, !!style.glow, fontPx);

  // A canvas never waits for a web font: measured before the face has arrived, the text would be
  // wrapped and sized in the fallback and then drawn in the real face, or drawn in the fallback.
  if (!empty) await loadFont(font, text);

  const measurePen = makePen(scratchContext(), font, fontPx, spacingPx);
  const lines = empty ? [' '] : wrapText(text, ctx.output.width * OVERLAY_BASE.textWrap * scale, measurePen);
  const layout = layoutText(lines, measurePen, fontPx, lineHeight, overlay.align, look);

  // Nothing typed yet: the editor draws its own placeholder, but it still needs a box the size of an
  // empty line to put it in and to hit-test.
  if (empty) return { png: transparentPng(), wPx: layout.width, hPx: layout.height };

  const k = bitmapRatio(layout.width, layout.height, ctx, detail);
  const { canvas, g } = createCanvas(layout.width * k, layout.height * k);
  g.scale(k, k);
  g.translate(layout.originX, layout.originY);
  const pen = makePen(g, font, fontPx, spacingPx);

  // Shadows and glows are drawn with the shape itself pushed off the canvas and the shadow offset
  // pulling just the shadow back into place. Drawing the shape with its shadow and then again
  // without would paint every anti-aliased edge twice and make the letters look bolder.
  const shift = (layout.width + 64) * 2;
  const eachLine = (dx: number, mode: 'fill' | 'stroke') => {
    for (const line of layout.lines) pen.draw(line.text, line.x + dx, line.baseline, mode);
  };
  const platePath = (dx: number) => {
    g.beginPath();
    for (const plate of layout.plates) roundedRectPath(g, plate.x + dx, plate.y, plate.w, plate.h, layout.plateRadius);
  };

  const { plate, glow, shadow, stroke } = look;
  if (plate) {
    g.fillStyle = plate.color;
    if (glow?.onPlate) {
      shadowOnly(g, k, shift, glow.color, glow.blur, 0, 2, (dx) => {
        platePath(dx);
        g.fill();
      });
    }
    // All plates are one path, so where two lines' plates overlap a translucent plate is painted
    // once, not darker where they meet.
    g.globalAlpha = plate.alpha;
    platePath(0);
    g.fill();
    g.globalAlpha = 1;
  }

  g.fillStyle = look.letters;
  if (glow && !glow.onPlate) {
    shadowOnly(g, k, shift, glow.color, glow.blur, 0, 2, (dx) => eachLine(dx, 'fill'));
  }
  if (shadow) {
    shadowOnly(g, k, shift, shadow.color, shadow.blur, shadow.offsetY, 1, (dx) => eachLine(dx, 'fill'));
  }
  if (stroke) {
    // Under the fill, so the outline only ever grows the letters outward and never eats into them.
    g.save();
    g.strokeStyle = stroke.color;
    g.lineWidth = stroke.width;
    g.lineJoin = 'round';
    g.miterLimit = 2;
    eachLine(0, 'stroke');
    g.restore();
  }
  g.fillStyle = look.letters;
  eachLine(0, 'fill');

  return { png: toPng(canvas), wPx: layout.width, hPx: layout.height };
}

function textLook(effect: TextEffect, color: string, glow: boolean, fontPx: number): TextLook {
  const luminance = relativeLuminance(color);
  const look: TextLook = { letters: color, plate: null, stroke: null, shadow: null, glow: null };
  switch (effect) {
    case 'none':
      break;
    case 'shadow':
      look.shadow = { color: 'rgba(0,0,0,0.55)', blur: fontPx * 0.12, offsetY: fontPx * 0.04 };
      break;
    case 'outline':
      look.stroke = { color: luminance > 0.45 ? '#000000' : '#ffffff', width: Math.max(2, fontPx * 0.15) };
      break;
    case 'plate':
      look.plate = { color, alpha: 1 };
      look.letters = luminance > 0.45 ? '#000000' : '#ffffff';
      break;
    case 'plateSoft':
      // The plate is see-through, so the video behind it darkens it: white letters stay readable on
      // everything but a very light colour.
      look.plate = { color, alpha: 0.55 };
      look.letters = luminance > 0.7 ? '#000000' : '#ffffff';
      break;
  }
  if (glow) look.glow = { color, blur: fontPx * 0.25, onPlate: !!look.plate };
  return look;
}

/**
 * Greedy word wrap of each typed line to `maxWidth`. A single word wider than a whole line is broken
 * between characters (grapheme clusters, so an emoji or an accented letter is never cut in half).
 * Trailing spaces are dropped from every line so they cannot push centred text off centre.
 */
function wrapText(text: string, maxWidth: number, pen: TextPen): string[] {
  const out: string[] = [];
  for (const typed of text.split('\n')) {
    let line = '';
    for (const word of typed.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (pen.width(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        out.push(line.trimEnd());
        line = '';
      }
      if (pen.width(word) <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = '';
      for (const character of graphemes(word)) {
        if (chunk && pen.width(chunk + character) > maxWidth) {
          out.push(chunk);
          chunk = character;
        } else {
          chunk += character;
        }
      }
      line = chunk;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * Places the lines in a text block and sizes the bitmap around it. The padding is the same on both
 * sides of each axis, so the block's centre is the bitmap's centre: the layer's `cx`/`cy` stays on
 * the text whatever effect, glow or swash widens one side, and switching effects never makes the
 * text jump.
 */
function layoutText(
  lines: string[],
  pen: TextPen,
  fontPx: number,
  lineHeight: number,
  align: TextAlign,
  look: TextLook,
): TextLayout {
  const advances = lines.map((line) => pen.width(line));
  const blockW = Math.max(1, ...advances);
  const blockH = lineHeight * lines.length;

  // How far past the glyph ink each look paints. A canvas shadow is a Gaussian with a sigma of half
  // its blur, so it has faded out by about 1.5x the blur.
  const inkExtra =
    2 +
    (look.stroke ? look.stroke.width / 2 : 0) +
    Math.max(
      look.shadow ? look.shadow.blur * 1.5 + Math.abs(look.shadow.offsetY) : 0,
      look.glow && !look.glow.onPlate ? look.glow.blur * 1.5 : 0,
    );
  const plateExtra = 2 + (look.glow?.onPlate ? look.glow.blur * 1.5 : 0);
  const plateSide = fontPx * 0.3;
  const plateOver = fontPx * 0.06;

  let minX = 0;
  let minY = 0;
  let maxX = blockW;
  let maxY = blockH;

  const placed: PlacedLine[] = lines.map((text, index) => {
    const advance = advances[index];
    const x = align === 'left' ? 0 : align === 'right' ? blockW - advance : (blockW - advance) / 2;
    const top = index * lineHeight;
    const baseline = top + lineHeight / 2 + pen.capHeight / 2;
    const ink = pen.ink(text);
    if (ink) {
      minX = Math.min(minX, x - ink.left - inkExtra);
      maxX = Math.max(maxX, x + ink.right + inkExtra);
      minY = Math.min(minY, baseline - ink.ascent - inkExtra);
      maxY = Math.max(maxY, baseline + ink.descent + inkExtra);
    }
    return { text, x, baseline, top, advance, ink };
  });

  const plates: TextLayout['plates'] = [];
  if (look.plate) {
    for (const line of placed) {
      if (!line.ink) continue;
      const left = Math.min(line.x, line.x - line.ink.left) - plateSide;
      const right = Math.max(line.x + line.advance, line.x + line.ink.right) + plateSide;
      const plate = { x: left, y: line.top - plateOver, w: right - left, h: lineHeight + plateOver * 2 };
      plates.push(plate);
      minX = Math.min(minX, plate.x - plateExtra);
      maxX = Math.max(maxX, plate.x + plate.w + plateExtra);
      minY = Math.min(minY, plate.y - plateExtra);
      maxY = Math.max(maxY, plate.y + plate.h + plateExtra);
    }
  }

  const padX = Math.ceil(Math.max(0, -minX, maxX - blockW));
  const padY = Math.ceil(Math.max(0, -minY, maxY - blockH));
  const width = Math.max(1, Math.ceil(blockW + padX * 2));
  const height = Math.max(1, Math.ceil(blockH + padY * 2));
  return {
    width,
    height,
    originX: (width - blockW) / 2,
    originY: (height - blockH) / 2,
    lines: placed,
    plates,
    plateRadius: fontPx * 0.28,
  };
}

function makePen(g: CanvasRenderingContext2D, font: string, fontPx: number, spacingPx: number): TextPen {
  g.font = font;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.direction = 'ltr';
  setLetterSpacing(g, 0);

  // Canvas `letterSpacing` (Chromium 99+) keeps kerning and shaping intact; where it is missing the
  // characters are placed one by one instead. Engines disagree on whether the spacing is also added
  // after the last character, so that is measured rather than assumed: it would otherwise push
  // centred and right-aligned text half a space off.
  let native = false;
  let trailing = 0;
  if (spacingPx !== 0 && setLetterSpacing(g, spacingPx)) {
    native = true;
    const spaced = g.measureText('H').width;
    setLetterSpacing(g, 0);
    const plain = g.measureText('H').width;
    setLetterSpacing(g, spacingPx);
    trailing = spaced - plain;
  }
  const manual = spacingPx !== 0 && !native;

  const width = (line: string): number => {
    if (!line) return 0;
    if (!manual) return Math.max(0, g.measureText(line).width - trailing);
    const parts = graphemes(line);
    let sum = 0;
    for (const part of parts) sum += g.measureText(part).width;
    return sum + spacingPx * (parts.length - 1);
  };

  return {
    capHeight: finiteOr(g.measureText('H').actualBoundingBoxAscent, fontPx * 0.7),
    width,
    ink(line) {
      if (!line.trim()) return null;
      const whole = inkBox(g.measureText(line), fontPx);
      if (!manual) return whole;
      const parts = graphemes(line);
      const first = inkBox(g.measureText(parts[0]), fontPx);
      const lastMetrics = g.measureText(parts[parts.length - 1]);
      const last = inkBox(lastMetrics, fontPx);
      return {
        left: first.left,
        right: width(line) - lastMetrics.width + last.right,
        ascent: whole.ascent,
        descent: whole.descent,
      };
    },
    draw(line, x, y, mode) {
      if (!line) return;
      if (!manual) {
        if (mode === 'fill') g.fillText(line, x, y);
        else g.strokeText(line, x, y);
        return;
      }
      let cursor = x;
      for (const part of graphemes(line)) {
        if (mode === 'fill') g.fillText(part, cursor, y);
        else g.strokeText(part, cursor, y);
        cursor += g.measureText(part).width + spacingPx;
      }
    },
  };
}

/** `font` shorthand for a style. The family is quoted unless it already is, or is a generic. */
function fontCss(style: TextStyleSpec, px: number): string {
  const family = cssFamily(style.family);
  const fallback = style.fallback?.trim();
  const weight = Math.round(Math.min(1000, Math.max(1, style.weight || 400)));
  return `${style.italic ? 'italic ' : ''}${weight} ${px}px ${fallback ? `${family}, ${fallback}` : family}`;
}

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'emoji',
  'math',
  'fangsong',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
]);

function cssFamily(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return 'sans-serif';
  if (/^["']/.test(trimmed) || trimmed.includes(',') || GENERIC_FAMILIES.has(trimmed.toLowerCase())) return trimmed;
  return `"${trimmed.replace(/"/g, '\\"')}"`;
}

/**
 * Waits for the faces `font` needs for `sample`. Never rejects: a face that fails to load leaves the
 * fallback stack to draw, which is better than no layer at all.
 */
async function loadFont(font: string, sample: string): Promise<void> {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fonts.load(font, sample),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FONT_LOAD_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // An unparsable font string or a failed download: the next family in the stack draws instead.
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Stickers, photos, effects                                                                      */
/* -------------------------------------------------------------------------------------------- */

async function rasteriseEmoji(emoji: string, scale: number, ctx: RasterContext, detail: number): Promise<RasterisedOverlay> {
  const box = Math.max(4, ctx.output.width * OVERLAY_BASE.emoji * scale);
  await loadFont(`${round2(box)}px ${EMOJI_FONTS}`, emoji);

  // Emoji fonts put very different amounts of air around a glyph, so the font size is solved from
  // the measured ink: the glyph's larger side comes out at `box` whichever font the device has.
  const measure = scratchContext();
  measure.font = `${round2(box)}px ${EMOJI_FONTS}`;
  measure.textAlign = 'left';
  measure.textBaseline = 'alphabetic';
  setLetterSpacing(measure, 0);
  const probe = inkBox(measure.measureText(emoji), box);
  const largest = Math.max(probe.left + probe.right, probe.ascent + probe.descent);
  const fontPx = largest > 0 ? Math.min(box * 2, Math.max(box * 0.5, (box * box) / largest)) : box;

  // A little air on every side, so a glyph whose ink the engine under-reports is still not clipped.
  const side = Math.ceil(box * 1.16);
  const k = bitmapRatio(side, side, ctx, detail);
  const { canvas, g } = createCanvas(side * k, side * k);
  g.scale(k, k);
  g.font = `${round2(fontPx)}px ${EMOJI_FONTS}`;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.direction = 'ltr';
  const ink = inkBox(g.measureText(emoji), fontPx);
  // A device without a colour glyph falls back to a monochrome one; white matches the dark sheet it
  // was picked from.
  g.fillStyle = '#ffffff';
  g.fillText(emoji, side / 2 - (ink.right - ink.left) / 2, side / 2 + (ink.ascent - ink.descent) / 2);

  // The square box is deliberately larger than the glyph, and no two emoji fill it the same way, so
  // what the layer ends up being is whatever was actually drawn.
  return trimToInk(canvas, g, side, side);
}

async function rasteriseSticker(assetId: string, scale: number, ctx: RasterContext, detail: number): Promise<RasterisedOverlay> {
  const url = ctx.stickerUrl(assetId);
  const image = await loadImage(url);
  const width = ctx.output.width * OVERLAY_BASE.sticker * scale;
  // A sticker asset is drawn inside its own canvas with air around it, and that air is the layer's
  // box until it is taken off.
  return drawImageLayer(image, width, width / (intrinsicAspect(image, url) ?? 1), ctx, true, detail);
}

async function rasteriseImage(overlay: ImageOverlay, ctx: RasterContext, detail: number): Promise<RasterisedOverlay> {
  const url = ctx.fileUrl(overlay.uri);
  const image = await loadImage(url);
  const width = ctx.output.width * OVERLAY_BASE.image * layerScale(overlay.scale);
  const aspect = intrinsicAspect(image, url) ?? (overlay.aspect > 0 && Number.isFinite(overlay.aspect) ? overlay.aspect : 1);
  // Not trimmed: a photo's frame is the photo, and a customer who has a picture with transparent
  // edges put it there on purpose - cropping it would silently change the picture they chose.
  return drawImageLayer(image, width, width / aspect, ctx, false, detail);
}

/**
 * How big an effect's bitmap is drawn is the effect's own business: the soft looks (gradients,
 * glows, grain that is meant to be coarse) come at half the output resolution, because a full-frame
 * PNG at full size would quadruple what crosses the bridge and what the native side has to hold for
 * nothing anyone can see, while the ones made of line art - frames, sprocket holes, a neon tube,
 * the VHS lettering - are drawn at full size, because doubling those up leaves a visibly soft edge.
 * See [effectRasterScale]. Either way `wPx`/`hPx` are the full frame, so the native side and the
 * preview stretch whatever they are given back over the whole picture. The layer's opacity is its
 * strength and is applied where the bitmap is placed, not baked in here.
 */
function rasteriseEffect(effectId: string, ctx: RasterContext): RasterisedOverlay {
  const detail = effectRasterScale(effectId);
  const { canvas, g } = createCanvas(ctx.output.width * detail, ctx.output.height * detail);
  drawEffect(g, effectId, canvas.width, canvas.height);
  return { png: toPng(canvas), wPx: ctx.output.width, hPx: ctx.output.height };
}

function drawImageLayer(
  image: HTMLImageElement,
  width: number,
  height: number,
  ctx: RasterContext,
  trim: boolean,
  detail: number,
): RasterisedOverlay {
  const wPx = Math.max(1, Math.round(width));
  const hPx = Math.max(1, Math.round(height));
  const k = bitmapRatio(wPx, hPx, ctx, detail);
  const { canvas, g } = createCanvas(wPx * k, hPx * k);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, 0, 0, canvas.width, canvas.height);
  return trim ? trimToInk(canvas, g, wPx, hPx) : { png: toPng(canvas), wPx, hPx };
}

/**
 * Width / height as the image reports it, or null when it cannot say. An SVG with a viewBox but no
 * width and height has no intrinsic size: some engines report 0, Chromium reports the 300x150
 * default object size, and neither is the sticker's shape - so both mean "unknown".
 */
function intrinsicAspect(image: HTMLImageElement, url: string): number | null {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  if (!(w > 0) || !(h > 0)) return null;
  const svg = /^data:image\/svg\+xml/i.test(url) || /\.svg(?:[?#]|$)/i.test(url);
  if (svg && w === 300 && h === 150) return null;
  return w / h;
}

/**
 * Loaded images by URL, least recently used first. The promise is what is kept, so two layers asking
 * for one sticker at the same moment share a single load, and a failed load is forgotten so the
 * next attempt tries again.
 */
const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached) {
    imageCache.delete(url);
    imageCache.set(url, cached);
    return cached;
  }

  const loading = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      // Decoding off the main thread first keeps the draw from stalling a frame. A decode that
      // fails after a successful load (seen with some SVGs) is not fatal: drawImage decodes itself.
      image.decode().then(
        () => resolve(image),
        () => resolve(image),
      );
    };
    image.onerror = () => reject(new Error(`image could not be loaded: ${url}`));
    image.src = url;
  });

  imageCache.set(url, loading);
  loading.catch(() => {
    if (imageCache.get(url) === loading) imageCache.delete(url);
  });
  while (imageCache.size > IMAGE_CACHE_SIZE) {
    const oldest = imageCache.keys().next().value;
    if (oldest === undefined) break;
    imageCache.delete(oldest);
  }
  return loading;
}

/* -------------------------------------------------------------------------------------------- */
/* Canvas plumbing                                                                                */
/* -------------------------------------------------------------------------------------------- */

function createCanvas(width: number, height: number): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas is unavailable');
  return { canvas, g };
}

function toPng(canvas: HTMLCanvasElement): string {
  try {
    return canvas.toDataURL('image/png');
  } catch (error) {
    throw new Error(`layer bitmap could not be encoded: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // A WebView keeps a canvas's pixels until the element is collected; a render draws up to thirty
    // layers in a row on a phone with little memory, so they are let go of as soon as the PNG exists.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * How many bitmap pixels a layer gets per output pixel: `detail` - 1 for a layer that never grows -
 * or less, to stay under the side cap. A moving layer asks for more than 1 and a pinched-up photo is
 * brought down, and the cap is what both answer to, so a slam on a huge sticker is no larger a bitmap
 * than the sticker already was.
 */
function bitmapRatio(width: number, height: number, ctx: RasterContext, detail = 1): number {
  const cap = Math.max(ctx.output.width, ctx.output.height) * MAX_BITMAP_SIDE_RATIO;
  return Math.min(detail, cap / Math.max(1, width, height));
}

/* -------------------------------------------------------------------------------------------- */
/* Trimming                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * Rows or columns read in one `getImageData` call. One call per line would be thousands of calls on
 * a sticker pinched up large, and the whole bitmap in one call would allocate tens of megabytes on
 * a phone; a strip is neither.
 */
const TRIM_SCAN_STRIP = 32;

/**
 * Takes the empty margin off a layer's bitmap and shrinks `wPx`/`hPx` with it, so the box the editor
 * draws a selection around and the render places is the artwork rather than the file it came in.
 *
 * The crop is the SAME on both sides of each axis - the smaller of the two margins - because a
 * layer is anchored by its centre (`cx`/`cy`): taking more off one side than the other would slide
 * the artwork across the frame and put the render somewhere the preview never showed. Ink is any
 * pixel that is not fully transparent, so a glow, a drop shadow or an anti-aliased edge counts and
 * is kept whole.
 *
 * Falls back to the untrimmed bitmap whenever there is nothing to gain, whenever nothing was drawn
 * at all (an empty layer still needs a box to hit-test), and whenever the pixels cannot be read -
 * `getImageData` throws on a canvas an image from another origin has tainted.
 */
function trimToInk(
  canvas: HTMLCanvasElement,
  g: CanvasRenderingContext2D,
  wPx: number,
  hPx: number,
): RasterisedOverlay {
  const width = canvas.width;
  const height = canvas.height;
  const margin = emptyMargin(g, width, height);
  if (!margin) return { png: toPng(canvas), wPx, hPx };

  const kept = createCanvas(width - margin.x * 2, height - margin.y * 2);
  // Whole pixels both ways, so this is a copy and not a resample: nothing is softened by the trim.
  kept.g.drawImage(canvas, -margin.x, -margin.y);
  canvas.width = 0;
  canvas.height = 0;
  // Measured before the PNG is taken, because taking it releases the canvas's pixels and with them
  // its width and height.
  const trimmed = {
    wPx: Math.max(1, Math.round((wPx * kept.canvas.width) / width)),
    hPx: Math.max(1, Math.round((hPx * kept.canvas.height) / height)),
  };
  return { png: toPng(kept.canvas), ...trimmed };
}

/**
 * How many fully transparent pixels each axis can lose from BOTH of its edges, or null when there
 * is nothing worth cropping. Reading stops at the first row or column with ink, so the work is
 * proportional to the margin being removed and not to the bitmap.
 */
function emptyMargin(g: CanvasRenderingContext2D, width: number, height: number): { x: number; y: number } | null {
  try {
    const top = emptyLines(g, width, height, false, true);
    // Nothing was drawn: there is no centre to keep and no artwork to tighten around.
    if (top >= height) return null;
    const bottom = emptyLines(g, width, height, false, false);
    const left = emptyLines(g, width, height, true, true);
    const right = emptyLines(g, width, height, true, false);
    const x = Math.min(left, right);
    const y = Math.min(top, bottom);
    return x >= 1 || y >= 1 ? { x, y } : null;
  } catch {
    // A tainted canvas cannot be read back. The layer is still perfectly good, just not tightened.
    return null;
  }
}

/**
 * The count of fully transparent lines at one edge: columns when `vertical`, rows otherwise, from
 * the left/top when `leading` and from the right/bottom when not. Returns the whole side when every
 * line is empty.
 */
function emptyLines(
  g: CanvasRenderingContext2D,
  width: number,
  height: number,
  vertical: boolean,
  leading: boolean,
): number {
  const lines = vertical ? width : height;
  const across = vertical ? height : width;
  let empty = 0;
  while (empty < lines) {
    const take = Math.min(TRIM_SCAN_STRIP, lines - empty);
    const at = leading ? empty : lines - empty - take;
    const strip = vertical ? g.getImageData(at, 0, take, height) : g.getImageData(0, at, width, take);
    const data = strip.data;
    for (let i = 0; i < take; i++) {
      // Inwards from the edge being measured, which is the far end of the strip when trailing.
      const line = leading ? i : take - 1 - i;
      // A row's pixels are next to each other; a column's are one row apart.
      const first = vertical ? line : line * width;
      const step = vertical ? take : 1;
      if (hasInk(data, first, step, across)) return empty;
      empty++;
    }
  }
  return lines;
}

/** Whether any of `count` pixels, starting at `first` and `step` pixels apart, is not transparent. */
function hasInk(data: Uint8ClampedArray, first: number, step: number, count: number): boolean {
  for (let i = 0, at = first * 4 + 3; i < count; i++, at += step * 4) {
    if (data[at] !== 0) return true;
  }
  return false;
}

let scratch: CanvasRenderingContext2D | null = null;

/** One tiny canvas reused for every measurement, rather than a new one per keystroke. */
function scratchContext(): CanvasRenderingContext2D {
  if (!scratch) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    scratch = canvas.getContext('2d');
    if (!scratch) throw new Error('2D canvas is unavailable');
  }
  return scratch;
}

let blankPng: string | null = null;

function transparentPng(): string {
  if (!blankPng) {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    blankPng = canvas.toDataURL('image/png');
  }
  return blankPng;
}

/** Pushes the letters' spacing onto a context. False where the engine has no canvas `letterSpacing`. */
function setLetterSpacing(g: CanvasRenderingContext2D, px: number): boolean {
  const target = g as { letterSpacing?: unknown };
  if (typeof target.letterSpacing !== 'string') return false;
  target.letterSpacing = `${px}px`;
  return true;
}

function inkBox(metrics: TextMetrics, fontPx: number): InkBox {
  return {
    left: finiteNumber(metrics.actualBoundingBoxLeft, 0),
    right: finiteNumber(metrics.actualBoundingBoxRight, metrics.width),
    ascent: finiteNumber(metrics.actualBoundingBoxAscent, fontPx * 0.8),
    descent: finiteNumber(metrics.actualBoundingBoxDescent, fontPx * 0.2),
  };
}

/**
 * Grapheme clusters where the engine can split them, code points where it cannot. Lazily created:
 * building a segmenter is not free and most layers never need one.
 */
let segmenter: Intl.Segmenter | null | undefined;

function graphemes(text: string): string[] {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
}

/** WCAG relative luminance, 0 (black) .. 1 (white), of any colour a canvas accepts. */
function relativeLuminance(color: string): number {
  const [r, g, b] = parseColor(color).map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Lets the canvas parse the colour, so names, `rgb()` and short hex all work, not only `#rrggbb`. */
function parseColor(color: string): [number, number, number] {
  const g = scratchContext();
  g.fillStyle = '#000000';
  g.fillStyle = color;
  const value = String(g.fillStyle);
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(value);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : [255, 255, 255];
}

/** The shadow of whatever `paint` draws, without the thing itself (see [rasteriseTextLayer]). */
function shadowOnly(
  g: CanvasRenderingContext2D,
  k: number,
  shift: number,
  color: string,
  blur: number,
  offsetY: number,
  times: number,
  paint: (dx: number) => void,
): void {
  g.save();
  // Shadow blur and offsets are in device pixels and ignore the transform, so the bitmap's own
  // downscale has to be applied to them by hand.
  g.shadowColor = color;
  g.shadowBlur = blur * k;
  g.shadowOffsetX = shift * k;
  g.shadowOffsetY = offsetY * k;
  for (let i = 0; i < times; i++) paint(-shift);
  g.restore();
}

/** A rounded rectangle added to the current path, without starting a new one. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function layerScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
