/**
 * THE step that makes a frame that was never recorded: given two neighbouring source frames A and B
 * and how far between them the instant is, the picture at that instant.
 *
 * Everything around it - which two frames, how far between them (`slow-motion.ts`), decoding them and
 * holding on to them (`media.ts` for the export, `presented-frames.ts` for the preview), and drawing
 * the result through the clip's crop, fit, rectangle, turn, colour and camera (`painter.ts`) - is
 * plumbing that does not care how the answer is arrived at. This file is the answer, twice: once in
 * GLSL for the painter's GPU path and once on a 2D canvas for its fallback, and the two have to be
 * the same idea.
 *
 * Phase 1 answers with a plain cross-fade, `mix(A, B, w)`. It is honest about what it is: a moving
 * edge becomes two faint edges rather than one edge in between, which reads as motion blur rather
 * than as a jump - and a jump every second or third output frame was the whole complaint.
 *
 * PHASE 2 replaces the body of both functions here with motion-compensated interpolation - optical
 * flow from A to B, and each output pixel read from A a fraction `w` back along its flow vector and
 * from B the rest of the way forward - and nothing else has to change: the flow is a property of the
 * PAIR, so it is worked out once per pair (a pass that would run where the painter first uploads B)
 * and read here per pixel, and the pair and the weight already arrive at this one place in both
 * paths. The operands are the SOURCE frames, at source resolution and before the colour matrix,
 * which is also where a flow estimate wants them.
 */

/**
 * The GPU half: a GLSL function the painter's layer shader calls in place of its one texture read
 * whenever a layer carries a second frame. It is sampled at the very coordinate the plain read would
 * have used, so the crop, the fit, the letterbox test and every transform around it apply to the
 * synthesised frame exactly as they apply to a recorded one.
 *
 * Returns straight (not premultiplied) RGB, as `texture(...).rgb` does for an opaque video frame.
 */
export const INTERPOLATE_FRAMES_GLSL = `
vec3 interpolateFrames(sampler2D frameA, sampler2D frameB, vec2 uv, float w) {
  return mix(texture(frameA, uv).rgb, texture(frameB, uv).rgb, w);
}`;

/**
 * The 2D half: `frameA` and `frameB` mixed at `w` onto `ctx`, over the whole of a `width` x `height`
 * surface - which the painter's fallback then draws from exactly as it would draw a source frame.
 *
 * A over nothing and then B over it at `w`: for opaque frames that is `A * (1 - w) + B * w`, the GPU
 * path's `mix` to within 8-bit rounding. Each frame is drawn to the surface's full size, so the two
 * need not be decoded at the same resolution.
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
