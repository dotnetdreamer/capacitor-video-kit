import { describe, expect, it } from 'vitest';

import type { EditClip } from '../../editor';
import { applyPitch } from './preview-media';

/**
 * Pitch correction on a preview element: on only where the clip's own sound is heard. On iOS it is
 * what makes every change of rate on a playing element flush the player back to a keyframe, so a
 * clip nobody can hear must not have it - and one that can be heard must, or a slowed clip's sound
 * drops in pitch where the render keeps it.
 */

function clip(extra: Partial<EditClip> = {}): EditClip {
  return { id: 'a', clipKey: 'one', inMs: 0, outMs: 1000, speed: 0.5, volume: 1, muted: false, ...extra };
}

/** An element that counts its writes, as the media process would see them. */
function element(preservesPitch: boolean | undefined = true) {
  let value: boolean | undefined = preservesPitch;
  let writes = 0;
  return {
    get preservesPitch() {
      return value;
    },
    set preservesPitch(keep: boolean | undefined) {
      writes += 1;
      value = keep;
    },
    get writes() {
      return writes;
    },
  };
}

describe('applyPitch', () => {
  it('keeps the pitch of a clip whose sound is heard', () => {
    const video = element(false);
    applyPitch(video, clip(), false);
    expect(video.preservesPitch).toBe(true);
  });

  it('turns it off for a clip that is muted, turned right down, or silenced with the rest of the post', () => {
    for (const [edit, silenced] of [
      [clip({ muted: true }), false],
      [clip({ volume: 0 }), false],
      [clip(), true],
    ] as const) {
      const video = element(true);
      applyPitch(video, edit, silenced);
      expect(video.preservesPitch).toBe(false);
    }
  });

  it('writes only when it has to, and puts back what a WebView reset with a new source', () => {
    const video = element(false);
    applyPitch(video, clip({ muted: true }), false);
    applyPitch(video, clip({ muted: true }), false);
    expect(video.writes).toBe(0);
    // A new source: this WebView turned it back on by itself.
    video.preservesPitch = true;
    applyPitch(video, clip({ muted: true }), false);
    expect(video.preservesPitch).toBe(false);
    expect(video.writes).toBe(2);
  });
});
