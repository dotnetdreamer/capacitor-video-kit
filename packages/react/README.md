# choisy-video-kit-react

React bindings for the Choisy video editor.

```sh
npm install ./choisy-video-kit-1.3.0.tgz ./choisy-video-kit-react-1.3.0.tgz
```

```tsx
import { VeSpinner } from 'choisy-video-kit-react';

export function Busy() {
  return <VeSpinner label="Building your video" />;
}
```

Both packages go in, in one command, and neither is on a registry yet, so both are paths: a tarball
from `npm pack`, or the checkout itself.

`choisy-video-kit` is a peer dependency pinned to the exact version of this package, because the two
are generated together and only ever match version for version. It is also the one peer that has to
be named. npm installs a missing peer by itself, which is how React 18 or 19, the matching
`react-dom` and `@preact/signals-core`, which the editor's store is built on, arrive without being
asked for, but it looks for every one of them on the registry, and this one is not there. The
wrapper on its own ends in

```
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/choisy-video-kit - Not found
```

`@stencil/core`, which the component declarations name, is the only package this one brings with it.

The editor's stickers and fonts are not imported by any module, so nothing bundles them. Serve a copy
of `node_modules/choisy-video-kit/dist/components/assets` and name it once at startup:

```ts
import { setEditorAssetPath } from 'choisy-video-kit/ui';

setEditorAssetPath('/video-editor/');
```

Without it the first sticker throws. The repository readme has the copy step and the reason.

## Why this package is bundled

The generated wrappers import `createComponent` from `@stencil/react-output-target/runtime`. That
subpath is 1.2 kB, but the package holding it also holds the generator that wrote the wrappers, and
the generator depends on `ts-morph`: leaving the bare specifier in the emitted JavaScript makes the
whole thing a runtime dependency and puts 18.4 MB across 26 packages into every application that
installs this one, 12.2 MB of it a TypeScript compiler that never runs.

The output target has no option for that import path, so `rollup.config.mjs` resolves it away
instead. `tsc` writes `.build`, then Rollup bundles it into a single `dist/index.js` with the
runtime and the `@lit/react` `createComponent` it calls inlined, and `rollup-plugin-dts` inlines the
two types the wrappers name from them. React, `react-dom` and `choisy-video-kit` stay external,
because a second copy of any of those is a bug rather than a size problem. The bundle declares
`'use client'` once for the whole package, which is what the per file directives Rollup merges away
were saying.

`choisy-video-kit-vue` is not bundled, because `@stencil/vue-output-target` has no dependencies
at all and weighs 0.10 MB.

Everything under `src/generated/` is written by `stencil.config.ts` on every build of the core
package and is not in git. The only hand written file here is `src/index.ts`, which names what a host
is meant to reach for.
