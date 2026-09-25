import { describe, expect, it } from 'vitest';

import type { LayerDraw } from './painter';
import { RenderFailure, settleInOrder } from './render';

/*
 * How a frame's layers, asked for their frames all at once, are answered - the one part of the
 * frame loop that is not the browser's. The pictures themselves are `render.cmp.test.ts`'s.
 */
describe('settleInOrder', () => {
  const layer = (name: string): LayerDraw => ({ name }) as unknown as LayerDraw;
  const after = <T>(ms: number, settle: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => setTimeout(() => Promise.resolve().then(settle).then(resolve, reject), ms));

  it('answers every layer in the order it was asked, whatever order they land in', async () => {
    const base = layer('base');
    const top = layer('top');
    await expect(settleInOrder([after(20, () => base), null, after(0, () => top), Promise.resolve(null)])).resolves.toEqual([base, null, top, null]);
  });

  /* The clip blamed is the one the render blamed when it asked the layers in turn: the first in drawing order. */
  it('throws the first failure in drawing order, not the first to happen', async () => {
    const baseFailure = new RenderFailure('unreadable_input', 'base', 'a');
    const layerFailure = new RenderFailure('unreadable_input', 'layer', 'c');

    await expect(
      settleInOrder([
        after(20, () => {
          throw baseFailure;
        }),
        null,
        Promise.reject(layerFailure),
      ]),
    ).rejects.toBe(baseFailure);
  });

  /* A layer still opening when the cleanup closes every element would keep its decoder after the close. */
  it('lets every layer settle before it throws', async () => {
    let landed = false;
    const failure = new RenderFailure('unreadable_input', 'base', 'a');

    await expect(
      settleInOrder([
        Promise.reject(failure),
        after(20, () => {
          landed = true;
          return layer('tail');
        }),
      ]),
    ).rejects.toBe(failure);
    expect(landed).toBe(true);
  });
});
