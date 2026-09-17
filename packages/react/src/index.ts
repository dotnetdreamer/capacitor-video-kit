/**
 * The React face of the editor.
 *
 * Everything under `./generated` is written by the repository's `stencil.config.ts` from the components
 * themselves, so it is never edited by hand. This file is the part a person chooses: it names what
 * a host is meant to reach for.
 *
 * A component that declares an `@Event()` belongs here rather than left out for being small. Its
 * wrapper is the only thing that carries a `Ve*CustomEvent` type into the published declarations,
 * and that import is where this package broke for a consumer for as long as nothing here exported
 * one. `rollup.config.mjs` says what the break was and what catches it now.
 *
 * `VeEditor` is the one that matters: it is the editor, and every other tag in this package is
 * something it renders. The rest are here because they stand on their own, a spinner or an alert a
 * host may want beside the editor rather than inside it.
 */
export { VeEditor, VeAlert, VeIcon, VeProgress, VeSheet, VeSlider, VeSpinner, VeToast } from './generated/components.js';
