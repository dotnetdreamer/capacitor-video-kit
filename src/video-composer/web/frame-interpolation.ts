import { interpolationBody } from './optical-flow';

/**
 * THE step that makes a frame that was never recorded: given two neighbouring source frames A and B
 * and how far between them the instant is, the picture at that instant.
 *
 * Everything around it - which two frames, how far between them (`slow-motion.ts`), decoding them and
 * holding on to them (`media.ts` for the export, `presented-frames.ts` for the preview), and drawing
 * the result through the clip's crop, fit, rectangle, turn, colour and camera (`painter.ts`) - is
 * plumbing that does not care how the answer is arrived at. This file is the answer, twice: once in
 * GLSL for the painter's GPU path and once on a 2D canvas for its fallback.
 *
 * PHASE 2 answers with MOTION-COMPENSATED interpolation on the GPU. The motion between A and B is a
 * property of the pair and is worked out once per pair, before the frame is drawn, by
 * `optical-flow.ts` (how) and `optical-flow-gl.ts` (on the painter's context); what arrives here, per
 * pixel, is that flow both ways and how far to trust it. The step itself is Super SloMo's (Jiang et
 * al. 2018) with the network taken out, and one change the benchmark asked for:
 *
 *  - The pixel at `uv` is read from A a fraction `w` back along its path and from B the rest of the
 *    way forward, so a moving edge is ONE edge in between, where the cross-fade drew two faint ones.
 *    Super SloMo finds the two points by its linear-motion approximation, reading both flows at the
 *    pixel (`intermediateFlows`); this FOLLOWS each frame's own flow to the point that lands on the
 *    pixel (`trackPoints`). The two agree wherever the motion is uniform, and at the edge of a moving
 *    object - where the pixel's forward flow is the object's and its backward flow the background's -
 *    the approximation mixes them into a point of neither and draws a halo, and following does not.
 *    Measured on the benchmark: better on every moving scene, by up to 1.4 dB.
 *  - The two reads are weighted `(1-w)` and `w`, as the cross-fade's were, times how sure the round
 *    trip is that each point is seen in both frames (`synthesisWeights`). Where the two land on
 *    different surfaces, the one seen in both frames is the one in front; where a moving object
 *    uncovers background, B alone has it and B alone draws it.
 *  - Where neither read can be trusted - neither point found, both off the frame, or a pair the flow
 *    does not explain at all (a cut, a flash, a whip faster than the pyramid) - the pixel falls back
 *    to the cross-fade, smoothly, and so does a pixel where nothing moves, where the cross-fade is
 *    already the answer. A ghost is always better than a tear.
 *
 * The operands are the SOURCE frames, at source resolution and before the colour matrix, so the flow
 * is found in the source's pictures and applied to them before any of the layer's geometry: a crop, a
 * fit, a turn and a zoom all see a synthesised frame exactly as they see a recorded one.
 *
 * THE 2D FALLBACK KEEPS THE CROSS-FADE. A browser without WebGL2 has no way to run the flow, and a
 * browser without WebGL2 is not where anyone exports a post; it gets the blend, which is phase 1's
 * picture and never anything worse.
 *
 * THE PREVIEW keeps the cross-fade: see [PREVIEW_INTERPOLATION] for what the flow costs on the phone
 * the preview has to stay real-time on.
 */

/**
 * The GPU half: a GLSL function the painter's layer shader calls in place of its one texture read
 * whenever a layer carries a second frame. It is sampled at the very coordinate the plain read would
 * have used, so the crop, the fit, the letterbox test and every transform around it apply to the
 * synthesised frame exactly as they apply to a recorded one.
 *
 * The body is shared with the Android engine as text (`interpolationBody`); the painter's program is
 * GLSL ES 3.00, where a texture is read with `texture`. It declares its own four uniforms: `u_flow`
 * and `u_visibility`, the pair's [FlowResult] (texture units 2 and 3), `u_flowSize`, their size in
 * texels, and `u_flowOn`, which is 0 for a pair without one and makes the function the cross-fade it
 * was.
 *
 * Returns straight (not premultiplied) RGB, as `texture(...).rgb` does for an opaque video frame.
 */
export const INTERPOLATE_FRAMES_GLSL = `
#define SAMPLE(sampler, uv) texture(sampler, uv)
${interpolationBody()}`;

/**
 * Which look the live preview draws a slowed clip with while it plays: the CROSS-FADE. Every export
 * follows the motion; the preview is a guide, and it has to stay real-time on the phone it runs on.
 *
 * MEASURED, not assumed, in the app's own WebView on the Samsung A13 (Mali-G52), the target device,
 * painting a 600x1066 preview - the stage at the device's capped pixel ratio - from 720x1280 frames
 * (2026-09-26, each paint timed with a one-pixel read-back to wait for the GPU):
 *
 *   cross-fade frame                      15.8 ms
 *   flow frame, pair already worked out   20.3 ms   (+4.4)
 *   flow frame on a NEW pair              76-86 ms  (+60-70: the passes of `optical-flow.ts`)
 *
 * A clip at 0.3x brings a new pair every three or four displayed frames and one at 0.5x every two, so
 * the flow would ask for 0.5 to 0.9 s of GPU time per second of playback, in spikes of 60 ms - a hitch
 * on every pair, the very stutter slow motion is there to remove, and in a view whose job is to show
 * the customer the edit while they make it. A cheaper flow does not rescue it: the cost is mostly the
 * passes' fixed latency on a tiled GPU, so even a few passes land as a dropped frame per pair. So the
 * preview glides by cross-fading, as phase 1 did, and shows the motion-compensated frames in the
 * export the customer shares.
 */
export const PREVIEW_INTERPOLATION: 'flow' | 'blend' = 'blend';

/**
 * The 2D half: `frameA` and `frameB` mixed at `w` onto `ctx`, over the whole of a `width` x `height`
 * surface - which the painter's fallback then draws from exactly as it would draw a source frame.
 *
 * A over nothing and then B over it at `w`: for opaque frames that is `A * (1 - w) + B * w`, the GPU
 * path's cross-fade to within 8-bit rounding. Each frame is drawn to the surface's full size, so the
 * two need not be decoded at the same resolution. It is the cross-fade and not the flow: see the file
 * comment.
 */
export function interpolateFrames2d(ctx: CanvasRenderingContext2D, frameA: CanvasImageSource, frameB: CanvasImageSource, w: number, width: number, height: number): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'copy';
  ctx.globalAlpha = 1;
  ctx.drawImage(frameA, 0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = Math.min(1, Math.max(0, w));
  ctx.drawImage(frameB, 0, 0, width, height);
  ctx.restore();
}
