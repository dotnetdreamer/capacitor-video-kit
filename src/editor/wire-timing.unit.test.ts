import { describe, expect, it } from 'vitest';

import type { ComposeClip, ComposeSpec } from '../video-composer/definitions';
import { toComposeSpec } from './compose';
import { clipsDurationMs, defaultClipEdit, emptyManifest, type EditClip, type EditManifest } from './edit-manifest';
import type { RasterContext } from './raster-context';

/*
 * The wire sends every video segment with at least 100 ms of source. A template's hard slow on the
 * hit has less - a 240 ms step at 0.3x is 72 ms of footage - and lengthening it at the same speed
 * made the export run that step 93 ms long and every cut after it late. These pin what the export
 * must keep: the timeline the editor shows.
 */

const uris = new Map([['v', 'file:///v.mp4']]);
const wire = (m: EditManifest): Promise<ComposeSpec> => toComposeSpec(m, uris, { jobId: 'j', batchId: 'b' }, {} as RasterContext);

/** One stretch of the same clip, `outputMs` long at `speed`, starting at `fromMs` in the source. */
function step(id: string, fromMs: number, outputMs: number, speed: number): EditClip {
  return { ...defaultClipEdit('v', 60_000, id), inMs: fromMs, outMs: fromMs + Math.round(outputMs * speed), speed };
}

/** How long a wired segment plays, in output ms. */
const plays = (clip: ComposeClip) => (clip.outMs - clip.inMs) / clip.speed;

describe('a segment with less than 100 ms of source', () => {
  const ramp = [step('fast', 0, 250, 2), step('hit', 500, 240, 0.3), step('out', 572, 250, 4), step('next', 1572, 1000, 1)];
  const post: EditManifest = { ...emptyManifest(), clips: ramp };

  it('plays exactly as long on the wire as in the editor', async () => {
    const spec = await wire(post);
    const hit = spec.clips[1];
    // The floor is kept, and the speed raised so 100 ms of source still plays in the step's 240 ms.
    expect(hit.outMs - hit.inMs).toBe(100);
    expect(hit.speed).toBeCloseTo(0.3 * (100 / 72), 6);
    expect(plays(hit)).toBeCloseTo(240, 6);
    // So the whole cut is as long as the editor's, and the cut after the hit is on its beat.
    const wiredMs = spec.clips.reduce((total, clip) => total + plays(clip), 0);
    expect(wiredMs).toBeCloseTo(clipsDurationMs(post.clips), 3);
    expect(plays(spec.clips[0]) + plays(spec.clips[1])).toBeCloseTo(490, 3);
  });

  it('leaves a segment with enough source exactly as it was', async () => {
    const spec = await wire(post);
    expect(spec.clips[0]).toMatchObject({ inMs: 0, outMs: 500, speed: 2 });
    expect(spec.clips[3]).toMatchObject({ inMs: 1572, outMs: 2572, speed: 1 });
  });

  it('gives a transition the stretched source it takes, so the overlap keeps its output length', async () => {
    const withTransition: EditManifest = {
      ...emptyManifest(),
      clips: [step('hit', 500, 300, 0.3), { ...step('next', 1000, 1000, 1), transitionIn: { kind: 'dissolve', durationMs: 100 } }],
    };
    const spec = await wire(withTransition);
    const [hit, next] = spec.clips;
    // The hit plays its 300 ms less the half of the dissolve laid before the cut, the dissolve's tail
    // of it plays that same half, and the two together are still the step's 300 ms.
    expect(next.transitionIn).toBeDefined();
    const tail = next.transitionIn!.from;
    expect(tail.speed).toBeCloseTo(hit.speed, 6);
    expect(plays(hit) + plays(tail)).toBeCloseTo(300, 0);
  });
});
