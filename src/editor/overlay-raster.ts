/**
 * Rasterises a text overlay to a transparent PNG at OUTPUT pixel scale.
 *
 * This is the caller's half of the overlay contract: the native engines place bitmaps and nothing
 * else - no fonts, no text layout, no SVG - which is what lets the same overlay land identically on
 * Android, iOS and a browser preview. Drawing it here rather than natively is the whole point, so
 * the lab does it the same way a real editor would.
 */

export interface RasterisedOverlay {
  /** `data:image/png;base64,...` */
  png: string;
  /** Size in OUTPUT pixels - the scale is already baked into the bitmap. */
  wPx: number;
  hPx: number;
}

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
    roundedRect(ctx, 0, 0, width, height, Math.round(style.fontSizePx * CORNER_RATIO));
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

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
