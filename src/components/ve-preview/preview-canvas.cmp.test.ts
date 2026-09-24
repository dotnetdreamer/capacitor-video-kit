import { describe, expect, it, type TestContext } from 'vitest';

import type { EditorStore } from '../../state/editor-store';
import type { Painter } from '../../video-composer/web/painter';
import { PreviewCanvas } from './preview-canvas';

/*
 * The preview's compositor as the stage changes size under it, which it does every time a sheet or
 * the keyboard opens and closes. It keeps its painter and resizes it rather than building a new one
 * each time - a new GL context and every shader compiled again, on the paused frame the customer is
 * looking at - and still builds a new one when the one it has lost its GPU, because that is what
 * gets the GPU back. The pixels a resized painter draws are pinned beside the painter itself.
 */

/** Nothing here reaches the store: every case is synchronous, and the canvas is destroyed before the frame it asks for. */
const NO_STORE = {} as EditorStore;

function painterOf(canvas: PreviewCanvas): Painter | null {
  return (canvas as unknown as { painter: Painter | null }).painter;
}

function glOf(painter: Painter | null): WebGL2RenderingContext | null {
  return (painter as unknown as { gl: WebGL2RenderingContext | null } | null)?.gl ?? null;
}

function mount(): PreviewCanvas {
  const element = document.createElement('canvas');
  return new PreviewCanvas(NO_STORE, element);
}

describe('the preview compositor as the stage changes size', () => {
  it('keeps its painter, and that painter its GL context, across sizes', (ctx: TestContext) => {
    const preview = mount();
    try {
      preview.resize(300, 533);
      const first = painterOf(preview);
      if (!first?.usesGpu) ctx.skip('this browser gives the painter no WebGL2');
      const gl = glOf(first);

      // A sheet opening, then closing again.
      preview.resize(220, 391);
      expect(painterOf(preview)).toBe(first);
      preview.resize(300, 533);
      expect(painterOf(preview)).toBe(first);
      expect(glOf(painterOf(preview))).toBe(gl);
      expect(gl?.isContextLost()).toBe(false);
    } finally {
      preview.destroy();
    }
  });

  it('builds a new painter, on the GPU again, once the one it has has lost its context', (ctx: TestContext) => {
    const preview = mount();
    try {
      preview.resize(300, 533);
      const first = painterOf(preview);
      const lose = glOf(first)?.getExtension('WEBGL_lose_context');
      if (!first?.usesGpu || !lose) ctx.skip('this browser gives the painter no WebGL2 to lose');
      lose!.loseContext();

      preview.resize(220, 391);
      const second = painterOf(preview);
      expect(second).not.toBe(first);
      expect(second?.usesGpu).toBe(true);
    } finally {
      preview.destroy();
    }
  });
});
