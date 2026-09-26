import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';

import type { ComposeSpec } from '../../src/video-composer/definitions';
import { renderSpec } from '../../src/video-composer/web/render';

/**
 * The benchmark post exported by the WEB engine - the real `renderSpec`, decoder, painter and encoder
 * - so it can be held against the same post exported on a phone (the parity check in README.md): the
 * whole of generate.sh's `bench-30fps.mp4`, slowed to 0.5x and to 0.25x, at 720x1280 and 30 fps, to
 * VITE_BENCH_OUT/web-bench05.mp4 and web-bench025.mp4. VITE_BENCH_FILTER (a JSON list of `FilterOp`s)
 * grades the post, VITE_BENCH_SPEEDS (`0.5,0.25`) picks the speeds and VITE_BENCH_TAG is added to the
 * names - a graded post is the one place the two engines see the frames differently before the flow.
 *
 * Not part of `npm test`: run it through vitest.bench.config.ts (see README.md).
 */

const env = import.meta.env as unknown as Record<string, string | undefined>;
const DIR = env['VITE_BENCH_DIR'] ?? '';
// The URL Vite makes for a file outside the root: `/@fs/C:/...` on Windows, `/@fs/Users/...` for a
// POSIX path - the path without its leading slash, which the dev server puts back.
const FS = `/@fs/${DIR.replace(/^\//, '')}`;
const OUT = env['VITE_BENCH_OUT'] ?? `${DIR}/out`;
const FILTER = JSON.parse(env['VITE_BENCH_FILTER'] ?? '[]') as ComposeSpec['filter'];
const SPEEDS = (env['VITE_BENCH_SPEEDS'] ?? '0.5,0.25').split(',').map(Number);
const TAG = env['VITE_BENCH_TAG'] ?? '';

/** The renderer WebGL really draws with, so a timing says whether it was the GPU or SwiftShader's CPU. */
function renderer(): string {
  const gl = document.createElement('canvas').getContext('webgl2');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const name = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'no WebGL 2';
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}

function spec(uri: string, speed: number): ComposeSpec {
  return {
    jobId: `bench-${speed}`,
    batchId: `bench-${speed}`,
    clips: [{ key: 'bench', uri, inMs: 0, outMs: 6000, speed, volume: 1, muted: true, fit: 'cover' }],
    output: { width: 720, height: 1280, fps: 30, videoBitrate: 20_000_000, audioBitrate: 128_000 },
    filter: FILTER,
    overlays: [],
    audio: { originalMuted: true, originalVolume: 1, music: null, voiceover: [] },
    posterAtMs: 0,
  };
}

it('exports the benchmark post at 0.5x and 0.25x', async () => {
  expect(DIR, 'VITE_BENCH_DIR').not.toBe('');
  const response = await fetch(`${FS}/bench-30fps.mp4`);
  expect(response.ok).toBe(true);
  const source = URL.createObjectURL(await response.blob());
  try {
    for (const speed of SPEEDS) {
      const name = `web-bench${String(speed).replace('0.', '0')}${TAG}`;
      const started = performance.now();
      const outcome = await renderSpec(spec(source, speed), { signal: new AbortController().signal, onProgress: () => undefined });
      const rendered = performance.now() - started;
      const bytes = new Uint8Array(await outcome.blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await commands.writeFile(`${OUT}/${name}.mp4`, btoa(binary), 'base64');
      // The first line is the whole run, file written, as it always was; the render alone follows it.
      const lines = [`${Math.round(performance.now() - started)} ms`, `render ${Math.round(rendered)} ms`, `renderer: ${renderer()}`];
      await commands.writeFile(`${OUT}/${name}.txt`, lines.join('\n') + '\n');
    }
  } finally {
    URL.revokeObjectURL(source);
  }
});
