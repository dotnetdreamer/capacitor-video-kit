import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveEditorHost } from './defaults';
import { webViewUrl } from './web-view-url';

/*
 * Capacitor's global, stood in for as a native side puts it in the page: a local server that serves
 * a device path under its own URL. `Capacitor` from `@capacitor/core` is this same object, which is
 * why the function reads it rather than importing anything.
 */
function onDevice(): ReturnType<typeof vi.fn> {
  const convertFileSrc = vi.fn((path: string) => `capacitor://localhost/_capacitor_file_${path.replace(/^file:\/\//, '')}`);
  vi.stubGlobal('Capacitor', { convertFileSrc });
  return convertFileSrc;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('webViewUrl', () => {
  it('serves a device path through Capacitor\'s local server', () => {
    const convert = onDevice();

    expect(webViewUrl('file:///var/mobile/a.mp4')).toBe('capacitor://localhost/_capacitor_file_/var/mobile/a.mp4');
    expect(webViewUrl('/var/mobile/b.mp4')).toBe('capacitor://localhost/_capacitor_file_/var/mobile/b.mp4');
    expect(convert).toHaveBeenCalledTimes(2);
  });

  it('leaves a URL the WebView already loads as it came, without asking Capacitor', () => {
    const convert = onDevice();

    for (const loadable of ['https://cdn.example/a.mp4', 'HTTP://localhost/a.mp4', 'blob:capacitor://localhost/42', 'data:image/png;base64,AAAA']) {
      expect(webViewUrl(loadable)).toBe(loadable);
    }
    expect(convert).not.toHaveBeenCalled();
  });

  it('answers every URI as it came in a page with no Capacitor, or none that can convert', () => {
    expect(webViewUrl('file:///a.mp4')).toBe('file:///a.mp4');

    vi.stubGlobal('Capacitor', { getPlatform: () => 'web' });
    expect(webViewUrl('content://media/external/video/1')).toBe('content://media/external/video/1');
  });

  /* A page may load Capacitor after the editor has resolved its host, and a test may spy on it later still. */
  it('asks whichever Capacitor the page has at the time of the call', () => {
    const fileUrl = resolveEditorHost().platform.fileUrl;
    expect(fileUrl('file:///a.mp4')).toBe('file:///a.mp4');

    onDevice();
    expect(fileUrl('file:///a.mp4')).toBe('capacitor://localhost/_capacitor_file_/a.mp4');
  });
});

describe('the editor\'s default fileUrl', () => {
  it('is this, so a Capacitor host has nothing to write for it', () => {
    onDevice();
    const { platform } = resolveEditorHost();

    expect(platform.fileUrl('file:///var/mobile/c.mp4')).toBe('capacitor://localhost/_capacitor_file_/var/mobile/c.mp4');
    expect(platform.fileUrl('blob:capacitor://localhost/42')).toBe('blob:capacitor://localhost/42');
  });

  it('gives way to a host\'s own', () => {
    onDevice();
    expect(resolveEditorHost({ platform: { fileUrl: (uri) => `mine://${uri}` } }).platform.fileUrl('file:///a.mp4')).toBe('mine://file:///a.mp4');
  });
});
