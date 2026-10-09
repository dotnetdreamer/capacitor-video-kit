import type { EditorStore } from '../../state/editor-store';

/**
 * A sheet pulled up by its grabber: the Sound sheet opens at the height every tall sheet has, and a
 * drag of its head takes it up to most of the column, back down, or off the screen.
 *
 * The two heights are the stylesheet's, never numbers in here. `.ve__sheet--tall` is the one a
 * sheet opens at and `.ve__sheet--expanded` the pulled up one, with `.ve--expanded` giving the stage
 * the little it keeps under it. Both are MEASURED when a drag starts, by putting the other pair of
 * classes on for one synchronous layout and taking them off again, so the place a sheet settles is
 * always exactly where the stylesheet then puts it.
 */

/** On the open sheet's slot while it is pulled up. */
export const EXPANDED_SHEET = 've__sheet--expanded';
/** On the column while a sheet in it is pulled up. */
export const EXPANDED_COLUMN = 've--expanded';

/** A tall sheet's two heights in the column it is in, in CSS pixels. */
export interface SheetHeights {
  readonly rest: number;
  readonly expanded: number;
}

/** Where a sheet that was let go goes. */
export type SheetDetent = 'closed' | 'rest' | 'expanded';

/**
 * How far a release is carried by the speed it had: as far as this many milliseconds more of it
 * would take the sheet. It is what lets a flick close a sheet that was only moved a little.
 */
const FLING_MS = 160;

/** Let go below this share of its resting height, a sheet closes. */
const CLOSE_SHARE = 0.6;

/**
 * How much of a pull past the expanded height the sheet follows. Some, so the finger is told it has
 * reached the end rather than met a wall, and not much, because it goes straight back.
 */
const OVERPULL = 0.25;

/** How long a let go sheet takes to reach where it settles. */
export const SETTLE_MS = 260;

/** iOS's own sheet curve, near enough: quick off the mark and a long, soft landing. */
const SETTLE_EASE = 'cubic-bezier(0.2, 0.9, 0.3, 1)';

/**
 * The sheet's height under a finger that has moved `dy` from where it took the sheet at `start`
 * tall. Down is positive, so a drag up grows it. Past the expanded height it follows only a quarter
 * of the pull, and it never goes below nothing or above the whole column.
 */
export function dragHeight(start: number, dy: number, heights: SheetHeights, column: number): number {
  const raw = start - dy;
  if (raw <= heights.expanded) return Math.max(0, raw);
  return Math.min(Math.max(column, heights.expanded), heights.expanded + (raw - heights.expanded) * OVERPULL);
}

/**
 * Where a sheet let go at `height` settles, moving at `velocity` (CSS pixels a millisecond, down is
 * positive). Decided on where it was heading rather than where it is, so a flick up from the resting
 * height expands it and a flick down closes it, without either having to be dragged most of the way.
 */
export function settleSheet(height: number, velocity: number, heights: SheetHeights): SheetDetent {
  const heading = height - velocity * FLING_MS;
  if (heading < heights.rest * CLOSE_SHARE) return 'closed';
  return heading > (heights.rest + heights.expanded) / 2 ? 'expanded' : 'rest';
}

/** What the shell hands over: its column, and the slot of the sheet that is open in it, if any. */
export interface SheetSlot {
  readonly column: HTMLElement;
  readonly sheet: HTMLElement;
}

/**
 * Moves the open sheet under the finger and settles it where it was let go.
 *
 * While a finger has it the slot keeps the height it was laid out at, and the sheet grows over the
 * stage, or shrinks off it, with a negative or positive top margin that keeps its outer height the
 * same. So the stage is never laid out again under a moving finger: a new stage size resizes the
 * preview's compositor, which is a canvas reallocated on every frame of a drag on a cheap phone.
 * Only where the sheet settles is laid out, once, when `store.sheetExpanded` flips the classes.
 *
 * Everything it writes is an inline style on the slot, and it takes all of it off once the sheet
 * has settled. The classes are the vdom's, so it only ever toggles them for a measurement inside
 * one synchronous turn, which no repaint and no `ResizeObserver` ever sees.
 */
export class SheetDragger {
  /** The slot being moved, while a finger has it or it is settling. */
  private sheet: HTMLElement | null = null;
  /** The slot's laid out height while it is held, which the margin keeps it at. */
  private outer = 0;
  /** The sheet's height when the finger took it. */
  private start = 0;
  /** The sheet's height now. */
  private height = 0;
  private heights: SheetHeights = { rest: 0, expanded: 0 };
  /** The column's height inside its top inset: the most a sheet could ever be. */
  private column = 0;

  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private settleListener: ((event: TransitionEvent) => void) | null = null;

  /** Takes the inline styles off once the class that holds the new height is on. See [rendered]. */
  private landing: (() => void) | null = null;

  constructor(
    private readonly store: EditorStore,
    private readonly slot: () => SheetSlot | null,
  ) {}

  /** A finger has the sheet. A sheet still settling is caught where it is. */
  begin(): void {
    const slot = this.slot();
    if (!slot) return;
    const caught = this.sheet === slot.sheet && this.settleTimer !== null ? slot.sheet.getBoundingClientRect().height : null;
    this.stopSettling();
    this.landing = null;

    const { column, sheet } = slot;
    clearInline(sheet);
    this.sheet = sheet;
    this.measure(column, sheet);
    this.start = caught ?? this.outer;
    this.apply(this.start);
  }

  /** The finger is `dy` from where it went down. */
  move(dy: number): void {
    if (!this.held()) return;
    this.apply(dragHeight(this.start, dy, this.heights, this.column));
  }

  /** The finger lifted, moving at `velocity`. */
  end(velocity: number): void {
    if (!this.held()) return;
    this.settle(settleSheet(this.height, velocity, this.heights));
  }

  /** The browser took the touch back: the sheet goes back to where it was. */
  cancel(): void {
    if (!this.held()) return;
    this.settle(this.store.sheetExpanded.value ? 'expanded' : 'rest');
  }

  /** The grabber pressed, by a tap, a click or a key: the other height, the same way a drag gets there. */
  toggle(): void {
    const to = this.store.sheetExpanded.value ? 'rest' : 'expanded';
    this.begin();
    if (this.held()) this.settle(to);
  }

  /** Called after every render of the shell, which is when a flipped class has reached the slot. */
  rendered(): void {
    const landing = this.landing;
    this.landing = null;
    landing?.();
  }

  /** The editor is going. Nothing is left running behind it. */
  dispose(): void {
    this.stopSettling();
    this.landing = null;
    this.sheet = null;
  }

  /* ----------------------------------------------------------------------------------------- */

  /**
   * Whether there is a sheet in hand that is still on the screen. The back button or the tick can
   * close a sheet under a finger, and what is left of the drag then has nothing to move.
   */
  private held(): boolean {
    if (this.sheet?.isConnected) return true;
    this.dispose();
    return false;
  }

  /**
   * Both heights, read off the stylesheet: the slot as it is, then with the other pair of classes,
   * and back. One forced layout, in one turn, so neither the screen nor an observer sees the other
   * arrangement.
   */
  private measure(column: HTMLElement, sheet: HTMLElement): void {
    const expanded = this.store.sheetExpanded.value;
    const here = sheet.getBoundingClientRect().height;
    arrange(column, sheet, !expanded);
    const there = sheet.getBoundingClientRect().height;
    arrange(column, sheet, expanded);

    this.outer = here;
    this.heights = expanded ? { rest: there, expanded: here } : { rest: here, expanded: there };
    this.column = column.clientHeight - (parseFloat(getComputedStyle(column).paddingTop) || 0);
  }

  /** The sheet at `height`, grown over the stage or shrunk off it, its slot unmoved. */
  private apply(height: number): void {
    const sheet = this.sheet!;
    this.height = height;
    const style = sheet.style;
    // Above the stage, which is a positioned box earlier in the column and would paint over it.
    style.position = 'relative';
    style.zIndex = '2';
    // The stylesheet's caps are for the resting height and would hold a pulled sheet to it.
    style.minHeight = '0';
    style.maxHeight = 'none';
    style.height = `${height}px`;
    style.marginTop = `${this.outer - height}px`;
  }

  /** Runs the sheet to where it settles, then hands it to the stylesheet or closes it. */
  private settle(to: SheetDetent): void {
    const sheet = this.sheet!;
    const target = to === 'closed' ? 0 : this.heights[to];
    const done = () => this.finish(to);

    if (Math.abs(target - this.height) < 1 || reducedMotion()) {
      done();
      return;
    }

    // The start has to be a computed value before the transition is, or a sheet that was never
    // dragged - the grabber tapped - would run from the stylesheet's percentage instead.
    void sheet.offsetHeight;
    sheet.style.transition = `height ${SETTLE_MS}ms ${SETTLE_EASE}, margin-top ${SETTLE_MS}ms ${SETTLE_EASE}`;
    this.apply(target);

    const listener = (event: TransitionEvent) => {
      if (event.target === sheet && event.propertyName === 'height') done();
    };
    this.settleListener = listener;
    sheet.addEventListener('transitionend', listener);
    // A transition can end without saying so: an element hidden or taken out partway, or a value
    // the browser decided had not changed. The sheet must not be left held.
    this.settleTimer = setTimeout(done, SETTLE_MS + 100);
  }

  private finish(to: SheetDetent): void {
    const sheet = this.sheet;
    this.stopSettling();
    this.sheet = null;
    if (!sheet?.isConnected) return;

    if (to === 'closed') {
      // Off the screen already; the store takes the element away with the panel.
      this.store.closePanel();
      return;
    }
    const expanded = to === 'expanded';
    if (this.store.sheetExpanded.value === expanded) {
      clearInline(sheet);
      return;
    }
    // The class that holds the new height lands with the next render, and the inline height has to
    // stay until it has: taken off now, the sheet would flash at the other height for a frame.
    this.landing = () => clearInline(sheet);
    this.store.sheetExpanded.value = expanded;
  }

  private stopSettling(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.sheet && this.settleListener) this.sheet.removeEventListener('transitionend', this.settleListener);
    this.settleListener = null;
    if (this.sheet) this.sheet.style.transition = '';
  }
}

/** The column and the slot as the stylesheet has them for a sheet at rest, or pulled up. */
function arrange(column: HTMLElement, sheet: HTMLElement, expanded: boolean): void {
  column.classList.toggle(EXPANDED_COLUMN, expanded);
  sheet.classList.toggle(EXPANDED_SHEET, expanded);
}

function clearInline(sheet: HTMLElement): void {
  for (const property of ['position', 'z-index', 'min-height', 'max-height', 'height', 'margin-top', 'transition']) {
    sheet.style.removeProperty(property);
  }
}

/** A customer who asked for less motion gets the sheet where it was going, at once. */
function reducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}
