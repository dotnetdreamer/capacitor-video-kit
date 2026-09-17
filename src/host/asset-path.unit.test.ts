import { beforeEach, describe, expect, it } from 'vitest';

import { stickerUrl } from '../data/stickers';
import { editorAssetUrl, setEditorAssetPath } from './asset-path';

/*
 * The key the base is kept under, spelled out again rather than imported, because holding it on a
 * slot every copy of this package can reach is the whole design and a test that imported the
 * constant would pass just as happily if it became a module scoped variable.
 */
const ASSET_BASE = Symbol.for('choisy.video-kit.assetBase');

/*
 * Whether a resolved asset comes back as a path or as a whole URL is Stencil's rule, not ours: it
 * trims the origin when it matches the page's. The mock DOM has no location at all, so the tests
 * below compare where a URL points rather than how it is spelled.
 */
function resolved(url: string): string {
  return new URL(url, document.baseURI).href;
}

describe('the editor asset base', () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<symbol, string | undefined>)[ASSET_BASE];
  });

  it('is kept on globalThis, which is how one call reaches both builds', () => {
    setEditorAssetPath('https://cdn.example.test/video-editor/');

    expect((globalThis as unknown as Record<symbol, string | undefined>)[ASSET_BASE]).toBe(
      'https://cdn.example.test/video-editor/',
    );
  });

  it('keeps a base on another origin whole, so a CDN is reached as written', () => {
    setEditorAssetPath('https://cdn.example.test/video-editor/');

    expect(stickerUrl('crown')).toBe('https://cdn.example.test/video-editor/assets/stickers/crown.svg');
  });

  it('accepts the root relative path a host actually writes', () => {
    setEditorAssetPath('/video-editor/');

    expect(resolved(stickerUrl('fire'))).toBe('http://localhost:3000/video-editor/assets/stickers/fire.svg');
    expect(resolved(editorAssetUrl('assets/fonts/inter-700-latin.woff2'))).toBe(
      'http://localhost:3000/video-editor/assets/fonts/inter-700-latin.woff2',
    );
  });

  it('resolves a path relative to the page the same way an href would', () => {
    setEditorAssetPath('editor-assets/');

    expect(resolved(stickerUrl('heart'))).toBe('http://localhost:3000/editor-assets/assets/stickers/heart.svg');
  });

  /*
   * Without the added slash this resolves against `/`, so every sticker is fetched from
   * `/assets/stickers/` and 404s, and nothing says why.
   */
  it('reads a base with no trailing slash as the directory it must have meant', () => {
    setEditorAssetPath('/video-editor');

    expect(resolved(stickerUrl('fire'))).toBe('http://localhost:3000/video-editor/assets/stickers/fire.svg');
  });

  it('refuses a base that is itself the assets directory, naming what it would have fetched', () => {
    expect(() => setEditorAssetPath('/video-editor/assets/')).toThrowError(
      /ends in "assets".*assets\/assets\/stickers\//s,
    );
  });

  it('refuses an empty base rather than resolving every asset against the page', () => {
    expect(() => setEditorAssetPath('')).toThrowError(/setEditorAssetPath\(\) was called with ""/);
  });
});
