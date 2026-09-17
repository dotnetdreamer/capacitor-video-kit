/**
 * Fills the create-post body with ids that did not exist when the caller wrote it - the port of
 * `TemplateFill.kt` and `TemplateFill.swift`.
 *
 * The caller hands over its complete JSON with `"$STITCHED"`, `"$ORIGINALS"` and `"$ALL"` where the
 * upload ids go; those are replaced textually, quotes and all, so a string placeholder becomes a
 * bare number or a bare array. Doing it this way means this plugin never has to understand the
 * post's schema - it can gain fields, change names or move things around without this code knowing,
 * which matters a lot for something that runs from a persisted record days later.
 *
 * Plain string replacement, never a regular expression - and never `String.replace` with a string
 * pattern either, which in JavaScript replaces only the FIRST occurrence: a body naming `"$ALL"`
 * twice would come back half filled. `replaceAll` is the whole of the difference, and it is why
 * this is a file rather than three lines inlined somewhere.
 *
 * The other half of the rule: the body carries customer-written text - a post title, a comment -
 * which may contain anything at all, and a `$` in it must stay a `$`. A regular-expression
 * replacement would also read `$&` and `$1` in the REPLACEMENT as references; the literal-string
 * path removes both questions at once.
 */

export const STITCHED = '"$STITCHED"';
export const ORIGINALS = '"$ORIGINALS"';
export const ALL = '"$ALL"';

export function fill(template: string, stitched: number, originals: readonly number[]): string {
  const all = [stitched, ...originals];
  return template.replaceAll(STITCHED, String(stitched)).replaceAll(ORIGINALS, toJsonArray(originals)).replaceAll(ALL, toJsonArray(all));
}

/** The separator is spelled out: a default of ", " would put stray spaces inside the JSON array. */
function toJsonArray(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}
