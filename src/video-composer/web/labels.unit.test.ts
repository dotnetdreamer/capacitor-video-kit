import { describe, expect, it } from 'vitest';

import { AT_ONCE, LOOK_BUDGET_MS, planTimes, Turns } from './labels';

/* The phones' pace, kept in a browser: two looks at a time, 8 s on a video. */
describe('the pace of looking', () => {
  it('is the pace the phones keep: two at a time, and 8 s a video', () => {
    expect(AT_ONCE).toBe(2);
    expect(LOOK_BUDGET_MS).toBe(8_000);
  });

  it('runs two at once and starts the third only when one is done, first come first served', async () => {
    const turns = new Turns(2);
    const started: string[] = [];
    const take = (name: string) => turns.take().then(() => started.push(name));
    const first = take('a');
    const second = take('b');
    const third = take('c');
    const fourth = take('d');
    await Promise.all([first, second]);
    await Promise.resolve();
    expect(started).toEqual(['a', 'b']);

    turns.done();
    await third;
    expect(started).toEqual(['a', 'b', 'c']);

    // A call made the moment a turn is handed on waits behind the one that was already waiting.
    turns.done();
    const late = take('e');
    await fourth;
    await Promise.resolve();
    expect(started).toEqual(['a', 'b', 'c', 'd']);
    turns.done();
    await late;
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

/* Which frames of a clip a browser looks at: the phones' plan, number for number. */
describe('planTimes', () => {
  it('spreads the frames through the clip, each at the middle of its own share', () => {
    expect(planTimes(10_000, undefined, 5)).toEqual([1000, 3000, 5000, 7000, 9000]);
    expect(planTimes(8_000, [], 1)).toEqual([4000]);
  });

  it('takes the times asked for instead, whole milliseconds, in order and each once, inside the clip', () => {
    expect(planTimes(5_000, [4200.4, 1000, 1000, -3, Number.NaN, 9000], 5)).toEqual([0, 1000, 4200, 5000]);
  });

  it('keeps the times asked for as they are when the length is unknown', () => {
    expect(planTimes(0, [2500, 500], 5)).toEqual([500, 2500]);
  });
});
