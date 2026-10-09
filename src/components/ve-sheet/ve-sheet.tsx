import { Component, Element, Event, type EventEmitter, Host, Method, Prop } from '@stencil/core';

import type { SheetDrag, SheetTab } from '../sheet.types';

/**
 * How far a finger on the head travels up or down before it is dragging the sheet rather than
 * tapping a tab. A tap that wobbles a few pixels is still a tap.
 */
const DRAG_SLOP_PX = 8;

/** The last stretch of a drag its release speed is read over: the flick, not the whole drag. */
const VELOCITY_WINDOW_MS = 80;

/** A finger, or a mouse button, down on the grabber or the head. */
interface HeadPress {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  /** Past [DRAG_SLOP_PX] up or down, and so reported as a drag. */
  dragging: boolean;
  /** Where it has been recently, for the speed it lifts at. */
  readonly trail: { y: number; t: number }[];
}

/**
 * The frame every editor sheet sits in, so that all twelve read as one thing: TikTok's bottom sheet,
 * an optional search field, then a row of "none" / tabs / tick, then the sheet's own content.
 *
 * It only draws the chrome. What "none", a tab or the tick mean is the host sheet's business, told
 * through the events.
 *
 * It takes no `ctx`. Nothing here reads a signal or writes one, and a required prop that is never
 * read would cost all twelve sheets a line each to hand over a store this element has no question to
 * ask of. A sheet still takes its own `ctx`; it just does not pass it in here.
 *
 * Three of its methods exist because the sheets inside it cannot reach into this shadow root:
 * `bodyElement` and `scrollBodyTo` for the two sheets whose content is one long scroller, and
 * `blurSearch` for the one that has to drop the keyboard before it closes.
 *
 * A sheet that can be pulled up turns on `grabber`: a handle over the head, and the head and the
 * handle both drag the sheet. The frame reports the finger (`veSheetDrag`) and a press on the handle
 * (`veSheetToggle`), and the shell, which knows the column, decides the height. Both events bubble
 * out of the sheet to it.
 */
@Component({
  tag: 've-sheet',
  /*
   * The tab strip comes from the shared file rather than from here, because the text sheet draws a
   * second strip of its own. Order matters only for reading: the two files declare no property
   * twice, so nothing in either one depends on which is applied last.
   */
  styleUrls: ['../sheet-common.css', 've-sheet.css'],
  shadow: true,
})
export class VeSheet {
  /** The tabs across the head, left to right. No tabs is the usual case and draws no strip. */
  @Prop() tabs: readonly SheetTab[] = [];

  /** Which tab is underlined, by `id`. Null underlines none, which is how a search result list reads. */
  @Prop() activeTab: string | null = null;

  /**
   * The sheet's name, at the left of the head.
   *
   * Not `title`, which is what the Angular component called it: an element with a `title` attribute
   * grows a browser tooltip, and the generated `HTMLVeSheetElement` would be redeclaring
   * `HTMLElement.title` with a type that does not match it.
   */
  @Prop() heading: string | null = null;

  /** Shows the "none" button, which the sheet answers by clearing whatever it applies. */
  @Prop() showNone = false;

  /**
   * What a screen reader calls the "none" button. Two sheets clear a setting rather than remove a
   * thing, and "None" tells a screen reader nothing about what will happen on those.
   *
   * This is a prop because the Angular sheets could not make it one: they waited a frame and rewrote
   * the rendered button's attribute by hand, through a `querySelector` that now returns null from
   * outside a shadow root.
   */
  @Prop() noneLabel = 'None';

  /** Shows the tick that closes the sheet. Only the text sheet, which has nothing to confirm, hides it. */
  @Prop() showConfirm = true;

  /** Shows the search row when set, with this as the field's placeholder. */
  @Prop() searchPlaceholder: string | null = null;

  /** What is in the search field. The sheet owns the text and hands it back, so it can clear it. */
  @Prop() searchValue = '';

  /**
   * Draws a grabber over the head and lets the head and the grabber drag the sheet, reported as
   * `veSheetDrag`. A press on the grabber that is not a drag is `veSheetToggle`.
   */
  @Prop() grabber = false;

  /** The sheet is pulled up, which is what the grabber offers to undo. Only its name reads this. */
  @Prop() expanded = false;

  /** A tab was pressed, carrying its `id`. */
  @Event() veTab!: EventEmitter<string>;

  /** The "none" button was pressed. */
  @Event() veNone!: EventEmitter<void>;

  /** The tick was pressed. */
  @Event() veConfirm!: EventEmitter<void>;

  /** The search text changed, carrying the field's whole value. */
  @Event() veSearch!: EventEmitter<string>;

  /** The sheet is being dragged by its grabber or its head; see [SheetDrag]. */
  @Event() veSheetDrag!: EventEmitter<SheetDrag>;

  /** The grabber was pressed without being dragged: tapped, clicked, or pressed from the keyboard. */
  @Event() veSheetToggle!: EventEmitter<void>;

  @Element() el!: HTMLElement;

  private body?: HTMLElement;
  private search?: HTMLInputElement;
  private tabStrip?: HTMLElement;
  /** The tab last scrolled into view, so a repaint that changed nothing about it scrolls nothing. */
  private shownTab: string | null | undefined = undefined;
  private press: HeadPress | null = null;
  /** Until when a click is a drag's own leftover and not a press; see [swallowClick]. */
  private clickGuardUntil = 0;

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed value to
   * the vdom, and a ref that changes identity runs again on every repaint.
   */
  private readonly keepBody = (el?: HTMLElement) => {
    this.body = el;
  };

  private readonly keepSearch = (el?: HTMLInputElement) => {
    this.search = el;
  };

  private readonly keepTabStrip = (el?: HTMLElement) => {
    this.tabStrip = el;
  };

  private readonly emitNone = () => this.veNone.emit();

  private readonly emitConfirm = () => this.veConfirm.emit();

  private readonly onSearchInput = (event: Event) => {
    this.veSearch.emit((event.target as HTMLInputElement).value);
  };

  /* ========================================================================================= */
  /* The grabber                                                                               */
  /* ========================================================================================= */

  connectedCallback() {
    this.el.addEventListener('click', this.swallowClick, true);
  }

  disconnectedCallback() {
    this.el.removeEventListener('click', this.swallowClick, true);
    this.endPress();
  }

  private readonly onGrab = () => this.veSheetToggle.emit();

  /**
   * A finger down on the grabber or the head. Nothing is reported yet: it is a tap on a tab until it
   * has moved [DRAG_SLOP_PX] up or down, and the tab strip's own scroll if it goes sideways first.
   *
   * What follows is listened for on the window, not on this element. A touch is captured to where it
   * went down, so its moves would arrive here anyway, but a mouse is captured by nothing until it is
   * a drag, and its first move is often already off the head, over the video, where this element
   * would never hear it.
   */
  private readonly onPressDown = (event: PointerEvent) => {
    if (!this.grabber || this.press || !event.isPrimary || event.button !== 0) return;
    this.press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false, trail: [{ y: event.clientY, t: event.timeStamp }] };
    window.addEventListener('pointermove', this.onPressMove);
    window.addEventListener('pointerup', this.onPressUp);
    window.addEventListener('pointercancel', this.onPressCancel);
  };

  private readonly onPressMove = (event: PointerEvent) => {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    const dy = event.clientY - press.y;
    if (!press.dragging) {
      const dx = event.clientX - press.x;
      if (Math.abs(dx) >= DRAG_SLOP_PX && Math.abs(dx) >= Math.abs(dy)) {
        this.endPress();
        return;
      }
      if (Math.abs(dy) < DRAG_SLOP_PX) return;
      press.dragging = true;
      this.capture(press.pointerId);
      this.veSheetDrag.emit({ phase: 'start', dy, velocity: 0 });
    }
    follow(press.trail, event.clientY, event.timeStamp);
    this.veSheetDrag.emit({ phase: 'move', dy, velocity: speed(press.trail) });
  };

  private readonly onPressUp = (event: PointerEvent) => {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    this.endPress();
    if (!press.dragging) return;
    follow(press.trail, event.clientY, event.timeStamp);
    this.release(press.pointerId);
    this.clickGuardUntil = performance.now() + 400;
    this.veSheetDrag.emit({ phase: 'end', dy: event.clientY - press.y, velocity: speed(press.trail) });
  };

  private readonly onPressCancel = (event: PointerEvent) => {
    const press = this.press;
    if (!press || event.pointerId !== press.pointerId) return;
    this.endPress();
    if (!press.dragging) return;
    this.release(press.pointerId);
    this.veSheetDrag.emit({ phase: 'cancel', dy: event.clientY - press.y, velocity: 0 });
  };

  private endPress(): void {
    this.press = null;
    window.removeEventListener('pointermove', this.onPressMove);
    window.removeEventListener('pointerup', this.onPressUp);
    window.removeEventListener('pointercancel', this.onPressCancel);
  }

  /**
   * Keeps the pointer once it is a drag: a mouse that leaves the window still moves the sheet and
   * still lets go of it, and the click a drag leaves behind lands on this element rather than on
   * whatever it ended over. Allowed to fail, as [VeSlider]'s is: a pointer that is already up, or a
   * synthetic one in a test, is still a drag, followed on the window.
   */
  private capture(pointerId: number): void {
    try {
      this.el.setPointerCapture(pointerId);
    } catch {
      /* Uncaptured, and still a drag. */
    }
  }

  private release(pointerId: number): void {
    try {
      if (this.el.hasPointerCapture(pointerId)) this.el.releasePointerCapture(pointerId);
    } catch {
      /* Never captured. */
    }
  }

  /**
   * The click a drag can leave behind. A drag that lifts over a tab or the tick is not a press of
   * either, so for a moment after one ends the next click is stopped here, on its way down to them.
   */
  private readonly swallowClick = (event: Event) => {
    if (performance.now() >= this.clickGuardUntil) return;
    this.clickGuardUntil = 0;
    event.stopPropagation();
    event.preventDefault();
  };

  /**
   * The element that scrolls, for a sheet that has to measure inside it: the sticker sheet's section
   * jumps and both sheets' `IntersectionObserver` roots are questions about this box, and it is in a
   * shadow root the sheet cannot query.
   *
   * Null until the first render. A Stencil method call waits for the component's instance, not for
   * its first paint, and in the custom elements build it does not wait at all, so a caller reaching
   * for this from its own `componentWillLoad` gets nothing. Both sheets that use it already treat a
   * missing scroller as "not yet", which is the same answer.
   */
  @Method()
  async bodyElement(): Promise<HTMLElement | null> {
    return this.body ?? null;
  }

  /**
   * Scrolls the body, and keeps in one place the feature test both callers would otherwise repeat.
   *
   * `scrollTo` and never `scrollIntoView`: the latter scrolls every scrollable ancestor as well,
   * including the `overflow: hidden` ones, which drags the whole editor column off its layout.
   */
  @Method()
  async scrollBodyTo(top: number, behavior: ScrollBehavior = 'auto'): Promise<void> {
    const body = this.body;
    if (!body) return;
    // A WebView old enough to have no smooth scrolling does not understand the options form of
    // `scrollTo` either, and answers one with a silence that reads exactly like a jump to nowhere.
    if ('scrollBehavior' in document.documentElement.style) {
      body.scrollTo({ top, behavior });
    } else {
      body.scrollTop = top;
    }
  }

  /**
   * Takes the focus off the search field, which is what closes the keyboard before a sheet
   * disappears from under it.
   *
   * The sheets used to blur whatever `document.activeElement` named. From outside a shadow root that
   * is the outermost host rather than the field, and blurring a host in the focus chain does drop
   * the keyboard - along with the focus on everything else in the editor. The field is in here, so
   * the question is answered in here.
   */
  @Method()
  async blurSearch(): Promise<void> {
    this.search?.blur();
  }

  /**
   * Keeps the underlined tab in sight. The strip scrolls sideways, so the tab a sheet opens on, or
   * the half-hidden one at its edge that somebody taps, can sit partly behind the tick; it is
   * brought wholly into view, at once on the first paint and smoothly after that.
   */
  componentDidRender() {
    if (this.activeTab === this.shownTab) return;
    const first = this.shownTab === undefined;
    this.shownTab = this.activeTab;
    const strip = this.tabStrip;
    const tab = strip?.querySelector<HTMLElement>('.sheet__tab--on');
    if (!strip || !tab) return;
    const s = strip.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    // A little past the edge, so the next tab's first letters show there is more to scroll to.
    const margin = 24;
    const by = t.left < s.left ? t.left - s.left - margin : t.right > s.right ? t.right - s.right + margin : 0;
    if (!by) return;
    // `scrollTo` on the strip alone, never `scrollIntoView`, for the reason [scrollBodyTo] gives.
    if ('scrollBehavior' in document.documentElement.style) {
      strip.scrollTo({ left: strip.scrollLeft + by, behavior: first ? 'auto' : 'smooth' });
    } else {
      strip.scrollLeft += by;
    }
  }

  private confirmButton() {
    return (
      <button type="button" class="sheet__icon-btn" aria-label="Done" onClick={this.emitConfirm} key="confirm">
        <ve-icon name="checkmark"></ve-icon>
      </button>
    );
  }

  render() {
    const placeholder = this.searchPlaceholder;
    const hasTabs = this.tabs.length > 0;
    // The tick belongs to the search row whenever there is one, so a sheet with both rows shows one
    // tick rather than two.
    const headConfirm = this.showConfirm && !placeholder;
    const showHead = hasTabs || this.showNone || headConfirm || !!this.heading;

    return (
      <Host>
        {/*
          A button, so the grabber is something a screen reader and a keyboard can press too: neither
          can drag. Named for what pressing it does next.
        */}
        {this.grabber ? (
          <button type="button" class="sheet__grab" key="grab" aria-label={this.expanded ? 'Collapse' : 'Expand'} onPointerDown={this.onPressDown} onClick={this.onGrab}>
            <span class="sheet__grab-bar"></span>
          </button>
        ) : null}

        {/*
          Both rows are conditional and both are divs. Stencil matches unkeyed siblings of the same
          tag by position, so without the keys a sheet that shows only a head would have it matched
          against the search row's vnode and reuse its element, input and all.
        */}
        {placeholder ? (
          <div class="sheet__search-row" key="search">
            <label class="sheet__search">
              <ve-icon name="search-outline"></ve-icon>
              <input type="search" enterkeyhint="search" placeholder={placeholder} value={this.searchValue} ref={this.keepSearch} onInput={this.onSearchInput} />
            </label>
            {this.showConfirm ? this.confirmButton() : null}
          </div>
        ) : null}

        {showHead ? (
          <div class={{ 'sheet__head': true, 'sheet__head--drag': this.grabber }} key="head" onPointerDown={this.onPressDown}>
            {this.showNone ? (
              <button type="button" class="sheet__icon-btn sheet__icon-btn--dim" aria-label={this.noneLabel} onClick={this.emitNone} key="none">
                <ve-icon name="ban-outline"></ve-icon>
              </button>
            ) : null}
            {this.showNone && hasTabs ? <span class="sheet__divider" key="divider"></span> : null}
            {this.heading ? (
              <span class="sheet__title" key="heading">
                {this.heading}
              </span>
            ) : null}
            {/*
              Always rendered, tabs or not: it is also the spacer that holds the name at the left of
              the head and the tick at the right. It only calls itself a tablist when it holds tabs,
              or every sheet with a name and no tabs announces an empty one.
            */}
            <div class="sheet__tabs" role={hasTabs ? 'tablist' : undefined} ref={this.keepTabStrip}>
              {this.tabs.map(tab => (
                <button
                  type="button"
                  role="tab"
                  key={tab.id}
                  class={{ 'sheet__tab': true, 'sheet__tab--on': tab.id === this.activeTab }}
                  // Written as a string on purpose: the vdom removes an attribute set to boolean
                  // false, and a tab with no `aria-selected` at all is announced as a plain button.
                  aria-selected={String(tab.id === this.activeTab)}
                  onClick={() => this.veTab.emit(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {headConfirm ? this.confirmButton() : null}
          </div>
        ) : null}

        <div class="sheet__body" key="body" ref={this.keepBody}>
          <slot></slot>
        </div>
      </Host>
    );
  }
}

/** Adds where the finger is now, and forgets where it was longer ago than the speed is read over. */
function follow(trail: { y: number; t: number }[], y: number, t: number): void {
  trail.push({ y, t });
  while (trail.length > 2 && t - trail[0].t > VELOCITY_WINDOW_MS) trail.shift();
}

/**
 * How fast the finger was going over the trail, down positive. A finger that stopped before it
 * lifted was not flicking, and its trail says so: the last two points are far apart in time.
 */
function speed(trail: readonly { y: number; t: number }[]): number {
  const first = trail[0];
  const last = trail[trail.length - 1];
  const ms = last.t - first.t;
  if (trail.length < 2 || ms <= 0 || ms > VELOCITY_WINDOW_MS * 2) return 0;
  return (last.y - first.y) / ms;
}
