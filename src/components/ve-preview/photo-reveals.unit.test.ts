import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PHOTO_REVEAL_MS, PhotoReveals } from './photo-reveals';

/*
 * A photo's cutout landing on screen: what starts its reveal - the photo's bitmap changing while the
 * store says the cutout is being revealed - and what does not.
 */
describe('PhotoReveals', () => {
  let asked: Map<string, number>;
  let reveals: PhotoReveals;
  const photo = (png: string, width = 40) => ({ id: 'p', effect: false, png, width, aspect: '1 / 1' });

  beforeEach(() => {
    vi.useFakeTimers();
    asked = new Map();
    reveals = new PhotoReveals(() => asked);
  });

  afterEach(() => {
    reveals.destroy();
    vi.useRealTimers();
  });

  it('keeps the photo as it was over the cut-out one when its bitmap changes under a reveal, then lets it go', () => {
    reveals.update([photo('whole', 40)]);
    asked.set('p', performance.now());
    reveals.update([photo('cut', 30)]);
    expect(reveals.ghosts.value.get('p')).toEqual({ png: 'whole', width: 40, aspect: '1 / 1' });

    vi.advanceTimersByTime(PHOTO_REVEAL_MS);
    expect(reveals.ghosts.value.size).toBe(0);
  });

  it('plays one reveal once, however many times its bitmap is drawn', () => {
    reveals.update([photo('whole')]);
    asked.set('p', performance.now());
    reveals.update([photo('cut')]);
    vi.advanceTimersByTime(PHOTO_REVEAL_MS);
    reveals.update([photo('cut, drawn again')]);
    expect(reveals.ghosts.value.size).toBe(0);
  });

  it('starts nothing for a bitmap that changes with no reveal asked for, or long after one', () => {
    reveals.update([photo('one')]);
    reveals.update([photo('two')]);
    expect(reveals.ghosts.value.size).toBe(0);

    asked.set('p', performance.now() - 5000);
    reveals.update([photo('three')]);
    expect(reveals.ghosts.value.size).toBe(0);
  });

  it('starts nothing for a layer that has just come on screen, or for an effect', () => {
    asked.set('p', performance.now());
    reveals.update([photo('first')]);
    expect(reveals.ghosts.value.size).toBe(0);

    asked.set('fx', performance.now());
    reveals.update([{ id: 'fx', effect: true, png: 'grain', width: 100, aspect: 'auto' }]);
    reveals.update([{ id: 'fx', effect: true, png: 'grain, again', width: 100, aspect: 'auto' }]);
    expect(reveals.ghosts.value.size).toBe(0);
  });
});
