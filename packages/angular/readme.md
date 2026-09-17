# choisy-video-kit-angular

Angular bindings for the Choisy video editor, as standalone components.

```
npm install choisy-video-kit-angular
```

```ts
import { Component } from '@angular/core';
import { VeSpinner } from 'choisy-video-kit-angular';

@Component({
  selector: 'app-busy',
  imports: [VeSpinner],
  template: `<ve-spinner label="Building your video"></ve-spinner>`,
})
export class BusyComponent {}
```

Peer dependencies are Angular 19, 20, 21 or 22 and RxJS 7.8.

The range says 19 to 22 because that is what has been built and run, not because 23 is expected to
break. ng-packagr emits this package in partial compilation mode, which an application's Angular
linker finishes at its own version, and the linker reads partial declarations from its own version
and earlier. The generated proxies name only `ChangeDetectionStrategy`, `ChangeDetectorRef`,
`Component`, `ElementRef` and `NgZone`, none of which has moved. What was proved: a fresh
`ng new` on 21.2.23 and on 22.1.7, `npm install` of this package with no `--legacy-peer-deps`,
`ng build`, and the element rendering in Chromium with its `label` input proxied through. Widen the
range again when there is a version to widen it to and a build that has run against it.

Before this, the range read `^19.0.0 || ^20.0.0`, which is a version behind the Angular that shipped
in May 2026, so `npm install` on 21 or 22 stopped at, in the name the package had then:

```
npm error code ERESOLVE
npm error Could not resolve dependency:
npm error peer @angular/common@"^19.0.0 || ^20.0.0" from choisy-video-kit-angular@0.1.0
```

The editor's stickers and fonts are not imported by any module, so nothing bundles them. Serve a copy
of `node_modules/choisy-video-kit/dist/components/assets` and call
`setEditorAssetPath('/video-editor/')` from `choisy-video-kit/ui` once at startup, or the first
sticker throws. The repository readme has the copy step.

## Building and publishing

ng-packagr compiles this package rather than plain `tsc`, because an Angular library has to be
emitted in partial compilation mode for the consuming application's linker to finish the job. It
writes `dist/`, generates the published `package.json` there, and that directory is what gets
published.

`ng-package.json` lists `choisy-video-kit` and `@stencil/core` under
`allowedNonPeerDependencies`. ng-packagr otherwise refuses to write the manifest, because it assumes
a runtime dependency of an Angular library should be a peer dependency the application installs.
That is the wrong shape here: the core
package and this one are generated together and only ever match version for version, so a host that
had to pick its own version of the core could pick a wrong one.

Everything under `src/generated/` is written by `stencil.config.ts` on every build of the core
package and is not in git. The only hand written file here is `src/index.ts`, which names what a host
is meant to reach for. Its re-export has no `.js` on it, unlike the React and Vue ones: ng-packagr's
declaration flattener looks for `./generated/proxies.d.ts` and fails outright if the extension is
there, and nothing relative survives into the published output anyway, because the package is
flattened into one `fesm2022` bundle and one declaration file.
