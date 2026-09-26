import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';

import { Painter, WHOLE_FRAME, type PainterOptions } from '../../src/video-composer/web/painter';

/**
 * The web engine's missing frames for the benchmark scenes (generate.sh), drawn by the REAL painter on
 * a real GPU - the same prepass, flow passes and layer shader an export runs - and written out as PNGs
 * for score.sh to hold against the frames that really were there.
 *
 * For every recorded pair (frames n and n+4 of the 120 fps scene) it draws the three missing frames a
 * 0.25x slow-down makes, at 0.25, 0.5 and 0.75 of the way, which are frames n+1, n+2 and n+3; 0.5x is
 * the middle one of each. Each method gets a painter of its own, and the pair is held as bitmaps and
 * let go of exactly as the export's reader does.
 *
 * Not part of `npm test`: run it through vitest.bench.config.ts (see README.md).
 */

const env = import.meta.env as unknown as Record<string, string | undefined>;
const DIR = env['VITE_BENCH_DIR'] ?? '';
// The URL Vite makes for a file outside the root: `/@fs/C:/...` on Windows, `/@fs/Users/...` for a
// POSIX path - the path without its leading slash, which the dev server puts back.
const FS = `/@fs/${DIR.replace(/^\//, '')}`;
const OUT = env['VITE_BENCH_OUT'] ?? `${DIR}/out`;
const SCENES = (env['VITE_BENCH_SCENES'] ?? 'panzoom,objects,whip,static,cut,flash').split(',');
const METHODS = (env['VITE_BENCH_METHODS'] ?? 'blend,flow').split(',') as NonNullable<PainterOptions['interpolation']>[];
const FRAMES = 120;

const pad = (n: number) => String(n).padStart(3, '0');

async function load(scene: string, n: number): Promise<ImageBitmap> {
  const response = await fetch(`${FS}/${scene}/f${pad(n)}.png`);
  if (!response.ok) throw new Error(`${scene}/f${pad(n)}.png: ${response.status}`);
  return await createImageBitmap(await response.blob());
}

async function save(canvas: HTMLCanvasElement, path: string): Promise<void> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('no PNG'))), 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await commands.writeFile(path, btoa(binary), 'base64');
}

/**
 * The renderer WebGL really draws with. `usesGpu` only says the painter got a context, which it also
 * gets on SwiftShader - the CPU pretending to be a GPU, far too slow to time and not what ships.
 */
function renderer(): string {
  const gl = document.createElement('canvas').getContext('webgl2');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const name = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'no WebGL 2';
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}

it('draws every missing frame of every scene', async () => {
  expect(DIR, 'VITE_BENCH_DIR').not.toBe('');
  const gpu = renderer();
  expect(gpu, 'the benchmark needs a real GPU, not SwiftShader').not.toMatch(/SwiftShader|no WebGL/i);
  const report: string[] = [`renderer: ${gpu}`];
  for (const method of METHODS) {
    for (const scene of SCENES) {
      let a = await load(scene, 0);
      const painter = new Painter({ width: a.width, height: a.height }, undefined, { interpolation: method });
      expect(painter.usesGpu, 'the benchmark needs the GPU path').toBe(true);
      painter.setColour(null, { filter: 'none', tints: [] });
      let drawn = 0;
      let paintMs = 0;
      for (let n = 0; n + 4 < FRAMES; n += 4) {
        const b = await load(scene, n + 4);
        for (const k of [1, 2, 3]) {
          const started = performance.now();
          painter.paintLayers([
            { source: a, sourceWidth: a.width, sourceHeight: a.height, framing: { fit: 'contain' }, dest: WHOLE_FRAME, opacity: 1, tween: { source: b, weight: k / 4 } },
          ]);
          paintMs += performance.now() - started;
          drawn++;
          await save(painter.frame, `${OUT}/${method}/${scene}/f${pad(n + k)}.png`);
        }
        painter.forget(a);
        a.close();
        a = b;
      }
      painter.forget(a);
      a.close();
      painter.dispose();
      report.push(`${method} ${scene}: ${drawn} frames, ${(paintMs / drawn).toFixed(2)} ms a paint`);
    }
  }
  await commands.writeFile(`${OUT}/harness.txt`, report.join('\n') + '\n');
});
