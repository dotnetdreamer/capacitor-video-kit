/**
 * Whether two URLs name the same resource, the way a media element compares them: `element.src`
 * reads back resolved and normalised, so the string a source was put on with can differ from it in
 * spelling alone - a relative path, an escaped character. Unparseable URLs are equal only when they
 * are the same string.
 */
export function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
    return new URL(a, base).href === new URL(b, base).href;
  } catch {
    return false;
  }
}
