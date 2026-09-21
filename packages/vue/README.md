# @capacitor-video-kit/core/vue

Vue bindings for the Capacitor Video Kit editor.

```sh
npm install ./@capacitor-video-kit/core-1.3.0.tgz ./@capacitor-video-kit/core/vue-1.3.0.tgz
```

```vue
<script setup lang="ts">
import { VeSpinner } from '@capacitor-video-kit/core/vue';
</script>

<template>
  <VeSpinner label="Building your video" />
</template>
```

Both packages go in, in one command, and neither is on a registry yet, so both are paths: a tarball
from `npm pack`, or the checkout itself.

The peers are Vue 3.4.38 or later, `@preact/signals-core`, which the editor's store is built on, and
`@capacitor-video-kit/core` at the exact version of this package, because the two are generated together and
only ever match version for version. That last one is why the core package has to be on the install
line. npm installs a missing peer by itself, which is how Vue and the signals arrive without being
asked for, but it looks for every one of them on the registry, and this one is not there. The wrapper
on its own ends in

```
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@capacitor-video-kit/core - Not found
```

`@stencil/core` and `@stencil/vue-output-target`, whose `defineContainer` the generated wrappers
call, are the two packages this one brings with it.

## v-model

`v-model` works only on the components listed in `componentModels` in `stencil.config.ts`, and
on the rest it fails silently rather than loudly: the generated type carries a `modelValue` prop
either way, so the binding compiles, renders, and never writes back.

The list is empty today, because `ve-spinner` has nothing to bind. The rule for the components that
are coming is mechanical: a component that declares a prop `x` and emits an event `xChange` is two
way bindable, and gets an entry

```ts
{ elements: 've-slider', event: 'valueChange', targetAttr: 'value' }
```

That is the same pair Angular's `[(x)]` needs, so it is one convention rather than two.
`core/build/vue-component-models.ts` enforces it: a component that fits the shape and is not on the
list fails the core build, naming the component, the prop, the event and the line to add.

## You need skipLibCheck, or vue-router, and the reason is not ours

Set `skipLibCheck: true` in your application's `tsconfig.json`, or install `vue-router`. With
neither, and no matter what your own code says, compiling fails:

```
node_modules/@stencil/vue-output-target/dist/types.d.ts(2,81): error TS2307:
Cannot find module 'vue-router' or its corresponding type declarations.
```

That is an upstream bug and there is nothing this package can do about it. Line 2 of that file is

```ts
import type { RouteLocationAsPathGeneric, RouteLocationAsRelativeGeneric } from 'vue-router';
```

which is unconditional, while the same package declares `vue-router` as an **optional** peer
dependency. The types it pulls in are used for a `routerLink` prop that `StencilVueComponent` gives
every wrapper, Ionic's included, so the type reaches your build through the `components.ts` this
package ships and not through anything written here. `@stencil/vue-output-target` is a real runtime
dependency of this package, because the generated wrappers call its `defineContainer`, so it cannot
be dropped, and a `declare module 'vue-router'` shim from here would break the applications that do
use the router.

Both ways out are proven: with `vue-router` installed, `tsc --noEmit --skipLibCheck false` exits 0,
and with `skipLibCheck: true` it exits 0 without it. Pick whichever suits the application. It is
written down here because the alternative is a consumer reading a TS2307 that names neither their
code nor this package and guessing.

The editor's stickers and fonts are not imported by any module, so nothing bundles them. Serve a copy
of `node_modules/@capacitor-video-kit/core/dist/components/assets` and call
`setEditorAssetPath('/video-editor/')` from `@capacitor-video-kit/core/ui` once at startup, or the first
sticker throws. The repository readme has the copy step.

Everything under `src/generated/` is written by `stencil.config.ts` on every build of the core
package and is not in git. The only hand written file here is `src/index.ts`, which names what a host
is meant to reach for.
