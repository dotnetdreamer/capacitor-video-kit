import { describe, expect, it } from 'vitest';

import { setEditorAssetPath } from './asset-path';
import { installEditorFonts } from './fonts';

/*
 * A browser test rather than a unit test, although nothing here is a component. `FontFace` and
 * `document.fonts` are the two things being tested and the mock DOM has neither, so a real Chromium
 * is the only place the probe can actually fail to fetch.
 *
 * One test only, because `installEditorFonts` memoises its promise on purpose: a second call is the
 * same promise and proves nothing new.
 */
describe('installEditorFonts', () => {
  it('rejects naming the URL it tried, so a wrong asset base cannot pass startup', async () => {
    setEditorAssetPath('/not-where-the-fonts-are/');

    await expect(installEditorFonts()).rejects.toThrow(
      /could not load VE Inter from .*\/not-where-the-fonts-are\/assets\/fonts\/inter-700-latin\.woff2/,
    );
  });
});
