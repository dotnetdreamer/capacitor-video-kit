/**
 * Whether the package says anything on the console.
 *
 * In choisy this is `AppConstant.DEBUG`, which reaches the app's environment file through an
 * Angular package: a third-party import sitting behind a `console.warn` guard. Here it is one
 * module level boolean, set from `host.platform.debug` when the editor is handed its host, so
 * nothing the package logs can be reached without going through this file.
 *
 * It is module level rather than per editor because it guards diagnostics, not behaviour: two
 * editors on one page with different answers would be a curiosity, not a requirement.
 */
let debugEnabled = false;

export function setEditorDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function editorDebug(): boolean {
  return debugEnabled;
}

/** A diagnostic nobody has to act on: a probe that fell back, a layer that would not draw. */
export function debugWarn(...args: unknown[]): void {
  if (debugEnabled) console.warn(...args);
}

/** Something that went wrong where the editor carried on anyway. */
export function debugError(...args: unknown[]): void {
  if (debugEnabled) console.error(...args);
}
