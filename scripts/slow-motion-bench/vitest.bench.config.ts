import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/*
 * The benchmark harness's own runner: one headless Chromium on the machine's REAL GPU (ANGLE on
 * Direct3D 11 or Metal, below - `npm test` stays on SwiftShader, which is fifty times slower at this),
 * allowed to read the generated scenes wherever VITE_BENCH_DIR puts them and to write wherever
 * VITE_BENCH_OUT does, with no Stencil build in front of it. See README.md for the command.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const benchDir = process.env['VITE_BENCH_DIR'];
const benchOut = process.env['VITE_BENCH_OUT'];

/*
 * Which of ANGLE's backends carries WebGL to the GPU is the platform's own: Direct3D 11 on Windows,
 * where the README's tables were measured, and Metal on a Mac, which has no Direct3D - asked for d3d11
 * there, Chromium does not fail, it quietly draws every frame on SwiftShader, and the harness would
 * time and score the CPU instead. Every other platform keeps d3d11 as it always had. BENCH_ANGLE names
 * a backend outright (`vulkan`, `gl`, ...). The harnesses write the renderer they got next to their
 * output, and the interpolate harness refuses SwiftShader, so a run says what it ran on.
 */
const angle = process.env['BENCH_ANGLE'] || (process.platform === 'darwin' ? 'metal' : 'd3d11');

export default defineConfig({
  root,
  // The output directory as well as the scenes: the browser's writeFile is held to the same list.
  server: { fs: { allow: [root, ...[benchDir, benchOut].filter((dir): dir is string => !!dir)] } },
  test: {
    include: ['scripts/slow-motion-bench/*.harness.ts'],
    testTimeout: 3_600_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: [`--use-angle=${angle}`] } }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
