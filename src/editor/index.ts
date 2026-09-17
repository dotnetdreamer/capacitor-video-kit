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

/**
 * `toComposeSpec` returns a `ComposeSpec` and `resolveFilterOps` returns `FilterOp[]`, and both
 * types are declared next to the plugin that consumes them rather than here. A consumer reaching
 * this entry point on its own cannot name a type it has no way to import, and TypeScript refuses to
 * emit declarations that would need one, so the two names travel with the contract that returns
 * them.
 */
export type { ComposeSpec, FilterOp } from '../video-composer/definitions';
