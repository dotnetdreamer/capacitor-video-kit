import type { EditorMedia } from '../state/editor-media';
import type { EditorStore } from '../state/editor-store';

/**
 * The one object every component in the editor is handed, and the whole of how a component reaches
 * the editor it is part of: the state it reads and changes, and the host-backed calls that bring
 * new clips, durations and filmstrips into that state.
 *
 * This replaces Angular's component-scoped providers. `app-video-editor` listed the store and the
 * media service in its own `providers`, so every child down the tree injected the same pair, and a
 * second editor on the same page got a second pair for free. Custom elements have no injector, so
 * the shell passes the pair down by hand and each component takes it as its first prop:
 *
 * ```tsx
 * @Prop() ctx!: EditorContext;
 * ```
 *
 * A DOM property, never an attribute and never reflected. An object cannot survive being written
 * into markup and read back, and both sides have to hold the SAME signals or a write on one repaints
 * nothing on the other. Stencil's vdom assigns a non-null object to a dashed tag as a property
 * rather than an attribute, and its `connectedCallback` re-assigns own properties through the
 * generated setter when the element upgrades later, so a parent that renders `<ve-x ctx={this.ctx}/>`
 * is safe whatever order the elements upgrade in and a component may read `ctx` from
 * `componentWillLoad` onwards.
 *
 * Deliberately not a module level singleton, for the reason [EditorStore]'s own docblock gives: one
 * store per editor, so two editors on one page cannot end up sharing a manifest, a selection and a
 * playhead.
 *
 * The host is not a third member: it is reached through `store.host`, so it is one object on the
 * way down and cannot be handed to a component paired with a store it does not belong to.
 * `OverlayBitmaps` is not here either, because nothing renders it - the shell constructs it for its
 * side effect on the store and disposes it on the way out.
 */
export interface EditorContext {
  readonly store: EditorStore;
  readonly media: EditorMedia;
}
