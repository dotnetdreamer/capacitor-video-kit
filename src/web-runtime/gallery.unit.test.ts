import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadBlob } from './gallery';

/** Every anchor the module clicked, which is what a download IS in a page. */
function watchDownloads(): HTMLAnchorElement[] {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  return clicked;
}

describe('downloadBlob', () => {
  beforeEach(() => {
    /* jsdom has no object URLs of its own, and this module both makes one and revokes it. */
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:page/saved'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('hands the blob over under the name it was given', () => {
    const clicked = watchDownloads();

    downloadBlob(new Blob(['video'], { type: 'video/mp4' }), 'lightsnip-20260922-134730.mp4');

    expect(clicked).toHaveLength(1);
    expect(clicked[0].href).toContain('blob:page/saved');
    expect(clicked[0].download).toBe('lightsnip-20260922-134730.mp4');
  });

  it('leaves no anchor behind in the page', () => {
    watchDownloads();

    downloadBlob(new Blob(['video']), 'saved.mp4');

    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  /* A click that threw used to leave its anchor in the document, so a page that failed to save
     twice ended up holding two invisible anchors. */
  it('takes the anchor with it when the click fails', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('the browser refused the download');
    });

    expect(() => downloadBlob(new Blob(['video']), 'saved.mp4')).toThrow();
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  /*
   * The download reads the blob through the URL AFTER the click returns, so revoking on the same
   * tick races the read and the loser is a zero-byte file.
   */
  it('keeps the object URL alive past the click, then revokes it', () => {
    vi.useFakeTimers();
    watchDownloads();

    downloadBlob(new Blob(['video']), 'saved.mp4');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:page/saved');
  });
});
