/**
 * Why a batch id is refused, in the words `JobFolders.batchIdRefusal` answers on iOS and Android, or
 * null for an id that names a folder of its own.
 *
 * Both native halves make a folder name of a batch id by turning every character outside
 * `[A-Za-z0-9._-]` into `_` (iOS `JobFolders.sanitize`, Android `JobFolders.safeSegment`), which
 * keeps dots. So the empty id, `.` and `..` are the only ids that come out as a name a path reads as
 * the folder every job's folder is in, or the one above that, and `compose`, `prepareJob` and
 * `cleanup` refuse exactly those three there as `invalid_spec`. Every other id is accepted, `../x`
 * included, which is the folder `.._x` like any other.
 *
 * Read in one place because three parts of this half ask it: the web engine's `validateSpec`,
 * `prepareJob` and `cleanup`, which refuse the same ids although a browser's files are IndexedDB
 * keys nothing can climb out of - so the same call is refused on a phone and in a browser, rather
 * than refused on one and kept on the other - and the composer render host's check of the ids a
 * host's own function answers. `startVoiceRecording` files a take for a refused id in the voice
 * cache on every platform, as it does one with no batch at all.
 */
export function batchIdRefusal(batchId: unknown): string | null {
  if (typeof batchId !== 'string' || batchId.length === 0) return 'batchId is required';
  return batchId === '.' || batchId === '..' ? "batchId cannot be '.' or '..'" : null;
}
