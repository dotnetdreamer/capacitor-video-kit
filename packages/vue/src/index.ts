/**
 * The Vue face of the editor.
 *
 * Everything under `./generated` is written by the repository's `stencil.config.ts` from the components
 * themselves, so it is never edited by hand. This file is the part a person chooses: it names what
 * a host is meant to reach for.
 *
 * `VeEditor` is the editor. Every other tag in this package is something it renders, and the only
 * other one named here is the spinner, which stands on its own beside the editor rather than
 * inside it.
 */
export { VeEditor, VeSpinner } from './generated/components.js';
