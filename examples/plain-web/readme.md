# The editor in a plain page

No framework, no bundler and no build step. One import map, one `defineCustomElement()` call and one
element, over two of MDN's example videos.

```sh
npm run build:package    # once, in the repository root, so dist/ exists
npm run example
```

Then open the URL it prints. `PORT=5174 npm run example` if 5173 is taken.

| File | What it is |
|---|---|
| `index.html` | the import map, which is what resolves a bare specifier when there is no bundler, and the page's own three elements |
| `example.js` | the whole integration: an asset base, the fonts, one define, one element, two listeners |
| `example.css` | the page around the editor, which styles nothing inside it |
| `serve.mjs` | a static server with no dependencies, serving this directory, `node_modules/` and the package's assets at `/video-editor/assets/` |

There is no `host` object anywhere in it. The editor falls back to the browser: the pickers are file
inputs, the durations come from a throwaway `<video>`, the filmstrip is cut with a canvas, and Next
hands back the manifest unrendered, because encoding a video is the one thing a browser has no
answer for. Everything else, the preview, the timeline, every sheet, undo, is the package.

The line along the bottom of the page is the claim this example exists to check: **one
`defineCustomElement()` call defines all twenty two tags**, because Stencil reads the child tags out
of each component's own render and the graph is transitive. If it ever reads "21 of 22", a component
is rendering a child through a variable instead of a literal tag.

## The filmstrip is blank here, and it is not the example

The two clips come from `mdn.github.io`, and the filmstrip the browser default cuts is drawn on a
canvas. A video from another origin taints that canvas, so the very last step, turning the frame
into a data URL, throws:

```
SecurityError: Failed to execute 'toDataURL' on 'HTMLCanvasElement':
Tainted canvases may not be exported.
```

The lanes stay grey and nothing says why, because the editor treats a filmstrip it cannot cut as one
it does not have. MDN does send `access-control-allow-origin: *`, so what is missing is the request
asking for it: `video.crossOrigin = 'anonymous'` in `canvasThumbnails` in `src/host/defaults.ts`,
set before the `src`. With it, the same page cuts real tiles.

Nothing about it is specific to this example. Any host whose clips are on a CDN gets the same blank
lane, and a host that picks a file through the editor does not, because an object URL is same
origin.
