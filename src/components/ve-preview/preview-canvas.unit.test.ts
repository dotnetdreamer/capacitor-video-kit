import { describe, expect, it } from 'vitest';

import { compileTransition, lookAt } from '../../editor';
import type { PreviewVideoLayer } from '../../state/editor-store';
import type { TransitionDraw } from '../../video-composer/web/painter';
import { baseDraw, layerDraw, orderedLayers, type BaseShot } from './preview-canvas';

/**
 * What the preview hands its compositor, which is the one thing that has to agree with `render.ts`
 * layer for layer. The pixels are pinned in the browser test beside this; these are the two shapes
 * that decide where those pixels land, and they are arithmetic.
 */

function layer(over: Partial<PreviewVideoLayer> = {}): PreviewVideoLayer {
  return {
    trackId: null,
    clipId: 'seg',
    clipKey: 'clip',
    sourceMs: 0,
    rect: null,
    crop: null,
    fit: 'contain',
    opacity: 1,
    z: 0,
    ...over,
  };
}

/** Stands in for a loaded element: the compositor reads nothing off it but its picture's shape. */
const source = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;

describe('the preview compositor', () => {
  it('draws the base track first, whatever z a layer above it claims', () => {
    // The render draws the base and then the planned tracks, and both native engines do the same:
    // the base is the bottom of the stack and a layer cannot sort under it.
    const order = orderedLayers([layer({ trackId: 'under', clipId: 'a', z: -5 }), layer({ trackId: null, clipId: 'base', z: 0 }), layer({ trackId: 'over', clipId: 'b', z: 3 })]);
    expect(order.map(one => one.clipId)).toEqual(['base', 'a', 'b']);
  });

  it("keeps the base track's rectangle in its FRAMING, drawn into the whole frame", () => {
    // `render.ts` places a base clip by folding its rectangle in with the crop and the fit, into a
    // destination that is the whole frame. Handing the rectangle over as a destination instead
    // would black the whole frame at the layer's opacity - the painter fills a layer's own frame
    // before drawing it - and wipe out nothing here, but everything under an extra layer.
    const draw = layerDraw(layer({ rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }), source);
    expect(draw.dest).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(draw.framing).toEqual({ fit: 'cover', crop: undefined, rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  });

  it("makes an extra layer's rectangle its DESTINATION, as the plan does", () => {
    const draw = layerDraw(layer({ trackId: 'pip', rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, crop: { x: 0, y: 0, w: 0.5, h: 1 }, opacity: 0.5 }), source);
    // NARROWED to the shape the picture comes out at, not the rectangle itself. A 1920x1080 source
    // cropped to its left half is a 960x1080 picture; contained in a rectangle half the frame each
    // way on a 9:16 post, width is the tight axis, so the rectangle keeps its width and loses the
    // height it was only ever going to fill with black. The picture lands in the same place either
    // way - this is the bars going, not the video moving.
    expect(draw.dest.x).toBeCloseTo(0.5, 6);
    expect(draw.dest.w).toBeCloseTo(0.5, 6);
    expect(draw.dest.h).toBeCloseTo(0.31640625, 6);
    // Still centred in the rectangle it was given, which is what `contain` has always done.
    expect(draw.dest.y + draw.dest.h / 2).toBeCloseTo(0.75, 6);
    // The rectangle is GONE from the framing: left on, it would place the picture inside the layer
    // a second time - the same thing `planTrack` takes it off the clip for.
    expect(draw.framing).toEqual({ fit: 'contain', crop: { x: 0, y: 0, w: 0.5, h: 1 } });
    expect(draw.opacity).toBe(0.5);
  });

  it('leaves a cover layer its whole rectangle, which it fills', () => {
    // Nothing to narrow: `cover` reaches every edge of the rectangle by definition and what hangs
    // over is clipped, so the layer has no bars to black out in the first place.
    const rect = { x: 0.1, y: 0.2, w: 0.6, h: 0.3 };
    const draw = layerDraw(layer({ trackId: 'pip', rect, fit: 'cover' }), source);
    expect(draw.dest).toEqual(rect);
  });

  it('gives a contain layer a destination its picture fills exactly, so its bars cannot cover the base', () => {
    // The painter blacks a layer's own frame before drawing into it. On the base that black IS the
    // post's background; on a layer it is opaque black over whatever is underneath, which is the
    // black box that used to appear around a picture-in-picture. A destination that is already the
    // picture's shape has no bar left in it to be the wrong colour - so what this checks is that
    // the two shapes are one shape.
    const frameAspect = 9 / 16;
    const draw = layerDraw(layer({ trackId: 'pip', rect: { x: 0, y: 0, w: 1, h: 1 } }), source, frameAspect);
    const destAspect = (draw.dest.w * frameAspect) / draw.dest.h;
    expect(destAspect).toBeCloseTo(source.videoWidth / source.videoHeight, 6);
  });

  it('carries the angle off the rectangle for either kind of layer', () => {
    const rect = { x: 0.2, y: 0.2, w: 0.4, h: 0.4, rotationDeg: 30 };
    expect(layerDraw(layer({ rect }), source).rotationDeg).toBe(30);
    expect(layerDraw(layer({ trackId: 'pip', rect }), source).rotationDeg).toBe(30);
    // Absent is upright, which is the path a post that nobody framed takes.
    expect(layerDraw(layer(), source).rotationDeg).toBe(0);
  });

  it("takes the picture's shape off the element, which is what the fit is measured against", () => {
    const draw = layerDraw(layer(), source);
    expect(draw.sourceWidth).toBe(1920);
    expect(draw.sourceHeight).toBe(1080);
    expect(draw.source).toBe(source);
  });
});

describe('the base track in a transition', () => {
  /*
   * What the preview hands the compositor for the base track, which inside a transition is ONE item
   * in the base track's place - the item `render.ts` builds for the same frame - with each side the
   * very layer its clip would be drawn as on its own.
   */
  const outgoing = { videoWidth: 1080, videoHeight: 1920 } as HTMLVideoElement;
  const incoming = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;
  const dissolve = compileTransition('dissolve')!;

  function shot(
    over: { to?: HTMLVideoElement | null; from?: HTMLVideoElement | null; lost?: boolean; toLost?: boolean } = {},
  ): BaseShot {
    return {
      layer: layer({ clipId: 'in', clipKey: 'b', fit: 'cover' }),
      video: over.to === undefined ? incoming : over.to,
      lost: over.toLost ?? false,
      transition: {
        layer: layer({ clipId: 'out', clipKey: 'a', rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8, rotationDeg: 12 } }),
        video: over.from === undefined ? outgoing : over.from,
        lost: over.lost ?? false,
        progress: 0.5,
        compiled: dissolve,
      },
    };
  }

  it("draws each side as its own clip's layer, with the look at the shot's progress", () => {
    const { draw, tailComing } = baseDraw(shot(), 9 / 16, false, null);
    expect(tailComing).toBe(false);
    const transition = draw as TransitionDraw;
    expect(transition.kind).toBe('transition');
    // Each side framed by ITS clip: the outgoing one keeps its own rectangle and angle.
    expect(transition.from).toEqual(layerDraw(shot().transition!.layer, outgoing, 9 / 16));
    expect(transition.from!.rotationDeg).toBe(12);
    expect(transition.to).toEqual(layerDraw(shot().layer, incoming, 9 / 16));
    expect(transition.look).toEqual(lookAt(dissolve.curves, 0.5));
    expect(transition.transition).toBe(dissolve);
  });

  it('asks for a short wait while the outgoing side is still on its way', () => {
    const { draw, tailComing } = baseDraw(shot({ from: null }), 9 / 16, false, null);
    expect(tailComing).toBe(true);
    // And what is painted once the wait runs out: the incoming side, the outgoing one absent.
    expect((draw as TransitionDraw).from).toBeNull();
    expect((draw as TransitionDraw).to).not.toBeNull();
  });

  it('does not wait for an outgoing clip that could not be loaded', () => {
    expect(baseDraw(shot({ from: null, lost: true }), 9 / 16, false, null).tailComing).toBe(false);
  });

  it('draws nothing while the incoming side is on its way, so the frame is held as for any base clip', () => {
    // The painter would draw the outgoing side at its FULL level with the incoming one left out: the
    // picture jumping back to the clip the transition is leaving, for as long as a seek takes.
    expect(baseDraw(shot({ to: null }), 9 / 16, false, null)).toEqual({ draw: null, tailComing: false });
  });

  it('draws the outgoing side alone when the incoming clip could not be loaded', () => {
    const { draw, tailComing } = baseDraw(shot({ to: null, toLost: true }), 9 / 16, false, null);
    expect(tailComing).toBe(false);
    expect((draw as TransitionDraw).to).toBeNull();
    expect((draw as TransitionDraw).from).not.toBeNull();
  });

  it('has nothing to draw when neither side has a frame', () => {
    expect(baseDraw(shot({ to: null, from: null }), 9 / 16, false, null)).toEqual({ draw: null, tailComing: false });
  });

  it('draws the clip under the playhead alone, as the tool needs it, while the crop sheet is open', () => {
    const { draw } = baseDraw(shot(), 9 / 16, true, 'in');
    expect(draw).toEqual(layerDraw(shot().layer, incoming, 9 / 16, true));
  });

  it('is a plain layer outside a transition', () => {
    const plain: BaseShot = { ...shot(), transition: null };
    expect(baseDraw(plain, 9 / 16, false, null).draw).toEqual(layerDraw(plain.layer, incoming, 9 / 16));
  });
});
