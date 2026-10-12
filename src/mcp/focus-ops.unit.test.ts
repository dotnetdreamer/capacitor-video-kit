import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditManifest } from '../editor/edit-manifest';
import { applyEditOps } from './ops';
import { summariseManifest } from './summary';

/* An agent's focus lands on the clip as the Focus sheet's would, and what the editor would mend is refused by name. */

const post = (): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('v', 10_000, 'a')] });

describe('setClipFocus', () => {
  it('puts a focus on, filling what is left out as the sheet does, and takes it off with null', () => {
    const on = applyEditOps(post(), [{ op: 'setClipFocus', clipId: 'a', focus: {} }]);
    expect(on.clips[0]!.focus).toEqual({ subjects: 'main', blur: 0.5 });
    const full = applyEditOps(post(), [
      { op: 'setClipFocus', clipId: 'a', focus: { subjects: [2, 1], blur: 0.8, mono: 1, dim: 0.25, invert: true, changes: [{ atMs: 4000, subjects: 'all', pullMs: 800 }] } },
    ]);
    expect(full.clips[0]!.focus).toEqual({ subjects: [1, 2], blur: 0.8, mono: 1, dim: 0.25, invert: true, changes: [{ atMs: 4000, subjects: 'all', pullMs: 800 }] });
    const off = applyEditOps(full, [{ op: 'setClipFocus', clipId: 'a', focus: null }]);
    expect('focus' in off.clips[0]!).toBe(false);
  });

  it('says it in the summary', () => {
    const m = applyEditOps(post(), [{ op: 'setClipFocus', clipId: 'a', focus: { subjects: 'all', blur: 0.6, mono: 0.5, changes: [{ atMs: 3000, subjects: [2] }] } }]);
    expect(summariseManifest(m)).toContain('focus on every subject (blur 0.6, mono 0.5), then subjects 2 from 3000ms (0:03.0) of the source');
  });

  it('refuses a choice, a look or a change the editor would have to mend', () => {
    const apply = (focus: unknown) => () => applyEditOps(post(), [{ op: 'setClipFocus', clipId: 'a', focus }]);
    expect(apply({ subjects: 'everybody' })).toThrow(/focus.subjects must be "main", "all" or a list/);
    expect(apply({ subjects: [0] })).toThrow(/whole numbers 1..255/);
    expect(apply({ blur: 2 })).toThrow(/focus.blur must be a number from 0 to 1/);
    expect(apply({ invert: 'yes' })).toThrow(/focus.invert must be true or false/);
    expect(apply({ changes: [{ atMs: 20_000, subjects: 'all' }] })).toThrow(/inside its trim \(0..10000ms\)/);
    expect(apply({ changes: [{ atMs: 2000, subjects: 'all', pullMs: 9000 }] })).toThrow(/pullMs must be 0 to 3000ms/);
    expect(apply('main')).toThrow();
    expect(() => applyEditOps(post(), [{ op: 'setClipFocus', clipId: 'nobody', focus: {} }])).toThrow(/nobody/);
  });
});
