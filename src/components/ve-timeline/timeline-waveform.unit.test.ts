import { describe, expect, it } from 'vitest';

import type { Peaks } from '../../web-runtime/waveform';
import { WAVE_PITCH_PX, peakBetween, waveBars, wavePath, waveView, type WaveSource } from './timeline-waveform';

/*
 * A zoom at which the arithmetic is readable: 30 px a second makes one 3 px bar exactly 100 ms,
 * which is exactly one measurement of [WAVE]. So bar `k` shows measurement `k`, every expected
 * height below can be traced to a byte in the fixture, and an off-by-one has nowhere to hide.
 */
const PPS = 30;
/** Ten measurements: a ramp up and back down, starting and ending quiet. */
const WAVE: Peaks = {
  stepMs: 100,
  peaks: Uint8Array.of(0, 51, 102, 153, 204, 255, 204, 153, 102, 51),
  durationMs: 1000,
  max: 255,
};
/** One second of sound is 30 px at this zoom, which is ten bars. */
const ITEM_W = 30;

/** A sound that plays once, from the start of the timeline. */
const ONCE: WaveSource = {
  at: outputMs => (outputMs >= 0 && outputMs < 1000 ? outputMs : null),
  endsAtMs: 1000,
  repeat: null,
};

/** Bar heights as `wavePath` would draw them: `max(3, amp * 76)` of a 100-unit lane. */
function heights(over: Partial<Parameters<typeof waveBars>[0]> = {}): number[] {
  const built = waveBars({
    wave: WAVE,
    source: ONCE,
    pps: PPS,
    itemStartMs: 0,
    itemX: 0,
    itemW: ITEM_W,
    winLeft: -1000,
    winRight: 1000,
    ...over,
  });
  return (built?.bars ?? []).map(bar => Math.round(Math.max(3, bar.amp * 76) * 100) / 100);
}

describe('peakBetween', () => {
  it('takes the loudest measurement the span touches', () => {
    expect(peakBetween(WAVE, 0, 600)).toBe(255);
    expect(peakBetween(WAVE, 0, 300)).toBe(102);
  });

  it('does not count the measurement a span merely ends on', () => {
    // Bars are laid end to end, so one bar's end is the next one's start. Counting it would draw
    // every transient a bar wide on each side of where it actually happens.
    expect(peakBetween(WAVE, 0, 100)).toBe(0);
    expect(peakBetween(WAVE, 100, 200)).toBe(51);
    expect(peakBetween(WAVE, 500, 600)).toBe(255);
  });

  it('counts a measurement the span only partly covers', () => {
    expect(peakBetween(WAVE, 150, 250)).toBe(102);
  });

  it('reads the one measurement a span of no width stands on', () => {
    expect(peakBetween(WAVE, 500, 500)).toBe(255);
  });

  it('is silent past the end of what was measured', () => {
    expect(peakBetween(WAVE, 1000, 2000)).toBe(0);
    expect(peakBetween(WAVE, 5000, 5100)).toBe(0);
  });

  it('has nothing to report from an empty measurement', () => {
    expect(peakBetween({ stepMs: 100, peaks: new Uint8Array(0), durationMs: 0, max: 0 }, 0, 500)).toBe(0);
    expect(peakBetween({ ...WAVE, stepMs: 0 }, 0, 500)).toBe(0);
  });
});

describe('waveBars', () => {
  it('draws one bar per measurement, at this zoom', () => {
    expect(heights()).toEqual([3, 15.2, 30.4, 45.6, 60.8, 76, 60.8, 45.6, 30.4, 15.2]);
  });

  it('places bars on the item, one pitch apart', () => {
    const built = waveBars({ wave: WAVE, source: ONCE, pps: PPS, itemStartMs: 0, itemX: 0, itemW: ITEM_W, winLeft: -1000, winRight: 1000 });

    expect(built?.x).toBe(0);
    expect(built?.w).toBe(ITEM_W);
    expect(built?.bars.map(b => b.x)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27]);
    expect(WAVE_PITCH_PX).toBe(3);
  });

  it('draws a measured silence as a hairline, never as nothing', () => {
    // The first measurement is 0 and the bar is still drawn, 3 units tall. A bar that was simply
    // left out would read as a track that had not loaded yet.
    expect(heights()[0]).toBe(3);
  });

  it('builds only the bars inside the render window', () => {
    // The window is why this scales: at MAX_PPS a three-minute track is 57 600 px of item.
    const built = waveBars({ wave: WAVE, source: ONCE, pps: PPS, itemStartMs: 0, itemX: 0, itemW: ITEM_W, winLeft: 9, winRight: 21 });

    expect(built?.x).toBe(9);
    expect(built?.w).toBe(12);
    expect(built?.bars.length).toBe(4);
    // Still the same measurements: the window moves what is drawn, never what it means.
    expect(built?.bars.map(b => Math.round(b.amp * 255))).toEqual([153, 204, 255, 204]);
  });

  it('measures each bar against where the ITEM is, not where the window is', () => {
    // A sound scrolled halfway off the left of the screen still shows its own middle, not its start.
    const scrolled = waveBars({ wave: WAVE, source: ONCE, pps: PPS, itemStartMs: 0, itemX: 0, itemW: ITEM_W, winLeft: 15, winRight: 1000 });

    expect(scrolled?.x).toBe(15);
    expect(scrolled?.bars.map(b => Math.round(b.amp * 255))).toEqual([255, 204, 153, 102, 51]);
  });

  it('follows a sound that has been moved along the timeline', () => {
    // The item starts one second in, so bar 0 is still the start of the FILE.
    const source: WaveSource = { at: ms => (ms >= 1000 && ms < 2000 ? ms - 1000 : null), endsAtMs: 1000, repeat: null };
    const moved = heights({ source, itemStartMs: 1000, itemX: 30, itemW: ITEM_W });

    expect(moved).toEqual([3, 15.2, 30.4, 45.6, 60.8, 76, 60.8, 45.6, 30.4, 15.2]);
  });

  it('shows the trimmed part of a track when the sound starts partway in', () => {
    const source: WaveSource = { at: ms => (ms >= 0 && ms < 500 ? ms + 500 : null), endsAtMs: 1000, repeat: null };

    expect(heights({ source, itemW: 15 })).toEqual([76, 60.8, 45.6, 30.4, 15.2]);
  });

  it('repeats the picture when the track loops', () => {
    // A 300 ms section under a 900 ms bar: three passes of the same three measurements.
    const source: WaveSource = {
      at: ms => (ms >= 0 && ms < 900 ? ms % 300 : null),
      endsAtMs: 300,
      repeat: { fromMs: 0, toMs: 300 },
    };
    const drawn = heights({ source, itemW: 27 });

    expect(drawn).toEqual([3, 15.2, 30.4, 3, 15.2, 30.4, 3, 15.2, 30.4]);
  });

  it('hears both sides of the join when a bar straddles the loop seam', () => {
    // A 250 ms section: the seam falls in the middle of a bar, which must show the loudest of the
    // tail it ends on AND of the head it starts over into.
    const source: WaveSource = {
      at: ms => (ms >= 0 && ms < 500 ? ms % 250 : null),
      endsAtMs: 250,
      repeat: { fromMs: 0, toMs: 250 },
    };
    const built = waveBars({ wave: WAVE, source, pps: PPS, itemStartMs: 0, itemX: 0, itemW: 15, winLeft: -1000, winRight: 1000 });
    const bytes = (built?.bars ?? []).map(b => Math.round(b.amp * 255));

    // Bar 2 covers 200..300 ms of output: source 200..250, then 0..50 again. Measurement 2 (102)
    // against measurement 0 (0), so the tail it ends on wins.
    expect(bytes[2]).toBe(102);
    // Bar 4 covers 400..500: source 150..250, which is measurements 1 and 2.
    expect(bytes[4]).toBe(102);
  });

  it('shows the whole loop in a bar wider than the loop itself', () => {
    /*
     * Zoomed far out, one bar holds several passes of a short loop. At 5 px a second a bar covers
     * 600 ms, which is two passes of this 300 ms section - and its two edges both land on source
     * time 0. Reading only the edges would draw the loudest part of the track as silence.
     */
    const source: WaveSource = {
      at: ms => (ms >= 0 && ms < 1200 ? ms % 300 : null),
      endsAtMs: 300,
      repeat: { fromMs: 0, toMs: 300 },
    };
    const built = waveBars({ wave: WAVE, source, pps: 5, itemStartMs: 0, itemX: 0, itemW: 3, winLeft: -1000, winRight: 1000 });

    // Measurements 0, 1 and 2 of the fixture: 0, 51 and 102, so the bar is as tall as 102.
    expect(built?.bars.map(b => Math.round(b.amp * 255))).toEqual([102]);
  });

  it('draws nothing where the sound is not heard', () => {
    // A bar can be wider than its sound: MIN_ITEM_PX alone keeps a very short one 28 px across.
    const source: WaveSource = { at: ms => (ms >= 0 && ms < 300 ? ms : null), endsAtMs: 300, repeat: null };
    const built = waveBars({ wave: WAVE, source, pps: PPS, itemStartMs: 0, itemX: 0, itemW: ITEM_W, winLeft: -1000, winRight: 1000 });

    expect(built?.bars.length).toBe(3);
  });

  it('ends a trimmed track on the sound that is actually heard there', () => {
    /*
     * The last bar of a track has no source time for its right edge - the sound stops under it -
     * so it reads to the end of the TRIM. Reading to the end of the FILE instead, which is what
     * this did at first, ends every shortened track on a bar as tall as the loudest moment of the
     * part that was cut off: a three-minute song under a short post finishing on its chorus.
     */
    const source: WaveSource = {
      // Only the first 300 ms is heard, though the file goes on being measured to 1000 ms.
      at: ms => (ms >= 0 && ms < 300 ? ms : null),
      endsAtMs: 300,
      repeat: null,
    };
    const drawn = heights({ source, itemW: 9 });

    // Measurements 0, 1 and 2 - never 255, which is measurement 5, well past the trim.
    expect(drawn).toEqual([3, 15.2, 30.4]);
  });

  it('ends on the sound that is heard, not on the trim, when the post cuts a track short', () => {
    /*
     * The case a first pass at this got wrong. A track longer than the post is not trimmed - its
     * out-point is still way off at 1000 ms - it is simply cut off by the post ending. The last
     * bar has to read to where the POST stops it, which is what `endsAtMs` says; reading to the
     * out-point instead ends every long song on a bar as tall as its loudest moment.
     */
    const source: WaveSource = {
      at: ms => (ms >= 0 && ms < 300 ? ms : null),
      // Heard for 300 ms even though the trim runs to 1000 ms, where measurement 5 (255) lives.
      endsAtMs: 300,
      repeat: null,
    };

    expect(heights({ source, itemW: 9 })).toEqual([3, 15.2, 30.4]);
  });

  it('ends partway through the pass a repeating track was cut off in', () => {
    // 300 ms section, post stops 150 ms into the third pass: the final bar reads to source 150,
    // never on to the loud end of the section that is never reached.
    const source: WaveSource = {
      at: ms => (ms >= 0 && ms < 750 ? ms % 300 : null),
      endsAtMs: 150,
      repeat: { fromMs: 0, toMs: 300 },
    };
    const drawn = heights({ source, itemW: 24 });

    expect(drawn.length).toBe(8);
    // The last bar sits at output 700..750 -> source 100..150, which is measurement 1 (51).
    expect(drawn[7]).toBe(15.2);
  });

  it('starts the first bar exactly where the sound does', () => {
    /*
     * A bar's time used to be worked back out of `itemX - pad`, and the round trip lands an ulp
     * below `startMs` about a quarter of the time - which `at()` reads as "not heard yet", so the
     * leftmost 3 px vanished, and blinked in and out as the zoom changed.
     */
    for (const pps of [6, 17, 30, 64.3, 199.7, 320]) {
      for (const startMs of [0, 137, 4521, 19_988]) {
        const source: WaveSource = {
          at: ms => (ms >= startMs && ms < startMs + 1000 ? ms - startMs : null),
          endsAtMs: 1000,
          repeat: null,
        };
        const built = waveBars({ wave: WAVE, source, pps, itemStartMs: startMs, itemX: 195 + (startMs / 1000) * pps, itemW: 30, winLeft: -1e6, winRight: 1e6 });

        expect(built?.bars[0]?.x, `pps ${pps}, startMs ${startMs}`).toBe(0);
      }
    }
  });

  it('stops where the measurements stop rather than inventing any', () => {
    // A track whose length could not be read gets a bar longer than what was measured.
    const source: WaveSource = { at: ms => (ms >= 0 && ms < 2000 ? ms : null), endsAtMs: 2000, repeat: null };
    const drawn = heights({ source, itemW: 60 });

    expect(drawn.length).toBe(20);
    expect(drawn.slice(10)).toEqual(Array(10).fill(3));
  });

  it('turns a quiet track up, but only so far', () => {
    // Normalising is the point - a customer is reading beats, not levels - and the cap is what
    // stops a near-silent file becoming a wall of noise.
    const quiet: Peaks = { stepMs: 100, peaks: Uint8Array.of(8, 16, 32), durationMs: 300, max: 32 };
    const loud = waveBars({ wave: quiet, source: ONCE, pps: PPS, itemStartMs: 0, itemX: 0, itemW: 9, winLeft: -1000, winRight: 1000 });

    // 255/32 is just under the 8x cap, so the gain is the full 255/max and every bar is simply
    // its share of the loudest one.
    expect(loud?.bars.map(b => +b.amp.toFixed(3))).toEqual([0.25, 0.5, 1]);

    const veryQuiet: Peaks = { stepMs: 100, peaks: Uint8Array.of(2, 4), durationMs: 200, max: 4 };
    const lifted = waveBars({ wave: veryQuiet, source: ONCE, pps: PPS, itemStartMs: 0, itemX: 0, itemW: 6, winLeft: -1000, winRight: 1000 });

    // 255/4 would be 63.75; capped at 8 the file is allowed to keep looking quiet.
    expect(lifted?.bars.map(b => +b.amp.toFixed(3))).toEqual([0.063, 0.125]);
  });

  it('draws a silent track as a hairline all the way along', () => {
    const silent: Peaks = { stepMs: 100, peaks: Uint8Array.of(0, 0, 0), durationMs: 300, max: 0 };

    expect(heights({ wave: silent, itemW: 9 })).toEqual([3, 3, 3]);
  });

  it('has nothing to draw without measurements, width or zoom', () => {
    const empty: Peaks = { stepMs: 100, peaks: new Uint8Array(0), durationMs: 0, max: 0 };

    expect(waveBars({ wave: empty, source: ONCE, pps: PPS, itemStartMs: 0, itemX: 0, itemW: ITEM_W, winLeft: -1000, winRight: 1000 })).toBeNull();
    expect(waveBars({ wave: WAVE, source: ONCE, pps: 0, itemStartMs: 0, itemX: 0, itemW: ITEM_W, winLeft: -1000, winRight: 1000 })).toBeNull();
    expect(waveBars({ wave: WAVE, source: ONCE, pps: PPS, itemStartMs: 0, itemX: 0, itemW: 0, winLeft: -1000, winRight: 1000 })).toBeNull();
    // Scrolled clean past the item.
    expect(waveBars({ wave: WAVE, source: ONCE, pps: PPS, itemStartMs: 0, itemX: 0, itemW: ITEM_W, winLeft: 500, winRight: 900 })).toBeNull();
  });
});

describe('wavePath', () => {
  it('draws each bar centred on the lane, mirrored about the middle', () => {
    expect(wavePath([{ x: 0, amp: 1 }])).toBe('M0 12h2v76h-2z');
    expect(wavePath([{ x: 3, amp: 0.5 }])).toBe('M3 31h2v38h-2z');
  });

  it('floors a silent bar at a hairline rather than at nothing', () => {
    expect(wavePath([{ x: 0, amp: 0 }])).toBe('M0 48.5h2v3h-2z');
  });

  it('is one path for every bar, so a repaint is one attribute', () => {
    const d = wavePath([
      { x: 0, amp: 1 },
      { x: 3, amp: 0 },
      { x: 6, amp: 0.5 },
    ]);

    expect((d.match(/M/g) ?? []).length).toBe(3);
  });

  it('has nothing to say about no bars', () => {
    expect(wavePath([])).toBe('');
  });
});

describe('waveView', () => {
  it('is the slice and its path together', () => {
    const view = waveView({ wave: WAVE, source: ONCE, pps: PPS, itemStartMs: 0, itemX: 0, itemW: ITEM_W, winLeft: -1000, winRight: 1000 });

    expect(view?.x).toBe(0);
    expect(view?.w).toBe(ITEM_W);
    expect((view?.d.match(/M/g) ?? []).length).toBe(10);
  });

  it('is null whenever there are no bars to draw', () => {
    expect(waveView({ wave: WAVE, source: ONCE, pps: 0, itemStartMs: 0, itemX: 0, itemW: ITEM_W, winLeft: -1000, winRight: 1000 })).toBeNull();
  });
});
