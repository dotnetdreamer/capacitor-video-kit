import { isIdentityView, type CameraView } from '../../editor/camera';

import type { Frame } from './geometry';
import type { LayerDraw, TransitionDraw } from './painter';

/**
 * The camera, as the painter draws it: one per-frame view handed to every VIDEO layer, and the
 * single output-pixel affine both of the painter's paths turn it into.
 *
 * It lives in a module of its own, and not inside the export's loop, because there are two callers
 * that must never disagree - the web render and the editor's live preview both build a frame's
 * draws their own way and then hand them to the same [Painter]. If each put the camera on its draws
 * by itself, the preview would be the one place a customer checks a zoom and the export the one
 * place a zoom is delivered, with two copies of the rule between them. [throughCamera] is the rule,
 * once; both call it right before `paintLayers`.
 *
 * WHY THE CAMERA RIDES ON EACH LAYER rather than being painter-wide state:
 *
 *  - a [TransitionDraw]'s two sides are ordinary [LayerDraw]s, so putting the view on each side is
 *    what makes the camera act INSIDE each side - its clip's whole frame seen through the camera -
 *    and the transition's own move, mask and blur then act in output pixels exactly as before, the
 *    order `ComposeCamera` states. Nothing in `transition-gl.ts` or `transition-2d.ts` has to know;
 *  - overlays never go through a layer, so they cannot be moved by accident: the export paints them
 *    with `paintOverlay` after `paintLayers`, and the preview keeps them in the DOM;
 *  - a layer that should one day stay put under a zoom (a webcam picture-in-picture) is a layer
 *    this simply does not set it on.
 */

/**
 * The camera as ONE affine in output pixels: a point `p` of a layer as drawn with no camera lands at
 * `p * scale + (tx, ty)`. The same map `viewPoint` states in fractions, `p' = 0.5 + (p - c) * scale`,
 * multiplied out by the frame's size - the visible area has the output's own aspect, so the scale is
 * the same on both axes and the map is a uniform similarity. Being one, it commutes with a layer's
 * turn about its own pivot, which is why the painter can apply it after the turn as one more step
 * and leave every piece of layout arithmetic (source window, bounds, pivot, bars) untouched.
 */
export function cameraAffine(view: CameraView, output: Frame): { scale: number; tx: number; ty: number } {
  const scale = view.scale;
  return {
    scale,
    tx: output.width * (0.5 - scale * view.cx),
    ty: output.height * (0.5 - scale * view.cy),
  };
}

/**
 * One draw seen through `view`: a layer with the view on it, or a transition with the view on BOTH
 * sides. The SAME object back for no view, or a view that moves nothing - so a frame outside every
 * zoom is the very array of draws it was, and the painter takes exactly the path it took before
 * zooms existed.
 */
export function withCamera<D extends LayerDraw | TransitionDraw>(draw: D, view: CameraView | null | undefined): D {
  if (!view || isIdentityView(view)) return draw;
  if ((draw as Partial<TransitionDraw>).kind === 'transition') {
    const transition = draw as TransitionDraw;
    return {
      ...transition,
      from: transition.from && { ...transition.from, camera: view },
      to: transition.to && { ...transition.to, camera: view },
    } as D;
  }
  return { ...(draw as LayerDraw), camera: view } as D;
}

/**
 * Every video draw of one frame through `view` - the call both the export and the preview make
 * immediately before `Painter.paintLayers`. The same array back for no view.
 *
 * `view` is `cameraAt(camera, ms)` at the frame's own instant: the export's `atUs / 1000`, the
 * preview's clock. Never apply it to overlays - they are not in this list, and that is the point.
 */
export function throughCamera<D extends LayerDraw | TransitionDraw>(draws: D[], view: CameraView | null | undefined): D[] {
  if (!view || isIdentityView(view)) return draws;
  return draws.map(draw => withCamera(draw, view));
}
