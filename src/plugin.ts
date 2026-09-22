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

export * from './video-composer/definitions';
export * from './video-composer/plugin';
export * from './background-publisher/definitions';

// The editor's framework-free core - the web half of editing, the way web.ts is the web half of
// the plugins.
export * from './editor';
