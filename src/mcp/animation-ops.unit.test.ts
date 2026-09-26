import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditManifest } from '../editor/edit-manifest';
import { applyEditOps } from './ops';
import { summariseManifest } from './summary';
import { createTools } from './tools';

/* An agent animates a layer with the same field the editor stores, and a preset it mistypes fails by name. */

const post = (): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('v', 10_000)] });

describe('layer animation ops', () => {
  it('adds a layer that moves, changes its moves, takes them away, and says them in the summary', () => {
    let m = applyEditOps(post(), [
      { op: 'addText', id: 't', text: 'Hi', animation: { in: { id: 'pop', durationMs: 470 }, loop: { id: 'pulse', periodMs: 1000 } } },
      { op: 'addEffect', id: 'e', effectId: 'vignette', animation: { in: { id: 'fade', durationMs: 99_999 } } },
    ]);
    expect(m.overlays[0].animation).toEqual({ in: { id: 'pop', durationMs: 470 }, loop: { id: 'pulse', periodMs: 1000 } });
    // Clamped the way the editor clamps it.
    expect(m.overlays[1].animation).toEqual({ in: { id: 'fade', durationMs: 2000 } });
    expect(summariseManifest(m)).toContain('in pop 470ms, loop pulse every 1000ms');

    m = applyEditOps(m, [{ op: 'patchOverlay', id: 't', patch: { animation: { out: { id: 'sink', durationMs: 400 } } } }]);
    expect(m.overlays[0].animation).toEqual({ out: { id: 'sink', durationMs: 400 } });
    m = applyEditOps(m, [{ op: 'patchOverlay', id: 't', patch: { animation: null } }]);
    expect('animation' in m.overlays[0]).toBe(false);
  });

  it('refuses a preset this build does not have, naming the ones it does', () => {
    expect(() => applyEditOps(post(), [{ op: 'addSticker', id: 's', emoji: '⭐', animation: { in: { id: 'teleport' } } }])).toThrow(/"animation\.in\.id" must be one of fade, pop/);
    expect(() => applyEditOps(post(), [{ op: 'addSticker', id: 's', emoji: '⭐', animation: { loop: { id: 'pop' } } }])).toThrow(/"animation\.loop\.id"/);
    expect(() => applyEditOps(post(), [{ op: 'addSticker', id: 's', emoji: '⭐', animation: 'pop' }])).toThrow(/"animation" must be an object/);
  });

  it('lists every preset with its default length in the catalogue', () => {
    const catalog = createTools().find(tool => tool.name === 'catalog_list')!;
    const result = catalog.run({ section: 'animations' });
    const text = result.content[0].text;
    expect(text).toContain('pop (470ms)');
    expect(text).toContain('heartbeat (1500ms)');
    const data = result.structuredContent!['animations'] as { in: { id: string }[] };
    expect(data.in.map(preset => preset.id)).toContain('stamp');
  });
});
