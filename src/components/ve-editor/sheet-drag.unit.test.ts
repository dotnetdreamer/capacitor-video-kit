import { describe, expect, it } from 'vitest';

import { dragHeight, settleSheet, type SheetHeights } from './sheet-drag';
import { canExpand } from './shell-layout';

/**
 * The two numbers a drag of the Sound sheet comes down to: how tall the sheet is under the finger,
 * and where it goes when the finger lets go. The heights are an iPhone 17 Pro's: a column of 815
 * under its status bar, the 340 every tall sheet rests at, and 90% of the column pulled up.
 */
const PHONE: SheetHeights = { rest: 340, expanded: 733.5 };
const COLUMN = 815;

describe('dragHeight', () => {
  it('follows the finger between nothing and the expanded height, up growing it', () => {
    expect(dragHeight(340, 0, PHONE, COLUMN)).toBe(340);
    expect(dragHeight(340, -100, PHONE, COLUMN)).toBe(440);
    expect(dragHeight(340, 120, PHONE, COLUMN)).toBe(220);
    expect(dragHeight(733.5, 200, PHONE, COLUMN)).toBe(533.5);
  });

  it('never goes below nothing', () => {
    expect(dragHeight(340, 500, PHONE, COLUMN)).toBe(0);
  });

  it('gives a pull past the expanded height a quarter of the way, and stops at the column', () => {
    expect(dragHeight(733.5, -40, PHONE, COLUMN)).toBe(743.5);
    expect(dragHeight(340, -2000, PHONE, COLUMN)).toBe(COLUMN);
  });
});

describe('settleSheet', () => {
  it('stays at rest for a small slow drag either way', () => {
    expect(settleSheet(380, 0, PHONE)).toBe('rest');
    expect(settleSheet(300, 0, PHONE)).toBe('rest');
  });

  it('expands once the sheet is let go past halfway, or flicked up from rest', () => {
    expect(settleSheet(560, 0, PHONE)).toBe('expanded');
    // 40 up at a brisk pace is heading well past halfway.
    expect(settleSheet(380, -1.5, PHONE)).toBe('expanded');
  });

  it('goes back to rest from expanded on a flick down, and closes on a long pull down', () => {
    expect(settleSheet(700, 1.5, PHONE)).toBe('rest');
    expect(settleSheet(150, 0, PHONE)).toBe('closed');
  });

  it('closes on a flick down that only moved it a little', () => {
    expect(settleSheet(300, 1.5, PHONE)).toBe('closed');
  });

  it('holds a sheet that stopped before it was let go to where it is, not where it was going', () => {
    expect(settleSheet(300, 0, PHONE)).toBe('rest');
  });
});

describe('canExpand', () => {
  it('lets only the Sound sheet be pulled up', () => {
    expect(canExpand('sound')).toBe(true);
    expect(canExpand('stickers')).toBe(false);
    expect(canExpand('text')).toBe(false);
    expect(canExpand('filters')).toBe(false);
    expect(canExpand(null)).toBe(false);
  });
});
