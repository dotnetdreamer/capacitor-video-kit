import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/*
 * The benchmark harness's own runner: one headless Chromium on the machine's REAL GPU (ANGLE on
 * Direct3D 11 here - `npm test` stays on SwiftShader, which is fifty times slower at this), allowed to
 * read the generated scenes wherever VITE_BENCH_DIR puts them, with no Stencil build in front of it.
 * See README.md for the command.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const benchDir = process.env['VITE_BENCH_DIR'];

export default defineConfig({
  root,
  server: { fs: { allow: [root, ...(benchDir ? [benchDir] : [])] } },
  test: {
    include: ['scripts/slow-motion-bench/*.harness.ts'],
    testTimeout: 3_600_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { args: ['--use-angle=d3d11'] } }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
