import { describe, expect, it } from 'vitest';

import { revealOver } from './cutout-2d';
import { REVEAL_GLOW } from './cutout-gl';

/*
 * The preview's reveal on the painter's 2D path, which mixes as the composite shader does: the picture
 * as it was at the start, the cutout at the end, and the glow round the edge between.
 */
describe('revealOver', () => {
  // Two pixels: one the cutout keeps (alpha 255) and one it takes away (alpha 0), of a red picture.
  const picture = () => Uint8ClampedArray.of(255, 0, 0, 255, 255, 0, 0, 255);
  const cut = () => Uint8ClampedArray.of(255, 0, 0, 255, 255, 0, 0, 0);

  it('is the picture as it was at the start', () => {
    const out = cut();
    revealOver(picture(), out, 0);
    expect([...out]).toEqual([...picture()]);
  });

  it('is the cutout by the end', () => {
    const out = cut();
    revealOver(picture(), out, 1);
    expect([...out.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    // Fully transparent: its colour is never seen.
    expect(out[7]).toBe(0);
  });

  it('takes the background away gradually, in the picture colour', () => {
    const out = cut();
    revealOver(picture(), out, 0.5);
    expect([...out.subarray(4)]).toEqual([255, 0, 0, 128]);
  });

  it('lights the edge between the two at the middle of the reveal', () => {
    const edge = Uint8ClampedArray.of(255, 0, 0, 128);
    revealOver(Uint8ClampedArray.of(255, 0, 0, 255), edge, 0.5);
    expect(edge[3]).toBe(255);
    expect([...edge.subarray(0, 3)]).toEqual(REVEAL_GLOW.map(channel => Math.round(channel * 255)));
  });
});
