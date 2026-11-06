import { describe, expect, it } from 'vitest';

import type { PeopleMaskFrame } from '../../editor/people-matte';
import type { EditorStore } from '../../state/editor-store';

import { MatteCanvas } from './matte-canvas';

/**
 * The preview's people put back over the layers behind them, in a real browser: the picture cut out where the
 * store's mask says people are, transparent everywhere else, and out of the page while nobody is to be put back.
 */

function picture(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f00';
  ctx.fillRect(0, 0, 80, 80);
  return canvas;
}

/** A 4 x 4 grid whose left half is a person. */
function leftHalf(version: number): PeopleMaskFrame {
  const cells = new Uint8Array(16);
  for (let y = 0; y < 4; y++) cells.fill(1, y * 4, y * 4 + 2);
  return { width: 4, height: 4, cells, any: true, version };
}

function store(mask: () => PeopleMaskFrame | null, panel: string | null = null): EditorStore {
  return { panel: { value: panel }, peopleMaskAt: mask } as unknown as EditorStore;
}

function alpha(canvas: HTMLCanvasElement, x: number, y: number): number {
  return canvas.getContext('2d')!.getImageData(x, y, 1, 1).data[3]!;
}

describe('MatteCanvas', () => {
  it('is the picture where the people are and nothing where they are not', () => {
    const out = document.createElement('canvas');
    const matte = new MatteCanvas(store(() => leftHalf(1)), out, picture());
    expect(out.hidden).toBe(true);
    matte.paint(500);
    expect(out.hidden).toBe(false);
    expect([out.width, out.height]).toEqual([80, 80]);
    expect(alpha(out, 10, 40)).toBe(255);
    expect(out.getContext('2d')!.getImageData(10, 40, 1, 1).data[0]).toBe(255);
    expect(alpha(out, 70, 40)).toBe(0);
    matte.destroy();
  });

  it('is emptied and hidden once nobody is to be put back, and while the crop sheet is open', () => {
    let mask: PeopleMaskFrame | null = leftHalf(1);
    const out = document.createElement('canvas');
    const matte = new MatteCanvas(store(() => mask), out, picture());
    matte.paint(500);
    mask = null;
    matte.paint(2500);
    expect(out.hidden).toBe(true);
    expect(alpha(out, 10, 40)).toBe(0);
    const cropping = new MatteCanvas(store(() => leftHalf(2), 'crop'), document.createElement('canvas'), picture());
    cropping.paint(500);
    matte.destroy();
    cropping.destroy();
  });
});
