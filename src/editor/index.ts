/**
 * The editor's framework-free core: the manifest an editor UI builds, the filter maths its preview
 * shares with the native render, and the one translation from an edit to a `ComposeSpec`.
 *
 * Deliberately no UI here - an editor screen belongs to the host app and its framework. Everything
 * an editor needs in order to agree with the native render lives here instead.
 */
export * from './edit-manifest';
export * from './edit-ops';
export * from './layout-presets';
export * from './raster-context';
export * from './compose-spec';
export * from './overlay-raster';
export * from './effects';
