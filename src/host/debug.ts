/**
 * Whether the package says anything on the console.
 *
 * In a typical host this is `AppConstant.DEBUG`, which reaches the app's environment file through an
 * Angular package: a third-party import sitting behind a `console.warn` guard. Here it is one
 * switch, set from `host.platform.debug` when the editor is handed its host, so nothing the package
 * logs can be reached without going through this file.
 *
 * The switch lives on `globalThis` under a registered symbol, and not in a variable of this module,
 * because this module is built twice: into the editor's Stencil bundle, where `resolveEditorHost`
 * sets it, and into the published plugin, where `retainPickedFile` logs through it. A module
 * variable is a switch per copy, and the plugin's would be one nothing ever sets; `Symbol.for`
 * hands every copy on the page the same key.
 *
 * It is one for the page rather than one per editor because it guards diagnostics, not behaviour:
 * two editors on one page with different answers would be a curiosity, not a requirement.
 */
const DEBUG = Symbol.for('capacitor-video-kit.debug');

/** The page's globals, as far as the one key this file keeps there. */
const page = globalThis as unknown as Record<symbol, boolean | undefined>;

export function setEditorDebug(enabled: boolean): void {
  page[DEBUG] = enabled;
}

export function editorDebug(): boolean {
  return page[DEBUG] === true;
}

/** A diagnostic nobody has to act on: a probe that fell back, a layer that would not draw. */
export function debugWarn(...args: unknown[]): void {
  if (editorDebug()) console.warn(...args);
}

/** Something that went wrong where the editor carried on anyway. */
export function debugError(...args: unknown[]): void {
  if (editorDebug()) console.error(...args);
}
