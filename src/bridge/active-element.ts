/**
 * The element that actually has focus, however deeply it is nested in shadow roots.
 *
 * `document.activeElement` stops at the first shadow boundary and names the HOST instead: with the
 * editor's components in shadow roots, focus in the text sheet's textarea and focus in the sticker
 * sheet's search field both read as `<ve-editor>`, the outermost host. That is the specification
 * rather than a quirk, since a tree outside a shadow root is not allowed to name a node inside it,
 * and it is why every place the editor asks the question comes through here.
 *
 * Not one of those places would throw without it, which is the difficulty. `active === field`, how
 * the text sheet decides whether the caret is in the field it is holding, is simply never true, so
 * the field keeps the caret and the keyboard stays up over a sheet that has already gone. And
 * `active.blur()` still works, by luck rather than by right: a host whose tree holds the focus is
 * itself in the focus chain, so blurring it does drop the keyboard - along with the focus on
 * everything else anywhere in the editor.
 *
 * Each shadow root answers the same question for its own tree, so the walk is to keep asking until
 * the answer stops being a host. A host that is focused itself - one carrying a `tabindex`, or one
 * whose root delegates focus - reports nothing focused inside it and ends the walk on the host,
 * which is the true answer and not a special case.
 *
 * A closed shadow root cannot be asked at all and the walk stops at its host. Nothing in the
 * package opens one closed, and a host application's own closed roots are outside the editor, where
 * the answer would be the host element anyway.
 *
 * `root` is where to start, for a caller that only wants to know about its own shadow root.
 */
export function activeElementDeep(root: Document | ShadowRoot = document): Element | null {
  let active = root.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
