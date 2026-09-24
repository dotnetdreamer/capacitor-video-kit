/**
 * `capacitor-video-kit` - native video composition and native background publishing.
 *
 * One package, two Capacitor plugins. They ship together because they are always used together and
 * two installs for one feature is a worse wart than an unused dependency; they stay two plugin
 * classes because they share nothing at runtime but a file path - the composer writes the video,
 * the publisher uploads whatever path it is handed.
 *
 * This entry point needs `@capacitor/core` present. The two `registerPlugin` calls below import it
 * statically, so a tree without it fails to resolve this module at all: Node reports
 * `ERR_MODULE_NOT_FOUND` and a bundler reports an unresolved import, both naming `@capacitor/core`
 * and neither naming this package. That message cannot be improved from in here, because a static
 * import that does not resolve fails while the module graph is being linked, before any line of
 * this file runs. Making it a dynamic import would buy a message and cost the API: `VideoComposer`
 * would become a promise, and every call site in the app would have to await it.
 *
 * `@capacitor/core` stays an optional peer dependency because of the other entry point. A host that
 * only edits reaches `capacitor-video-kit/editor`, which is pure TypeScript that touches no bridge, and
 * a mandatory peer would install a native bridge into the `node_modules` of every such host.
 * The editor's own web components are exactly that host. They are in this same package, under
 * `src/components` and the rest of `src`, and they reach the contract through `../editor` rather
 * than through this file, so nothing they bundle reaches `@capacitor/core`.
 */
export { VideoComposer } from './video-composer';
export { BackgroundPublisher } from './background-publisher';

// Here rather than beside the definitions because they call the plugin, which the editor's entry
// point must never reach. They are the glue a native host with drafts needs between a pick, the
// editor and a render, and README's **Native hosts** shows them in place.
export { currentMediaUri } from './video-composer/current-media';
export { gallerySource, retainPickedFile } from './video-composer/native-sources';
export type { PickedFileNames, RetainedPick } from './video-composer/native-sources';
export { RenderInputError, withNativeRenderInputs } from './video-composer/render-inputs';

// The editor's render host over the composer, which is why it is here and not beside the editor's
// other host defaults in `capacitor-video-kit/ui`: that entry must never reach `@capacitor/core`.
// `RenderFailedError` comes with it, for a `toSource` hook that fails in a way of its own; this
// copy of the class and the editor's are one to `instanceof`, through the brand each instance carries.
// `readRenderFile` and `containerOf` are for such a hook too: the render read into a `File`, and
// the extension that says whether it is the MP4 every native engine writes or a browser's WebM.
export { composerRenderHost, containerOf, readRenderFile } from './video-composer/render-host';
export type {
  ComposedRender,
  ComposerRenderHost,
  ComposerRenderHostOptions,
  DiscardPreviousRenders,
} from './video-composer/render-host';
export { RenderFailedError } from './host/host.types';

// The editor's media host over the composer - the browser defaults with the probe, the filmstrip,
// the microphone and, when asked, the sound library answered natively - here beside the render host
// for the same reason: it calls the plugin, and `capacitor-video-kit/ui` must never reach
// `@capacitor/core`. `probeMediaDuration` is its probe for a host's own pickers, on a file that is
// not a source yet. The helpers those pickers want that call no plugin - `readFileBlob`,
// `readVoiceTake`, `filePickerCancelled` - are in `capacitor-video-kit/ui`.
export { composerMediaHost, probeMediaDuration } from './video-composer/media-host';
export type { ComposerMediaHostOptions, ComposerMediaPickers } from './video-composer/media-host';

// The URL the WebView loads a device file by, which the editor's `/ui` defaults use as its
// `platform.fileUrl` and a Capacitor host wants for everything else it shows: a done screen's
// render, a poster. It reads Capacitor's global rather than importing it, so it lives beside those
// defaults, and is exported here because it is Capacitor glue.
export { webViewUrl } from './host/web-view-url';

export * from './video-composer/definitions';
export * from './video-composer/plugin';
export * from './background-publisher/definitions';

// The editor's framework-free core - the web half of editing, the way web.ts is the web half of
// the plugins.
export * from './editor';
