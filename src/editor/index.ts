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
export * from './compose';
export * from './overlay-raster';
export * from './effects';
export * from './transitions';
export * from './zoom';
export * from './camera';
export * from './motion';

/**
 * The scenes `labelMedia`'s labels are read into, and the reader itself. Not the editor's, but pure
 * data and pure functions like everything here, and this is the entry point with no Capacitor in
 * its tree: a host checks the scenes its catalogue names against [MEDIA_SCENES] in Node, where the
 * package root, which registers the plugins, has no bridge to load. The root exports it too, beside
 * [describeMedia], which is the call that asks the phone.
 */
export * from '../video-composer/scenes';

/**
 * `toComposeSpec` returns a `ComposeSpec` and `resolveFilterOps` returns `FilterOp[]`, and both
 * types are declared next to the plugin that consumes them rather than here - as are the labels
 * `scenesFromLabels` reads. A consumer reaching
 * this entry point on its own cannot name a type it has no way to import, and TypeScript refuses to
 * emit declarations that would need one, so the two names travel with the contract that returns
 * them.
 */
export type {
  ComposeCamera,
  ComposeOverlayMotion,
  ComposeSpec,
  FilterOp,
  LabelEngine,
  LabeledFrame,
  MediaLabel,
} from '../video-composer/definitions';
