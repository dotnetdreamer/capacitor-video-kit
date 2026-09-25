import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditManifest } from '../editor/edit-manifest';
import { applyEditOps } from './ops';
import { summariseManifest } from './summary';

/* An agent's zoom ops land on the same manifest the editor's own actions do, and fail by name. */

const post = (): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('v', 10_000)] });

describe('zoom ops', () => {
  it('adds, updates, moves, duplicates and deletes', () => {
    let m = applyEditOps(post(), [
      { op: 'addZoom', id: 'z', startMs: 1000, cx: 0.9, scale: 3, ease: 'snappy' },
      { op: 'updateZoom', id: 'z', rampMs: 400 },
      { op: 'setZoomWindow', id: 'z', startMs: 1000, endMs: 3000 },
      { op: 'duplicateZoom', id: 'z', newId: 'z2' },
    ]);
    expect(m.zooms.map((z) => [z.id, z.startMs, z.endMs])).toEqual([
      ['z', 1000, 3000],
      ['z2', 3000, 5000],
    ]);
    expect(m.zooms[0]).toMatchObject({ scale: 3, cx: 0.8333, rampMs: 400, ease: 'snappy' });
    expect(summariseManifest(m)).toContain('Zooms: 2 zooms');
    m = applyEditOps(m, [{ op: 'deleteZoom', id: 'z2' }]);
    expect(m.zooms.map((z) => z.id)).toEqual(['z']);
  });

  it('refuses what cannot be done, by name', () => {
    const m = applyEditOps(post(), [{ op: 'addZoom', id: 'z', startMs: 1000, endMs: 4000 }]);
    expect(() => applyEditOps(m, [{ op: 'updateZoom', id: 'nope', scale: 2 }])).toThrow(/no zoom "nope"/);
    expect(() => applyEditOps(m, [{ op: 'addZoom', id: 'z', startMs: 6000 }])).toThrow(/already on this post/);
    expect(() => applyEditOps(m, [{ op: 'addZoom', id: 'y', startMs: 2000 }])).toThrow(/no room/);
    expect(() => applyEditOps(m, [{ op: 'updateZoom', id: 'z', ease: 'bouncy' }])).toThrow();
  });
});
