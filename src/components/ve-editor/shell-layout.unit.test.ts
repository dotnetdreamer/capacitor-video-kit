import { describe, expect, it } from 'vitest';

import { PANEL_LAYOUT, formatClock, shellLayout } from './shell-layout';

/**
 * Two things the shell gets wrong in silence.
 *
 * A panel in the wrong column is invisible until that sheet opens, and then the sheet takes the
 * screen and the video disappears; a clock that rounds to nearest reads a second ahead of the
 * playhead beside it, which is what makes a trim look off by one.
 */

describe('PANEL_LAYOUT', () => {
  it('leaves the video, the transport and a slim timeline on screen for twelve of the fifteen', () => {
    const compact = Object.entries(PANEL_LAYOUT)
      .filter(([, kind]) => kind === 'compact')
      .map(([panel]) => panel);
    expect(compact.sort()).toEqual(['adjust', 'crop', 'effects', 'filters', 'layout', 'opacity', 'quality', 'speed', 'transition', 'voiceover', 'volume', 'zoom'].sort());
  });

  it('gives the screen to the two with a keyboard or a scrolling grid in them', () => {
    expect(PANEL_LAYOUT.text).toBe('tall');
    expect(PANEL_LAYOUT.stickers).toBe('tall');
  });
});

describe('shellLayout', () => {
  it('is the whole editor when nothing is open', () => {
    expect(shellLayout(null)).toBe('main');
  });

  it('follows the open panel', () => {
    expect(shellLayout('filters')).toBe('compact');
    expect(shellLayout('stickers')).toBe('tall');
  });
});

describe('formatClock', () => {
  it('rounds down, so the label never claims a second that has not been reached', () => {
    expect(formatClock(6600)).toBe('00:06');
    expect(formatClock(6999)).toBe('00:06');
    expect(formatClock(7000)).toBe('00:07');
  });

  it('pads both halves and rolls over at a minute', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(59_999)).toBe('00:59');
    expect(formatClock(60_000)).toBe('01:00');
    expect(formatClock(605_000)).toBe('10:05');
  });

  it('reads a playhead that has gone negative as the start rather than as a negative clock', () => {
    expect(formatClock(-1)).toBe('00:00');
  });
});
