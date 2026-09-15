import type { EffectCategory, EffectPreset } from './raster-context';

/**
 * Full-frame looks - vignettes, light leaks, film damage, frames - drawn as transparent bitmaps.
 *
 * An effect is just another layer: the rasteriser draws it once, and the native render places it
 * over the video like a sticker, time-gated and at the layer's opacity. That is what lets a look
 * reach the posted video with no shader of its own on Android or iOS, and what makes the preview
 * honest - it shows the very same PNG.
 *
 * Every drawer works in fractions of the canvas it is given, so the effects sheet draws its small
 * thumbnails with the same function the render uses at full size, and anything random comes from a
 * PRNG seeded by the effect id, so a look never changes between the preview and the render.
 */

export const EFFECT_CATEGORIES: { id: EffectCategory; label: string }[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'film', label: 'Film' },
  { id: 'light', label: 'Light' },
  { id: 'frame', label: 'Frames' },
];

/**
 * Draws on a fresh, transparent, untransformed canvas of `w x h` device pixels. `random` is seeded by
 * the effect id, so it hands out the same sequence on every call.
 */
type Drawer = (g: CanvasRenderingContext2D, w: number, h: number, random: () => number) => void;

type Stops = ReadonlyArray<readonly [number, string]>;

interface EffectDefinition extends EffectPreset {
  draw: Drawer;
}

/**
 * The letterbox a 2.35:1 film gets on a 16:9 screen, as a fraction of the height per bar. Letterboxing
 * a PORTRAIT frame to a true 2.35:1 would leave a strip a quarter of its height, so the bars keep
 * the proportion people recognise from watching a scope film on a TV instead.
 */
const CINEMA_BAR = (1 - 16 / 9 / 2.35) / 2;

/*
 * Ids are stored in manifests, so they are permanent: renaming one would silently drop the effect
 * from saved drafts. Labels and drawings can change; ids cannot.
 */
const EFFECTS: EffectDefinition[] = [
  /* ---------------------------------------------------------------------------------------- */
  /* Basic                                                                                      */
  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'vignette',
    label: 'Vignette',
    category: 'basic',
    draw: (g, w, h) => {
      frameEllipse(g, w, h, 0.4, 1.45, [
        [0, 'rgba(0,0,0,0)'],
        [0.4, 'rgba(0,0,0,0.22)'],
        [0.75, 'rgba(0,0,0,0.62)'],
        [1, 'rgba(0,0,0,0.88)'],
      ]);
    },
  },
  {
    id: 'soft-edges',
    label: 'Soft edges',
    category: 'basic',
    draw: (g, w, h) => {
      // A faint milky veil over everything, then a haze that thickens toward the edges - the look of a
      // lens smeared at the rim, which is what "soft focus" reads as when the picture itself cannot
      // be blurred.
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(0, 0, w, h);
      frameEllipse(g, w, h, 0.45, 1.45, [
        [0, 'rgba(255,255,255,0)'],
        [0.35, 'rgba(255,250,246,0.18)'],
        [0.7, 'rgba(255,252,250,0.55)'],
        [1, 'rgba(255,255,255,0.85)'],
      ]);
    },
  },
  {
    id: 'spotlight',
    label: 'Spotlight',
    category: 'basic',
    draw: (g, w, h) => {
      const m = Math.min(w, h);
      // A little above the middle, where a face usually is in a portrait video.
      const x = w / 2;
      const y = h * 0.45;
      const reach = Math.hypot(Math.max(x, w - x), Math.max(y, h - y));
      g.fillStyle = withStops(g.createRadialGradient(x, y, m * 0.22, x, y, reach), [
        [0, 'rgba(0,0,0,0)'],
        [0.3, 'rgba(0,0,0,0.45)'],
        [1, 'rgba(0,0,0,0.85)'],
      ]);
      g.fillRect(0, 0, w, h);
      blob(g, x, y, m * 0.34, m * 0.34, 0, [
        [0, 'rgba(255,244,220,0.12)'],
        [1, 'rgba(255,244,220,0)'],
      ]);
    },
  },
  {
    id: 'dreamy',
    label: 'Dreamy',
    category: 'basic',
    draw: (g, w, h) => {
      g.fillStyle = withStops(g.createLinearGradient(0, 0, w, h), [
        [0, 'rgba(255,170,215,0.4)'],
        [0.5, 'rgba(205,185,255,0.14)'],
        [1, 'rgba(150,230,220,0.36)'],
      ]);
      g.fillRect(0, 0, w, h);
      frameEllipse(g, w, h, 0.5, 1.45, [
        [0, 'rgba(255,255,255,0)'],
        [1, 'rgba(255,248,255,0.6)'],
      ]);
      const d = Math.hypot(w, h);
      blob(g, w * 0.8, h * 0.1, d * 0.35, d * 0.35, 0, [
        [0, 'rgba(255,255,255,0.4)'],
        [1, 'rgba(255,255,255,0)'],
      ]);
    },
  },

  /* ---------------------------------------------------------------------------------------- */
  /* Film                                                                                       */
  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'grain',
    label: 'Film grain',
    category: 'film',
    draw: (g, w, h, random) => grain(g, w, h, random, 0.34),
  },
  {
    id: 'scratches',
    label: 'Scratches',
    category: 'film',
    draw: (g, w, h, random) => {
      dust(g, w, h, random, 90, 7);
      scratches(g, w, h, random, 6, 0.55);
    },
  },
  {
    id: 'vhs',
    label: 'VHS',
    category: 'film',
    draw: (g, w, h, random) => {
      const m = Math.min(w, h);
      g.fillStyle = 'rgba(60,20,110,0.08)';
      g.fillRect(0, 0, w, h);
      frameEllipse(g, w, h, 0.6, 1.5, [
        [0, 'rgba(0,0,0,0)'],
        [1, 'rgba(0,0,0,0.45)'],
      ]);

      // Scanlines about 214 to the frame height, whatever the canvas size, so a thumbnail and the
      // render show the same texture rather than one being a grey smear.
      const period = Math.max(2, Math.round(h / 214));
      const line = Math.max(1, Math.round(period / 3));
      g.fillStyle = 'rgba(0,0,0,0.2)';
      for (let y = 0; y < h; y += period) g.fillRect(0, y, w, line);

      // Tracking bands: a brighter strip broken up by short white dropouts.
      for (let band = 0; band < 2; band++) {
        const y = h * (0.15 + 0.7 * random());
        const bandHeight = h * (0.01 + 0.02 * random());
        g.fillStyle = 'rgba(255,255,255,0.07)';
        g.fillRect(0, y, w, bandHeight);
        for (let i = 0; i < 26; i++) {
          g.fillStyle = rgba('255,255,255', 0.12 + 0.3 * random());
          g.fillRect(random() * w, y + random() * bandHeight, w * (0.01 + 0.06 * random()), Math.max(1, bandHeight * 0.12));
        }
      }

      // Head-switching noise along the very bottom of the picture.
      const noiseTop = h * 0.972;
      const noiseHeight = h * 0.018;
      for (let i = 0; i < 40; i++) {
        g.fillStyle = rgba('255,255,255', 0.08 + 0.25 * random());
        g.fillRect(random() * w, noiseTop + random() * noiseHeight, w * (0.01 + 0.08 * random()), Math.max(1, noiseHeight * 0.15));
      }

      const size = Math.max(6, Math.round(m * 0.07));
      const margin = m * 0.075;
      g.font = `700 ${size}px ui-monospace, "Droid Sans Mono", "Roboto Mono", "Courier New", monospace`;
      g.textBaseline = 'alphabetic';
      const cap = finiteOr(g.measureText('P').actualBoundingBoxAscent, size * 0.72);
      const baseline = margin + cap;
      // The play triangle is a path, not "▶": that character is an emoji on Android and would come
      // out as a blue button.
      const triangleX = margin + g.measureText('PLAY').width + size * 0.45;
      vhsStamp(g, size, (dx) => {
        g.textAlign = 'left';
        g.fillText('PLAY', margin + dx, baseline);
        g.beginPath();
        g.moveTo(triangleX + dx, baseline - cap);
        g.lineTo(triangleX + dx + cap * 0.87, baseline - cap / 2);
        g.lineTo(triangleX + dx, baseline);
        g.closePath();
        g.fill();
      });
      vhsStamp(g, size, (dx) => {
        g.textAlign = 'right';
        g.fillText('SEP 15 2026', w - margin + dx, h - margin * 1.35);
      });
    },
  },
  {
    id: 'cinema',
    label: 'Cinema',
    category: 'film',
    draw: (g, w, h) => {
      const bar = Math.round(h * CINEMA_BAR);
      g.fillStyle = '#000000';
      g.fillRect(0, 0, w, bar);
      g.fillRect(0, h - bar, w, bar);
    },
  },
  {
    id: 'old-film',
    label: 'Old film',
    category: 'film',
    draw: (g, w, h, random) => {
      g.fillStyle = 'rgba(120,78,30,0.14)';
      g.fillRect(0, 0, w, h);
      frameEllipse(g, w, h, 0.55, 1.5, [
        [0, 'rgba(90,50,15,0)'],
        [0.4, 'rgba(95,52,16,0.26)'],
        [0.75, 'rgba(50,24,6,0.66)'],
        [1, 'rgba(18,8,2,0.92)'],
      ]);
      dust(g, w, h, random, 45, 4);
      scratches(g, w, h, random, 4, 0.5);
      // The grain gets a stream of its own: it takes a number per pixel, so sharing one would move
      // every speck and scratch drawn after it whenever the canvas size changes.
      grain(g, w, h, seeded('old-film/grain'), 0.28);
    },
  },

  /* ---------------------------------------------------------------------------------------- */
  /* Light                                                                                      */
  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'leak-warm',
    label: 'Warm leak',
    category: 'light',
    draw: (g, w, h) => {
      const d = Math.hypot(w, h);
      blob(g, w * 1.02, h * 0.1, d * 0.55, d * 0.55, 0, [
        [0, 'rgba(255,240,200,0.85)'],
        [0.22, 'rgba(255,160,70,0.62)'],
        [0.55, 'rgba(255,80,40,0.26)'],
        [1, 'rgba(255,50,30,0)'],
      ]);
      blob(g, w * 0.62, h * 0.3, d * 0.42, d * 0.07, -1, [
        [0, 'rgba(255,210,140,0.4)'],
        [1, 'rgba(255,150,80,0)'],
      ]);
      blob(g, -w * 0.06, h * 0.86, d * 0.36, d * 0.36, 0, [
        [0, 'rgba(255,200,90,0.5)'],
        [0.5, 'rgba(255,120,40,0.2)'],
        [1, 'rgba(255,90,30,0)'],
      ]);
    },
  },
  {
    id: 'leak-cool',
    label: 'Cool leak',
    category: 'light',
    draw: (g, w, h) => {
      const d = Math.hypot(w, h);
      blob(g, -w * 0.04, h * 0.22, d * 0.5, d * 0.5, 0, [
        [0, 'rgba(215,248,255,0.8)'],
        [0.25, 'rgba(90,180,255,0.55)'],
        [0.6, 'rgba(120,90,255,0.24)'],
        [1, 'rgba(110,70,255,0)'],
      ]);
      blob(g, w * 0.35, h * 0.42, d * 0.4, d * 0.06, 1, [
        [0, 'rgba(160,220,255,0.35)'],
        [1, 'rgba(120,180,255,0)'],
      ]);
      blob(g, w * 1.05, h * 0.9, d * 0.34, d * 0.34, 0, [
        [0, 'rgba(255,130,235,0.45)'],
        [0.5, 'rgba(190,90,255,0.18)'],
        [1, 'rgba(160,80,255,0)'],
      ]);
    },
  },
  {
    id: 'sunset',
    label: 'Sunset glow',
    category: 'light',
    draw: (g, w, h) => {
      g.fillStyle = withStops(g.createLinearGradient(0, 0, 0, h * 0.6), [
        [0, 'rgba(255,84,64,0.5)'],
        [0.45, 'rgba(255,150,60,0.26)'],
        [1, 'rgba(255,190,90,0)'],
      ]);
      g.fillRect(0, 0, w, h);
      g.fillStyle = withStops(g.createLinearGradient(0, h, 0, h * 0.55), [
        [0, 'rgba(110,36,150,0.45)'],
        [1, 'rgba(220,80,140,0)'],
      ]);
      g.fillRect(0, 0, w, h);
      const d = Math.hypot(w, h);
      blob(g, w * 0.74, h * 0.16, d * 0.3, d * 0.3, 0, [
        [0, 'rgba(255,246,205,0.8)'],
        [0.18, 'rgba(255,205,120,0.5)'],
        [1, 'rgba(255,120,60,0)'],
      ]);
    },
  },
  {
    id: 'rainbow',
    label: 'Rainbow',
    category: 'light',
    draw: (g, w, h) => {
      // A prism band across the top-left corner...
      const band = g.createLinearGradient(0, 0, w, h * 0.7);
      const hues = ['255,70,70', '255,160,50', '255,235,70', '90,225,120', '70,160,255', '160,100,255'];
      band.addColorStop(0.05, 'rgba(255,70,70,0)');
      hues.forEach((rgb, i) => band.addColorStop(0.1 + i * 0.05, rgba(rgb, 0.38)));
      band.addColorStop(0.41, 'rgba(160,100,255,0)');
      g.fillStyle = band;
      g.fillRect(0, 0, w, h);
      // ...fading out along its length the way a real leak falls off. `destination-in` is safe here
      // because every drawer paints on a canvas of its own (see [drawEffect]).
      const d = Math.hypot(w, h);
      g.globalCompositeOperation = 'destination-in';
      g.fillStyle = withStops(g.createRadialGradient(0, 0, 0, 0, 0, d * 0.62), [
        [0, 'rgba(0,0,0,1)'],
        [0.55, 'rgba(0,0,0,0.85)'],
        [1, 'rgba(0,0,0,0)'],
      ]);
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
      blob(g, w * 0.2, h * 0.14, d * 0.2, d * 0.2, 0, [
        [0, 'rgba(255,255,255,0.28)'],
        [1, 'rgba(255,255,255,0)'],
      ]);
    },
  },
  {
    id: 'bokeh',
    label: 'Bokeh',
    category: 'light',
    draw: (g, w, h, random) => {
      const m = Math.min(w, h);
      const tints = ['255,255,255', '255,226,170', '255,176,205', '190,220,255'];
      for (let i = 0; i < 30; i++) {
        const x = random() * w;
        const y = random() * h;
        const r = m * (0.025 + 0.09 * random() ** 2);
        // Calmer toward the middle, where the subject of the video usually is.
        const edge = Math.min(1, Math.hypot((x / w - 0.5) * 2, (y / h - 0.5) * 2));
        const a = (0.22 + 0.4 * random()) * (0.35 + 0.65 * edge);
        const rgb = tints[Math.floor(random() * tints.length)];
        // Brighter toward the rim, like an out-of-focus highlight through a real aperture.
        g.fillStyle = withStops(g.createRadialGradient(x, y, 0, x, y, r), [
          [0, rgba(rgb, a * 0.55)],
          [0.72, rgba(rgb, a * 0.75)],
          [0.9, rgba(rgb, a)],
          [1, rgba(rgb, 0)],
        ]);
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
      for (let i = 0; i < 8; i++) {
        sparkle(g, random() * w, random() * h, m * (0.018 + 0.035 * random()), 0.6 + 0.4 * random());
      }
    },
  },

  /* ---------------------------------------------------------------------------------------- */
  /* Frames                                                                                     */
  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'polaroid',
    label: 'Polaroid',
    category: 'frame',
    draw: (g, w, h) => {
      const side = w * 0.065;
      const bottom = h * 0.16;
      const iw = w - side * 2;
      const ih = h - side - bottom;
      g.fillStyle = withStops(g.createLinearGradient(0, 0, 0, h), [
        [0, '#fbfaf5'],
        [1, '#ece8de'],
      ]);
      g.beginPath();
      g.rect(0, 0, w, h);
      g.rect(side, side, iw, ih);
      g.fill('evenodd');
      // A faint shadow where the photo meets the card, so the border reads as a print rather than a
      // flat white mask.
      const lip = Math.max(1, w * 0.024);
      g.fillStyle = withStops(g.createLinearGradient(0, side, 0, side + lip), [
        [0, 'rgba(0,0,0,0.22)'],
        [1, 'rgba(0,0,0,0)'],
      ]);
      g.fillRect(side, side, iw, lip);
      g.strokeStyle = 'rgba(0,0,0,0.14)';
      g.lineWidth = Math.max(1, w * 0.003);
      g.strokeRect(side, side, iw, ih);
    },
  },
  {
    id: 'film-strip',
    label: 'Film strip',
    category: 'frame',
    draw: (g, w, h) => {
      const band = w * 0.12;
      const holeW = band * 0.42;
      const holeH = holeW * 0.72;
      const pitch = holeH * 2.1;
      const count = Math.max(1, Math.floor(h / pitch));
      const first = (h - count * pitch) / 2 + (pitch - holeH) / 2;
      // The sprocket holes are subpaths of the bands, so the even-odd fill punches them out and the
      // video shows through them.
      g.beginPath();
      g.rect(0, 0, band, h);
      g.rect(w - band, 0, band, h);
      for (let i = 0; i < count; i++) {
        const y = first + i * pitch;
        roundRectSubpath(g, (band - holeW) / 2, y, holeW, holeH, holeW * 0.2);
        roundRectSubpath(g, w - band + (band - holeW) / 2, y, holeW, holeH, holeW * 0.2);
      }
      g.fillStyle = '#15110e';
      g.fill('evenodd');
      const edge = Math.max(1, w * 0.004);
      g.fillStyle = 'rgba(255,255,255,0.1)';
      g.fillRect(band - edge, 0, edge, h);
      g.fillRect(w - band, 0, edge, h);
    },
  },
  {
    id: 'rounded',
    label: 'Rounded',
    category: 'frame',
    draw: (g, w, h) => {
      const m = Math.min(w, h);
      const t = m * 0.06;
      g.beginPath();
      g.rect(0, 0, w, h);
      roundRectSubpath(g, t, t, w - t * 2, h - t * 2, m * 0.09);
      g.fillStyle = '#ffffff';
      g.fill('evenodd');
    },
  },
  {
    id: 'neon',
    label: 'Neon',
    category: 'frame',
    draw: (g, w, h) => {
      const m = Math.min(w, h);
      const inset = m * 0.075;
      const tube = Math.max(1.5, m * 0.013);
      const outline = () => {
        g.beginPath();
        roundRectSubpath(g, inset, inset, w - inset * 2, h - inset * 2, m * 0.09);
      };
      g.strokeStyle = withStops(g.createLinearGradient(0, 0, w, h), [
        [0, '#ff3dcb'],
        [0.5, '#a64dff'],
        [1, '#2ee9ff'],
      ]);
      g.lineJoin = 'round';
      // The glow is the tube itself blurred, so it changes colour along the frame with the tube; a
      // canvas shadow could only glow in one colour. Without `filter` support the passes are drawn
      // sharp and faint instead, which still reads as a lit edge.
      const canBlur = supportsFilter(g);
      const passes: [number, number, number][] = [
        [tube * 4, m * 0.035, 0.3],
        [tube * 2, m * 0.012, 0.45],
      ];
      for (const [width, blur, fallbackAlpha] of passes) {
        g.save();
        if (canBlur) g.filter = `blur(${blur}px)`;
        else g.globalAlpha = fallbackAlpha;
        g.lineWidth = width;
        outline();
        g.stroke();
        g.restore();
      }
      g.lineWidth = tube;
      outline();
      g.stroke();
      g.lineWidth = Math.max(0.75, tube * 0.35);
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      outline();
      g.stroke();
    },
  },
  {
    id: 'hearts',
    label: 'Hearts',
    category: 'frame',
    draw: (g, w, h) => {
      const m = Math.min(w, h);
      // [x, y] as fractions of the frame, size as a fraction of its shorter side, tilt in degrees.
      const hearts: [number, number, number, number, string][] = [
        [0.14, 0.085, 0.17, -18, '#ff4f8b'],
        [0.31, 0.05, 0.095, 14, '#ff9cc2'],
        [0.075, 0.2, 0.08, -28, '#ffffff'],
        [0.86, 0.915, 0.17, 18, '#ff4f8b'],
        [0.69, 0.95, 0.095, -14, '#ff9cc2'],
        [0.925, 0.8, 0.08, 28, '#ffffff'],
      ];
      for (const [x, y, size, tilt, colour] of hearts) heart(g, x * w, y * h, size * m, tilt, colour);
      sparkle(g, w * 0.24, h * 0.14, m * 0.025, 0.9);
      sparkle(g, w * 0.4, h * 0.075, m * 0.016, 0.8);
      sparkle(g, w * 0.76, h * 0.86, m * 0.025, 0.9);
      sparkle(g, w * 0.6, h * 0.93, m * 0.016, 0.8);
    },
  },
  {
    id: 'viewfinder',
    label: 'Viewfinder',
    category: 'frame',
    draw: (g, w, h) => {
      const m = Math.min(w, h);
      const inset = m * 0.08;
      const arm = m * 0.13;
      const stroke = Math.max(1.5, m * 0.012);
      g.strokeStyle = '#ffffff';
      g.fillStyle = '#ffffff';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      // A soft dark halo keeps the white marks readable over a bright sky.
      g.shadowColor = 'rgba(0,0,0,0.35)';
      g.shadowBlur = m * 0.02;

      g.lineWidth = stroke;
      g.beginPath();
      const corners: [number, number, number, number][] = [
        [inset, inset, 1, 1],
        [w - inset, inset, -1, 1],
        [inset, h - inset, 1, -1],
        [w - inset, h - inset, -1, -1],
      ];
      for (const [x, y, dx, dy] of corners) {
        g.moveTo(x + dx * arm, y);
        g.lineTo(x, y);
        g.lineTo(x, y + dy * arm);
      }
      g.stroke();

      const cross = m * 0.04;
      g.lineWidth = stroke * 0.7;
      g.beginPath();
      g.moveTo(w / 2 - cross, h / 2);
      g.lineTo(w / 2 + cross, h / 2);
      g.moveTo(w / 2, h / 2 - cross);
      g.lineTo(w / 2, h / 2 + cross);
      g.stroke();

      const rowY = inset + m * 0.07;
      const dot = m * 0.02;
      const dotX = inset + m * 0.07;
      g.fillStyle = '#ff3040';
      g.beginPath();
      g.arc(dotX, rowY, dot, 0, Math.PI * 2);
      g.fill();
      const size = Math.max(6, Math.round(m * 0.055));
      g.fillStyle = '#ffffff';
      g.font = `700 ${size}px system-ui, Roboto, sans-serif`;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText('REC', dotX + dot + m * 0.02, rowY);

      // Battery, top right.
      const bw = m * 0.075;
      const bh = m * 0.036;
      const bx = w - inset - m * 0.05 - bw;
      const by = rowY - bh / 2;
      g.lineWidth = Math.max(1, stroke * 0.6);
      g.strokeRect(bx, by, bw, bh);
      g.fillRect(bx + bw, by + bh * 0.3, Math.max(1, bw * 0.08), bh * 0.4);
      const gap = Math.max(1, bh * 0.2);
      g.fillRect(bx + gap, by + gap, (bw - gap * 2) * 0.75, bh - gap * 2);
    },
  },
];

const BY_ID = new Map(EFFECTS.map((effect) => [effect.id, effect]));

export const EFFECT_PRESETS: EffectPreset[] = EFFECTS.map(({ id, label, category }) => ({ id, label, category }));

export function effectPreset(id: string): EffectPreset | null {
  const effect = BY_ID.get(id);
  return effect ? { id: effect.id, label: effect.label, category: effect.category } : null;
}

/**
 * Draws an effect over `(0, 0, width, height)` of `g`, in `g`'s own coordinates. An unknown id draws
 * nothing, so a draft saved by a newer build still opens.
 *
 * The drawing happens on a canvas of its own at `g`'s device resolution and is then composited onto
 * `g`. That buys two things: canvas shadows and blur filters ignore the transform, so a drawer that
 * never sees one gets them right on a HiDPI thumbnail too; and a drawer may use destructive
 * composite modes without wiping whatever the caller had already drawn underneath.
 */
export function drawEffect(g: CanvasRenderingContext2D, effectId: string, width: number, height: number): void {
  const effect = BY_ID.get(effectId);
  if (!effect || !(width > 0) || !(height > 0)) return;

  const resolution = deviceScale(g);
  const layer = document.createElement('canvas');
  layer.width = Math.max(1, Math.round(width * resolution));
  layer.height = Math.max(1, Math.round(height * resolution));
  const lg = layer.getContext('2d');
  if (!lg) return;

  effect.draw(lg, layer.width, layer.height, seeded(effect.id));

  g.save();
  g.imageSmoothingEnabled = true;
  g.drawImage(layer, 0, 0, width, height);
  g.restore();
  // A WebView holds a canvas's pixels until the element is collected; let go of them now.
  layer.width = 0;
  layer.height = 0;
}

/* -------------------------------------------------------------------------------------------- */
/* Drawing helpers                                                                                */
/* -------------------------------------------------------------------------------------------- */

function deviceScale(g: CanvasRenderingContext2D): number {
  if (typeof g.getTransform !== 'function') return 1;
  const t = g.getTransform();
  const scale = Math.max(Math.hypot(t.a, t.b), Math.hypot(t.c, t.d));
  return Number.isFinite(scale) && scale > 0 ? Math.min(scale, 4) : 1;
}

function withStops<T extends CanvasGradient>(gradient: T, stops: Stops): T {
  for (const [at, colour] of stops) gradient.addColorStop(at, colour);
  return gradient;
}

/**
 * A radial gradient stretched to the frame's own aspect ratio: radius 1 touches the middle of each
 * edge and ~1.41 reaches the corners, on a portrait video and a square thumbnail alike.
 */
function frameEllipse(g: CanvasRenderingContext2D, w: number, h: number, r0: number, r1: number, stops: Stops): void {
  g.save();
  g.translate(w / 2, h / 2);
  g.scale(w / 2, h / 2);
  g.fillStyle = withStops(g.createRadialGradient(0, 0, r0, 0, 0, r1), stops);
  g.fillRect(-1, -1, 2, 2);
  g.restore();
}

/** A soft glow. `ry` below `rx` and an angle stretch it into a streak. The last stop must be clear. */
function blob(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  angle: number,
  stops: Stops,
): void {
  if (!(rx > 0) || !(ry > 0)) return;
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.scale(1, ry / rx);
  g.fillStyle = withStops(g.createRadialGradient(0, 0, 0, 0, 0, rx), stops);
  g.beginPath();
  g.arc(0, 0, rx, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/**
 * Monochrome film grain, one value per pixel (or per 2x2 block on a canvas twice the render's size,
 * so the grain keeps its size relative to the frame). Mostly faint specks with a few strong ones, and
 * as many light as dark, so the picture's overall brightness does not shift.
 *
 * About a third of the pixels are left clear and the strength comes in a few steps rather than 256.
 * Nobody can see the difference in moving grain, but pure noise is the worst case for PNG: at full
 * precision a grain frame is over a megabyte of base64 to push across the bridge.
 */
function grain(g: CanvasRenderingContext2D, w: number, h: number, random: () => number, strength: number): void {
  const levels = 5;
  const cell = Math.max(1, Math.round(Math.min(w, h) / 360));
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const noise = document.createElement('canvas');
  noise.width = cols;
  noise.height = rows;
  const ng = noise.getContext('2d');
  if (!ng) return;
  const image = ng.createImageData(cols, rows);
  const data = image.data;
  const max = 255 * strength;
  for (let i = 0; i < data.length; i += 4) {
    if (random() < 0.35) continue;
    const shade = random() < 0.5 ? 0 : 255;
    const v = random();
    const alpha = (Math.ceil(v * v * levels) / levels) * max;
    data[i] = shade;
    data[i + 1] = shade;
    data[i + 2] = shade;
    data[i + 3] = alpha;
  }
  ng.putImageData(image, 0, 0);
  g.save();
  g.imageSmoothingEnabled = false;
  g.drawImage(noise, 0, 0, cols * cell, rows * cell);
  g.restore();
  noise.width = 0;
  noise.height = 0;
}

/** Long, slightly wandering vertical scratches, mostly light (emulsion scraped off) and some dark. */
function scratches(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  random: () => number,
  count: number,
  alpha: number,
): void {
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 0; i < count; i++) {
    const startX = random() * w;
    const top = random() * h * 0.35;
    const bottom = h - random() * h * 0.35;
    const light = random() < 0.6;
    const a = alpha * (0.35 + 0.65 * random());
    g.strokeStyle = light ? rgba('255,250,240', a) : rgba('20,14,8', a);
    g.lineWidth = Math.max(0.6, w * (0.0015 + 0.003 * random()));
    g.beginPath();
    g.moveTo(startX, top);
    let x = startX;
    const steps = 6;
    for (let s = 1; s <= steps; s++) {
      x += (random() - 0.5) * w * 0.012;
      g.lineTo(x, top + ((bottom - top) * s) / steps);
    }
    g.stroke();
  }
  g.restore();
}

/** Dust specks of uneven shape and a few curled hairs. */
function dust(g: CanvasRenderingContext2D, w: number, h: number, random: () => number, specks: number, hairs: number): void {
  const m = Math.min(w, h);
  g.save();
  for (let i = 0; i < specks; i++) {
    const x = random() * w;
    const y = random() * h;
    const size = m * (0.002 + 0.01 * random() ** 3);
    const dark = random() < 0.7;
    const a = 0.35 + 0.5 * random();
    g.fillStyle = dark ? rgba('18,12,6', a) : rgba('255,252,245', a * 0.85);
    const rx = Math.max(0.5, size * (0.6 + 0.8 * random()));
    const ry = Math.max(0.5, size * (0.4 + 0.6 * random()));
    const rotation = random() * Math.PI;
    g.beginPath();
    g.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
    g.fill();
  }
  g.lineCap = 'round';
  for (let i = 0; i < hairs; i++) {
    const x = random() * w;
    const y = random() * h;
    const length = m * (0.04 + 0.08 * random());
    const angle = random() * Math.PI * 2;
    const ex = x + Math.cos(angle) * length;
    const ey = y + Math.sin(angle) * length;
    g.strokeStyle = rgba('15,10,5', 0.45 + 0.35 * random());
    g.lineWidth = Math.max(0.5, m * 0.0025);
    const c1x = x + (random() - 0.5) * length;
    const c1y = y + (random() - 0.5) * length;
    const c2x = ex + (random() - 0.5) * length;
    const c2y = ey + (random() - 0.5) * length;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(c1x, c1y, c2x, c2y, ex, ey);
    g.stroke();
  }
  g.restore();
}

/** Draws a VHS on-screen-display mark with the red/cyan fringe of a worn tape. */
function vhsStamp(g: CanvasRenderingContext2D, size: number, paint: (dx: number) => void): void {
  const offset = Math.max(0.6, size * 0.06);
  g.save();
  g.fillStyle = 'rgba(255,40,100,0.7)';
  paint(-offset);
  g.fillStyle = 'rgba(40,220,255,0.7)';
  paint(offset);
  g.shadowColor = 'rgba(0,0,0,0.4)';
  g.shadowBlur = size * 0.3;
  g.fillStyle = '#ffffff';
  paint(0);
  g.restore();
}

/** A four-pointed glint. */
function sparkle(g: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number): void {
  const waist = size * 0.14;
  g.save();
  g.translate(x, y);
  g.fillStyle = rgba('255,255,255', alpha);
  g.shadowColor = rgba('255,255,255', alpha);
  g.shadowBlur = size * 0.8;
  g.beginPath();
  g.moveTo(0, -size);
  g.quadraticCurveTo(waist, -waist, size, 0);
  g.quadraticCurveTo(waist, waist, 0, size);
  g.quadraticCurveTo(-waist, waist, -size, 0);
  g.quadraticCurveTo(-waist, -waist, 0, -size);
  g.closePath();
  g.fill();
  g.restore();
}

/** A heart centred on `(x, y)`, `size` wide, tilted clockwise by `degrees`. */
function heart(g: CanvasRenderingContext2D, x: number, y: number, size: number, degrees: number, colour: string): void {
  const s = size / 2;
  g.save();
  g.translate(x, y);
  g.rotate((degrees * Math.PI) / 180);
  g.shadowColor = 'rgba(0,0,0,0.28)';
  g.shadowBlur = size * 0.18;
  g.shadowOffsetY = size * 0.05;
  // Two cubic lobes meeting at the dip, spanning about -0.75s..0.75s both ways, so (x, y) is the
  // visual centre rather than the top of the dip.
  g.beginPath();
  g.moveTo(0, s * 0.75);
  g.bezierCurveTo(-s * 1.25, -s * 0.1, -s * 0.75, -s * 1.2, 0, -s * 0.6);
  g.bezierCurveTo(s * 0.75, -s * 1.2, s * 1.25, -s * 0.1, 0, s * 0.75);
  g.closePath();
  g.fillStyle = colour;
  g.fill();
  g.shadowColor = 'rgba(0,0,0,0)';
  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.beginPath();
  g.ellipse(-s * 0.42, -s * 0.55, s * 0.2, s * 0.12, -0.7, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** A rounded rectangle added to the current path, without starting a new one. */
function roundRectSubpath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  g.moveTo(x + radius, y);
  g.arcTo(x + w, y, x + w, y + h, radius);
  g.arcTo(x + w, y + h, x, y + h, radius);
  g.arcTo(x, y + h, x, y, radius);
  g.arcTo(x, y, x + w, y, radius);
  g.closePath();
}

function supportsFilter(g: CanvasRenderingContext2D): boolean {
  return typeof (g as { filter?: unknown }).filter === 'string';
}

function rgba(rgb: string, alpha: number): string {
  return `rgba(${rgb},${Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000})`;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * mulberry32 seeded with the FNV-1a hash of `key`: tiny, fast, and the same sequence on every engine,
 * which `Math.random` could never promise.
 */
function seeded(key: string): () => number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
