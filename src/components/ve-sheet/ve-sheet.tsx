import { Component, Event, type EventEmitter, Host, Method, Prop } from '@stencil/core';

import type { SheetTab } from '../sheet.types';

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

  /** A tab was pressed, carrying its `id`. */
  @Event() veTab!: EventEmitter<string>;

  /** The "none" button was pressed. */
  @Event() veNone!: EventEmitter<void>;

  /** The tick was pressed. */
  @Event() veConfirm!: EventEmitter<void>;

  /** The search text changed, carrying the field's whole value. */
  @Event() veSearch!: EventEmitter<string>;

  private body?: HTMLElement;
  private search?: HTMLInputElement;

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

  private readonly emitNone = () => this.veNone.emit();

  private readonly emitConfirm = () => this.veConfirm.emit();

  private readonly onSearchInput = (event: Event) => {
    this.veSearch.emit((event.target as HTMLInputElement).value);
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
          <div class="sheet__head" key="head">
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
            <div class="sheet__tabs" role={hasTabs ? 'tablist' : undefined}>
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
