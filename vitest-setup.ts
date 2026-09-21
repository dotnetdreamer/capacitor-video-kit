/*
 * Registers every component from the build `stencil-test` has just made out of the working tree;
 * the output target it comes from is in stencil.test.config.ts, and says why it is there.
 *
 * This used to import `./loader`, which re-exports `dist/esm/loader.js`: the PUBLISHED build, which
 * `npm test` deliberately never writes. Every browser test therefore ran against whatever
 * `npm run build` last left in `dist/`, and a component edited or reverted since made no difference
 * to a single assertion. It is how a fix landed with tests beside it that passed without it.
 *
 * A plain import, because the lazy build's entry registers every tag as it is evaluated: there is
 * nothing to call, and nothing else in the bundle is wanted here.
 */
import './.stencil-test-build/www/build/capacitor-video-kit.esm.js';
