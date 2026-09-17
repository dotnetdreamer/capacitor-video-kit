import { effect, signal } from '@preact/signals-core';
import { describe, expect, it, vi } from 'vitest';

import { computedWith } from './computed-with';

interface Box {
  x: number;
  y: number;
}

const sameBox = (a: Box, b: Box): boolean => a.x === b.x && a.y === b.y;

describe('computedWith', () => {
  it('hands back the previous object when the comparator says nothing changed', () => {
    const at = signal(0);
    const box = computedWith<Box>(() => ({ x: 1, y: at.value * 0 }), sameBox);

    const first = box.value;
    at.value = 1;
    expect(box.value).toBe(first);
  });

  it('wakes a dependent exactly once for a real change, and not at all for an equal one', () => {
    const at = signal(0);
    const box = computedWith<Box>(() => ({ x: Math.floor(at.value / 100), y: 0 }), sameBox);
    const repaint = vi.fn();
    const stop = effect(() => {
      box.value;
      repaint();
    });
    repaint.mockClear();

    // The playhead moving thirty times a second is exactly this shape: a new object every write,
    // meaning the same thing every time until it does not.
    for (let ms = 1; ms < 100; ms++) at.value = ms;
    expect(repaint).not.toHaveBeenCalled();

    at.value = 100;
    expect(repaint).toHaveBeenCalledTimes(1);

    stop();
  });

  it('still runs its body when a dependency changes, and only keeps the answer', () => {
    const at = signal(0);
    const body = vi.fn(() => ({ x: Math.floor(at.value / 100), y: 0 }));
    const box = computedWith<Box>(body, sameBox);

    const first = box.value;
    at.value = 1;
    // The comparison is the point of the shim, not an escape from the work: the body runs again,
    // and what it saves is everything downstream of the answer.
    expect(box.value).toBe(first);
    expect(body).toHaveBeenCalledTimes(2);
  });

  it('keeps a comparator that is never equal behaving like a plain computed', () => {
    const at = signal(0);
    const box = computedWith<Box>(() => ({ x: at.value, y: 0 }), () => false);

    const first = box.value;
    at.value = 1;
    expect(box.value).not.toBe(first);
    expect(box.value.x).toBe(1);
  });
});
