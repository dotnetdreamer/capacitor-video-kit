import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditManifest } from './edit-manifest';
import { swapTrackZ } from './edit-ops';
import { applyLayoutPreset } from './layout-presets';

/*
 * What Swap is for: which of two videos is drawn over the other.
 *
 * The base track is z 0 in all four engines and nothing sorts below it, so the only way to swap two
 * layers is to move their clips - and the rectangle each layer is drawn in has to STAY, or the
 * arrangement travels with the pictures and the swap undoes itself. With a corner preset that was
 * not merely invisible: the layer covering the whole frame ended up on top of the inset, and one of
 * the customer's two videos was drawn behind it where nobody could see it.
 */

function twoLayers(): EditManifest {
  return {
    ...emptyManifest(),
    clips: [defaultClipEdit('clip-a', 4000, 'seg-a')],
    videoTracks: [
      { id: 'vt', clips: [defaultClipEdit('clip-b', 3000, 'seg-b')], startMs: 0, z: 1, opacity: 1 },
    ],
  };
}

describe('swapTrackZ', () => {
  it('exchanges the two pictures and leaves each layer drawn where it was', () => {
    const laid = applyLayoutPreset(twoLayers(), 'vt', 'pipBR');
    const inset = laid.videoTracks[0].clips[0].rect;
    // The preset a customer taps Swap under: the base over the whole frame, the layer above it in
    // a corner. Absent is the whole frame, which is why the base has no rectangle at all.
    expect(inset).toBeDefined();
    expect('rect' in laid.clips[0]).toBe(false);

    const swapped = swapTrackZ(laid, 'vt');

    expect(swapped.clips.map((clip) => clip.id)).toEqual(['seg-b']);
    expect(swapped.videoTracks[0].clips.map((clip) => clip.id)).toEqual(['seg-a']);
    // The corner is still the corner and the whole frame is still the whole frame. The pictures in
    // them are the other way round, which is the whole of what the button says it does.
    expect('rect' in swapped.clips[0]).toBe(false);
    expect(swapped.videoTracks[0].clips[0].rect).toEqual(inset);
  });

  it('exchanges the two halves of a split screen, and a second tap puts them back', () => {
    const laid = applyLayoutPreset(twoLayers(), 'vt', 'splitTopBottom');
    const topHalf = laid.clips[0].rect;

    const swapped = swapTrackZ(laid, 'vt');

    // The top half is still the top half, with the other video in it. Carrying each rectangle along
    // with its clips leaves both pictures exactly where they were, and between two halves that do
    // not overlap there is no z order to notice the difference: the button does nothing at all.
    expect(swapped.clips[0].id).toBe('seg-b');
    expect(swapped.clips[0].rect).toEqual(topHalf);
    expect(swapTrackZ(swapped, 'vt')).toEqual(laid);
  });
});
