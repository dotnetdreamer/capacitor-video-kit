# capacitor-video-kit

Video editing and publishing for Capacitor apps, with an editor built from web components
Use it with React, Vue, Angular, or plain JavaScript on Android, iOS, and the web

## Features

- Trim, join, crop, and change clip speed; add filters, transitions, text, stickers, music, voiceovers, and stackable audio effects over everything heard
- Render on the device with `VideoComposer`, or use the browser's encoder
- Upload files and finalize a request to your own API with `BackgroundPublisher`
- Embed `<ve-editor>` or build your own interface using the shared edit manifest and composition API
- Access gallery media, thumbnails, and a sound library through the plugin

## Platforms and requirements

| Platform | Rendering | Publishing |
|---|---|---|
| Android (API 24+ by default) | Media3 Transformer | WorkManager background uploads |
| iOS 16+ | AVFoundation; app must stay in the foreground while rendering | Background URLSession; requires AppDelegate setup |
| Web | WebCodecs, with a MediaRecorder fallback | Uploads while the page is open; staged files can resume after reload |

- Node.js **20.19+** to build the package
- **Capacitor 8+** for the plugin entry point, including its web implementation The editor-only entry points work without Capacitor
- Editor consumers install `@preact/signals-core`, plus their chosen framework TypeScript consumers of the components also need `@stencil/core`

Android has recorded device checks; iOS has build and simulator coverage, with device validation still outstanding
See [platform behavior](docs/platforms.md) for encoding limits and background behavior

## Try the editor

From a checkout of this repository:

```sh
npm install --ignore-scripts
npm --prefix packages/angular install --ignore-scripts
npm run build
npm run example
```

Open the local URL printed by the example server The demo lets you edit clips and returns an edit
manifest To export a video, connect `composerRenderHost()` as shown in the
[editor integration guide](docs/editor.md#a-capacitor-app-where-the-native-engines-do-the-rendering)

## Install in an app

The package is currently private and unpublished Install from a built checkout or a tarball
After building the repository with the commands above, create a tarball:

```sh
npm pack --ignore-scripts
```

Then, in your Capacitor app:

```sh
npm install ../path/to/capacitor-video-kit-1.3.0.tgz
npx cap sync
```

The host provides `@capacitor/core` iOS hosts must set their deployment target to **16 or later**
before syncing and add the permissions and publisher hooks their features need
See [installation](docs/installation.md) for local linking, dependencies, and iOS setup

To embed the editor, serve its assets, call `setEditorAssetPath()` and await `installEditorFonts()`,
then pass `sources` and handle `veDone` and `veCancel` Use the binding for your framework:

| Interface | Import |
|---|---|
| Native and web plugins | `capacitor-video-kit` |
| Edit manifest and composition helpers | `capacitor-video-kit/editor` |
| Editor configuration and helpers | `capacitor-video-kit/ui` |
| React / Vue / Angular components | `capacitor-video-kit/react`, `/vue`, `/angular` |
| Plain JavaScript components | `capacitor-video-kit/dist/components/ve-editor.js` |

## Documentation

See the [documentation index](docs/README.md) for all guides and design notes

| Guide | Covers |
|---|---|
| [Installation](docs/installation.md) | Dependencies, local installs, iOS permissions, and entry points |
| [Editor integration](docs/editor.md) | Plain JavaScript, React, Vue, Angular, and Capacitor examples |
| [Assets and customization](docs/editor-customization.md) | Fonts, themes, host options, and output limits |
| [Video composition](docs/composer.md) | Job lifecycle, events, and failure codes |
| [Background publishing](docs/publishing.md) | Upload configuration, retries, and migration |
| [Media and gallery access](docs/media.md) | Picking, saving, labeling, and retaining media |
| [Native host helpers](docs/native-hosts.md) | File paths, permissions, and picker integration |
| [MCP server](docs/mcp.md) | Optional tools for editing manifests through agents |
| [Development](docs/development.md) | Builds, tests, architecture, and design decisions |

## License

Proprietary Copyright 2026 [dotnetdreamer](https://github.com/dotnetdreamer) See [LICENSE](LICENSE) for usage terms
