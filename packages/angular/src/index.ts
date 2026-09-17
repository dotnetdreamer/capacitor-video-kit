/**
 * The Angular face of the editor.
 *
 * Everything under `./generated` is written by the repository's `stencil.config.ts` from the components
 * themselves, so it is never edited by hand. This file is the part a person chooses: it names what
 * a host is meant to reach for.
 *
 * The specifier below has no `.js`, where the React and Vue ones do, and it has to stay that way.
 * ng-packagr flattens this package into one `fesm2022` bundle and one declaration file, so no
 * relative specifier survives into the published output and Node never resolves this one. What
 * does read it is ng-packagr's own declaration flattener, which looks for `./generated/proxies.d.ts`
 * and fails with "Could not resolve ./generated/proxies.js" if the extension is there. The Angular
 * output target writes its own proxies the same way.
 *
 * `VeEditor` is the editor. Every other tag in this package is something it renders, and the only
 * other one named here is the spinner, which stands on its own beside the editor rather than
 * inside it.
 */
export { VeEditor, VeSpinner } from './generated/proxies';
