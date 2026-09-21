# @capacitor-video-kit/core/angular

Angular bindings for the Capacitor Video Kit editor, as standalone components.

```sh
npm install ./@capacitor-video-kit/core-1.3.0.tgz ./@capacitor-video-kit/core/angular-1.3.0.tgz
```

```ts
import { Component } from '@angular/core';
import { VeSpinner } from '@capacitor-video-kit/core/angular';

@Component({
  selector: 'app-busy',
  imports: [VeSpinner],
  template: `<ve-spinner label="Building your video"></ve-spinner>`,
})
export class BusyComponent {}
```

Both packages go in, in one command, and neither is on a registry yet, so both are paths: a tarball
from `npm pack`, or the checkout itself.

The peers are Angular 19, 20, 21 or 22, RxJS 7.8, `@preact/signals-core`, which the editor's store is
built on, and `@capacitor-video-kit/core` at the exact version of this package, because the two are generated
together and only ever match version for version. That last one is why the core package has to be on
the install line. npm installs a missing peer by itself, which is how Angular, RxJS and the signals
arrive without being asked for, but it looks for every one of them on the registry, and this one is
not there. The wrapper on its own ends in

```
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@capacitor-video-kit/core - Not found
```

`@stencil/core` and `tslib` are the two packages this one brings with it.

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
npm error peer @angular/common@"^19.0.0 || ^20.0.0" from @capacitor-video-kit/core/angular@0.1.0
```

The editor's stickers and fonts are not imported by any module, so nothing bundles them. Serve a copy
of `node_modules/@capacitor-video-kit/core/dist/components/assets` and call
`setEditorAssetPath('/video-editor/')` from `@capacitor-video-kit/core/ui` once at startup, or the first
sticker throws. The repository readme has the copy step.

## Building and publishing

ng-packagr compiles this package rather than plain `tsc`, because an Angular library has to be
emitted in partial compilation mode for the consuming application's linker to finish the job. It
writes `dist/`, generates the published `package.json` there, and that directory is what gets
published.

`ng-package.json` lists `@capacitor-video-kit/core` and `@stencil/core` under `allowedNonPeerDependencies`.
ng-packagr otherwise refuses to write the manifest, because it assumes a runtime dependency of an
Angular library should be a peer dependency the application installs. `@stencil/core` is what still
needs that exemption. `@capacitor-video-kit/core` is on the list from when it was a dependency here rather
than a peer, and the entry does nothing now.

Everything under `src/generated/` is written by `stencil.config.ts` on every build of the core
package and is not in git. The only hand written file here is `src/index.ts`, which names what a host
is meant to reach for. Its re-export has no `.js` on it, unlike the React and Vue ones: ng-packagr's
declaration flattener looks for `./generated/proxies.d.ts` and fails outright if the extension is
there, and nothing relative survives into the published output anyway, because the package is
flattened into one `fesm2022` bundle and one declaration file.

## Why this package is not an npm workspace

`packages/react` and `packages/vue` are workspaces; this one deliberately is not, and its scripts
are driven with `npm --prefix packages/angular ...` from the root instead.

A workspace's devDependencies HOIST to the repo root. This package builds with Angular, so being a
workspace put `@angular/core` (and `rxjs`) into `<repo>/node_modules` - which is fine until an app
installs the kit as a `file:` link. The bindings this package builds land at `<repo>/angular/`, so a
bare `import '@angular/core'` there resolves by walking up to `<repo>/node_modules` and finds the
BUILD's Angular rather than the app's. Two copies of Angular is two injector registries, and every
`inject()` in the bindings then fails at runtime with NG0203.

Keeping the install here means `<repo>/node_modules` carries no Angular at all, so that same import
walks past the kit and lands on the host app's copy - the only one that may exist.

    npm --prefix packages/angular install     # after cloning, or when these deps change
    npm --prefix packages/angular run build   # what `npm run build:wrappers` calls

Consumers that resolve through the link (Angular CLI with `preserveSymlinks`) get this for free.
One that resolves at the REAL path - Vitest does - has to be told separately, with a `dedupe` on
`@angular/*` in its own config.
