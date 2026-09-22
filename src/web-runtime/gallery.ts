/**
 * "Save this to the gallery", in a browser, where there is no gallery.
 *
 * A page cannot write to the machine it runs on, so the nearest true thing to a gallery save is
 * the browser's own download - the one gesture that ends with the file somewhere the person
 * chooses. Everything the native sides take an option for is meaningless here: there are no media
 * folders to choose between and no album to file anything under, so `directory` and `album` are
 * ignored rather than faked, and only the name survives.
 *
 * A module of its own so it can be asserted on without a plugin around it: what this guards is an
 * anchor that never got clicked and an anchor left behind in the document, and neither is visible
 * from outside.
 */

/**
 * Hands `blob` to the person as a file called `fileName`.
 *
 * Throws when there is no document to click an anchor in - a worker, or a server render - which is
 * the only way this can fail. Every other outcome, the person cancelling the browser's own save
 * dialog included, is indistinguishable from here and is reported as success, because it is: the
 * page did hand the file over.
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  if (typeof document === 'undefined') {
    throw new Error('There is no page here to download a file into');
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;

  /* In the document, because Firefox ignores a click on an anchor that is not in one. */
  document.body.append(link);
  try {
    link.click();
  } finally {
    /* The anchor is a means to an end rather than part of the page, so it does not stay in one -
       and it goes even if the click threw, or a failed save would leave one behind per attempt. */
    link.remove();
  }

  /*
   * Revoked, but not on this tick. The download reads the blob through this URL AFTER the click
   * returns, so revoking straight away races it and the loser is a zero-byte file. A macrotask is
   * long enough for the read to have started and short enough that the blob is not held for the
   * life of the page.
   */
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
