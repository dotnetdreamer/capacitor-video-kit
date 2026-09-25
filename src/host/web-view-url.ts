/** The URLs a WebView loads as they stand, in the spelling every host wrote in front of `convertFileSrc`. */
const LOADABLE = /^(https?:|blob:|data:)/i;

/** The one member of Capacitor's global this reads: see [webViewUrl]. */
interface FileServer {
  convertFileSrc?: (filePath: string) => string;
}

/**
 * A URL the WebView can load for whatever a picker, the recorder, the thumbnailer or a render handed
 * back: a `file://` URI, a `content://` URI or a bare device path through Capacitor's local server,
 * and anything already loadable - a server URL, an object URL, inline data - as it came.
 *
 * It is the editor's default `platform.fileUrl` (`resolveEditorHost`), and the package root exports
 * it for the rest of a Capacitor host that shows a file: the finished render on a done screen, a
 * poster, a clip the host plays itself. Every Capacitor host wrote this line for itself, often twice,
 * and one that left it out of the editor got the identity function, which pointed the stage's
 * `<video>` at a raw `content://` that an Android WebView will not open, and said nothing.
 *
 * WHY THE GLOBAL AND NOT AN IMPORT. The editor's half of the package never imports `@capacitor/core`
 * (`src/tsconfig.json`), and this is that half's default. It needs no import: `Capacitor` from
 * `@capacitor/core` IS `globalThis.Capacitor`, which that package makes as it loads
 * (`initCapacitorGlobal`), on top of the one a native side puts in the page before any script runs.
 * So the function asked is the one a host would have called, a test's spy on
 * `Capacitor.convertFileSrc` included, and it is looked up at each call, so a page that loads
 * Capacitor after the editor still gets it. With no Capacitor there is no local server to go
 * through, and the URI comes back as it came, which is right for a plain web page: every file it
 * has is an object URL already.
 *
 * The loadable kinds are passed over before Capacitor is asked. Capacitor 8 answers them unchanged
 * as well - on a device `convertFileSrc` rewrites only a bare path, `file://` and `content://`, and
 * in a browser it rewrites nothing - so the test changes no answer there. It keeps the answer for
 * them the same whatever `convertFileSrc` a page has, a `CapacitorCustomPlatform`'s or a test's
 * stand-in, which is why every host wrote it.
 */
export function webViewUrl(uri: string): string {
  if (LOADABLE.test(uri)) return uri;
  const capacitor = (globalThis as { Capacitor?: FileServer }).Capacitor;
  return typeof capacitor?.convertFileSrc === 'function' ? capacitor.convertFileSrc(uri) : uri;
}
