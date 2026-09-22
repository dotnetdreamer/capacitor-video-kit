/**
 * Fills the finalize body with ids that did not exist when the caller wrote it - the port of
 * `TemplateFill.kt` and `TemplateFill.swift`.
 *
 * The caller hands over its complete JSON with `"$ID:<uploadId>"`, `"$IDS:<tag>"` and `"$IDS"`
 * where the ids go; those are replaced textually, quotes and all, so a string placeholder becomes
 * a bare JSON value. Doing it this way means this plugin never has to understand the body's schema
 * - it can gain fields, change names or move things around without this code knowing, which
 * matters a lot for something that runs from a persisted record days later.
 *
 * Plain string work, never a regular expression - and never `String.replace` with a string pattern
 * either, which in JavaScript replaces only the FIRST occurrence: a body naming `"$IDS"` twice
 * would come back half filled. The other half of that rule is the text: the body carries what the
 * customer wrote - a title, a comment - which may contain anything at all, and a `$` in it must
 * stay a `$`. A regular-expression replacement would also read `$&` and `$1` in the REPLACEMENT as
 * references; the literal-string path removes both questions at once.
 *
 * `"$IDS:<tag>"` is the one token scanned for rather than built, because it has to answer `[]` for
 * a tag nothing in this batch carries - the batch where the render failed and there are no clips
 * to name. Building the token from the tags present could only ever leave that one untouched, and
 * a literal `"$IDS:clip"` arriving at somebody's server is a 400 with a baffling message. The scan
 * is why a tag may not contain a quote.
 *
 * Each id keeps the JSON type the server used. An id that arrived as `12` goes back as `12`; one
 * that arrived as `"aGVsbG8"` goes back quoted, properly escaped. That is the whole reason
 * `remoteId` is `string | number` rather than being flattened to text on the way in.
 */

export interface FillUpload {
  uploadId: string;
  tag: string;
  remoteId: string | number;
}

/** The token for one upload's id. Built from the id, never parsed out of the template. */
export function idToken(uploadId: string): string {
  return `"$ID:${uploadId}"`;
}

/** The opening of a by-tag token. The tag runs from here to the next quote. */
const TAG_PREFIX = '"$IDS:';

/** The token for every id in the batch, in order. */
export const ALL_IDS = '"$IDS"';

export function fill(template: string, uploads: readonly FillUpload[]): string {
  let body = template;
  for (const upload of uploads) {
    body = body.replaceAll(idToken(upload.uploadId), jsonValue(upload.remoteId));
  }
  body = fillTags(body, uploads);
  return body.replaceAll(ALL_IDS, jsonArray(uploads));
}

/** Every `"$IDS:<tag>"`, replaced with the ids carrying that tag - an empty array when none do. */
function fillTags(template: string, uploads: readonly FillUpload[]): string {
  const parts: string[] = [];
  let from = 0;

  for (;;) {
    const at = template.indexOf(TAG_PREFIX, from);
    if (at < 0) break;
    const close = template.indexOf('"', at + TAG_PREFIX.length);
    // An unterminated token is not a token. Leaving the rest alone is the safe reading.
    if (close < 0) break;

    const tag = template.slice(at + TAG_PREFIX.length, close);
    parts.push(template.slice(from, at), jsonArray(uploads.filter(upload => upload.tag === tag)));
    from = close + 1;
  }

  parts.push(template.slice(from));
  return parts.join('');
}

/** One id as a JSON value: a number stays bare, a string is quoted and escaped. */
function jsonValue(remoteId: string | number): string {
  return typeof remoteId === 'number' ? String(remoteId) : JSON.stringify(remoteId);
}

/**
 * The separator is spelled out rather than left to a default of ", ": stray spaces inside a JSON
 * array are harmless to a parser but noisy in a request log, and the native ports have no default
 * to rely on anyway.
 */
function jsonArray(uploads: readonly FillUpload[]): string {
  return `[${uploads.map(upload => jsonValue(upload.remoteId)).join(',')}]`;
}
