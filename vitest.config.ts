import { defineVitestConfig } from '@stencil/vitest/config';
import { playwright } from '@vitest/browser-playwright';

/*
 * Two projects, because the editor needs both kinds of test and they cannot share a runner. The
 * `stencil` environment is a mock DOM and is where pure logic belongs. The browser project is a
 * real Chromium and is the only place a component that measures layout, drives two <video>
 * elements or reads a pointer can be trusted.
 *
 * `stencil test` is not used and must not be: that runner is deprecated as of 4.43 and is removed
 * in Stencil 5.
 */
export default defineVitestConfig({
  stencilConfig: './stencil.config.ts',
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.unit.test.{ts,tsx}'],
          environment: 'stencil',
        },
      },
      {
        test: {
          name: 'browser',
          include: ['src/**/*.cmp.test.{ts,tsx}'],
          setupFiles: ['./vitest-setup.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
