# Canvas compositing for the live preview

## What to build

`ve-preview` draws the post as a stack of positioned `<video>` elements, one per video layer, with
CSS doing the placement, the rotation, the colour filter and the opacity. Replace that with **one
`<canvas>` that composites every layer itself**, drawn from the same `<video>` elements kept as
hidden sources.

## Why

CSS-stacked elements cannot blend. Blend modes, transitions between layers and per-layer effects are
all impossible while the compositor is the browser's, and they are the next things this editor wants.
A canvas also makes the preview and the export the *same code*, which is the stronger reason: today
they are two implementations of one contract that agree by inspection.

## The shortcut: there is already a compositor

`src/video-composer/web/painter.ts` is the browser renderer's canvas compositor. It already:

- takes `HTMLVideoElement` as a layer source (`LayerSource`),
- places a layer with `dest` (a rect in frame fractions) and applies `crop`/`fit` through
  `sourceWindow` in `web/geometry.ts`,
- applies the colour matrix and the tints through `setColour`, matching the render,
- draws overlay bitmaps with `paintOverlay`,
- has a WebGL2 path and a 2D fallback, with `usesGpu` saying which ran.

**Use it for the preview.** Then the preview is literally what the browser renderer draws, and the
two cannot drift.

## What `Painter` is missing (do this first)

**Clip rotation.** `LayerDraw` has no `rotationDeg`, the vertex shader places an axis-aligned quad
from `u_dest`, and `readPlacement` in `web/spec.ts` does not read the angle off the wire. The preview
*does* rotate clips today (CSS `transform: rotate`), so moving to the painter without this is a
visible regression.

Fix it in the painter, not around it:

1. Add `rotationDeg` to `LayerDraw`.
2. 2D path: rotate about the dest rect's centre **in output pixels** before the clip and the draw —
   `translate(cx, cy); rotate(rad); translate(-cx, -cy)`.
3. GL path: rotate the quad about the same centre in the vertex shader. Output pixels, not
   normalised space: a square turned 45° in normalised coordinates comes out a rhombus on a frame
   that is not square. `ComposePlacement` in `src/video-composer/definitions.ts` states the contract.
4. Thread it through `web/plan.ts` and stop dropping it in `web/spec.ts`.

That also fixes a real gap: **the browser renderer currently ignores clip rotation**, so a turned
clip exports upright there while both native engines turn it.

## Design notes

**Size the painter to the screen, not to the output.** Everything `Painter` takes is in fractions, so
construct it at the stage's on-screen size × `devicePixelRatio` (cap it, ~2). Compositing a 4K post
at 4K every frame for a 400px preview is pure waste.

**Keep the `<video>` elements.** One per video track, exactly as now — the per-track follower
plumbing in `preview-player.ts` and `follower-video.ts` is what seeks them and stays unchanged. They
become invisible sources. Do **not** use `display: none`: some WebViews stop decoding. Keep them laid
out with `opacity: 0; pointer-events: none` (or 1×1 and clipped) so they still present frames.

**The holds become free.** `pv__hold`, the `holding` signals and `repaintPaused` exist because a
`<video>` pointed at a new source paints black through the load. A canvas keeps whatever was last
drawn: skip a layer whose element has `readyState < 2` and the previous frame simply stays. Most of
`preview-media.ts`'s hold machinery can go.

**Chrome stays DOM.** Selection box and handles, snap guides, the bin, the crop window, the
placeholder, the REC pill. They are UI, not picture, and they need hit testing.

**The draw loop.** `requestAnimationFrame` while playing; on demand otherwise — playhead moved, edit
changed, a layer's box changed, a bitmap landed, a seek settled. Do not draw on a timer when nothing
moved.

## Already done, do not redo

- **No layer cap.** The preview renders one element per track with no limit (it was two). Per *track*
  and not per layer-under-playhead, deliberately: an element that only existed while its clip was
  under the playhead was destroyed and reloaded on every gap crossing.
- **The frame is a choice.** `manifest.output` carries width/height/fps; `store.frameAspect` and
  `store.outputWidth` are signals. Anything sizing a box reads those, never a constant.
- **Free canvas.** A clip's rect may hang off the frame; only `MIN_ON_FRAME` of it must stay on.

## Risks worth knowing before starting

- **iOS WKWebView** is the platform that breaks this kind of thing. Drawing a paused, invisible
  `<video>` to a canvas is where to expect trouble; test on a device early, not at the end.
- **CPU and battery.** The browser composites video in hardware today; this moves it into JS per
  frame. The GL path matters on phones.
- **`ctx.filter`** (the 2D fallback's colour) is not universal on older WebKit. The GL path carries
  the matrix and is the real answer; check what the fallback does on the oldest supported WebView.
- **The sound is already partly in Web Audio on iOS.** `preview-mixer.ts` plays the music and the
  voiceover elements through an `AudioContext` there, because a WKWebView ignores `volume`, and an
  element handed to `createMediaElementSource` can never be taken back out. The clip `<video>`
  elements this work keeps as sources are deliberately not routed - WebKit's route into Web Audio
  does not follow `playbackRate` - so their sound is still the elements' own. Drawing them to a
  canvas does not change that, and nothing in this work should route them: whether a routed
  `<video>` plays whole at 0.5x or 2x is a device check that has not been made, and a routed element
  stays routed for the life of the page.

## Tests that will need rewriting

`src/components/ve-preview/ve-preview.cmp.test.ts` measures per-element boxes and asserts on hold
canvases — none of which exist afterwards. The cases still matter; they have to be re-expressed
against the canvas (read pixels back, as `web/render.cmp.test.ts` already does with `pixelAt`):

- swap puts the inset on top rather than behind,
- a layer that hangs off the frame is cut at the edge,
- several layers are all drawn,
- an element is kept while the playhead is outside its track's window.

## Done when

- Every layer appears in the preview, in z order, with crop, fit, rect, rotation and opacity — same
  picture as `web/render.ts` produces for the same manifest.
- Filters and tints match the export.
- Text, stickers, photos and effects draw over the video in the right order.
- Source swaps show the previous frame rather than black.
- `npm test` passes, including the rewritten preview tests.
- Checked on a real iPhone and a real Android device, not only in Chrome.
