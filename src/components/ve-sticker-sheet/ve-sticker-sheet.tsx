import { Component, Element, Host, Prop } from '@stencil/core';
import { computed, signal } from '@preact/signals-core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { EMOJI_GROUPS, searchEmoji, type EmojiItem } from '../../data/emoji';
import { STICKERS, STICKER_CATEGORIES, stickerUrl } from '../../data/stickers';
import { debugWarn } from '../../host/debug';
import type { EditorIconName } from '../../icons/icons';
import type { SheetTab } from '../sheet.types';

type StickerTab = 'stickers' | 'emoji';

interface StickerCell {
  id: string;
  label: string;
  /** Label and keywords, lower-cased once, for the search. */
  haystack: string;
}

interface StickerSection {
  id: string;
  label: string;
  items: StickerCell[];
  /** `contain-intrinsic-size` for the section while it is off screen. */
  placeholder: string;
}

interface EmojiSection {
  id: string;
  label: string;
  items: EmojiItem[];
  placeholder: string;
}

/** One button of the category bar: an emoji, or a drawn icon for the sections that have no emoji. */
interface BarItem {
  id: string;
  label: string;
  emoji: string | null;
  icon: EditorIconName | null;
}

const TABS: SheetTab[] = [
  { id: 'stickers', label: 'Stickers' },
  { id: 'emoji', label: 'Emoji' },
];

const RECENT_KEY = 've.recentEmoji';
const RECENT_MAX = 16;
const RECENT_ID = 've-recent';

/*
 * Section geometry, mirrored in the stylesheet. Each section is `content-visibility: auto`, so the
 * browser skips laying out and painting the ones off screen - a few hundred colour emoji glyphs and
 * dozens of decoded SVGs are real work for a 2019 phone to paint all at once when the sheet opens. A
 * skipped section is as tall as its `contain-intrinsic-size`, and the category bar jumps by
 * measuring where a section starts, so the placeholder has to be the section's exact height or a
 * jump would land short of (or past) the section it was aiming at.
 */
const STICKER_HEADING = 40;
const STICKER_CELL = 96;
const STICKER_COLUMNS = 3;
const STICKER_ROW_GAP = 8;
const EMOJI_HEADING = 36;
const EMOJI_CELL = 44;
const EMOJI_COLUMNS = 7;
const EMOJI_ROW_GAP = 4;

/** After a category tap, the smooth scroll passes other sections; they must not steal the highlight. */
const JUMP_LOCK_MS = 700;

/**
 * The heading and the rows, and deliberately not the 8px below them: `contain-intrinsic-size` is an
 * intrinsic INNER size, so the section's own padding is added to it rather than counted inside it.
 * Measured in Chromium, a section carrying the padding twice stands 8px taller while it is skipped
 * than it does once it has been painted, and a jump aims through every section above its target.
 */
function sectionHeight(count: number, heading: number, cell: number, columns: number, gap: number): string {
  const rows = Math.max(1, Math.ceil(count / columns));
  return `auto ${heading + rows * cell + (rows - 1) * gap}px`;
}

/**
 * The Stickers tool: TikTok's nearly full-height picker - search, Stickers | Emoji tabs, a scrolling
 * grid split into sections, and a bar of category icons along the bottom that both follows the
 * scroll and jumps to a section when tapped.
 *
 * A tap adds the sticker from the playhead to the end and closes the sheet, which leaves the new
 * layer selected on the video - exactly where the customer's eyes go next to move and size it.
 *
 * The scrolling element belongs to the frame and is inside its shadow root, so this component asks
 * `ve-sheet` for it once rather than walking up the tree looking for a box that scrolls.
 */
@Component({
  tag: 've-sticker-sheet',
  styleUrls: ['../sheet-common.css', 've-sticker-sheet.css'],
  shadow: true,
})
export class VeStickerSheet {
  @Prop() ctx!: EditorContext;

  @Element() el!: HTMLElement;

  private readonly watcher = new SignalWatcher(this);

  private readonly tab = signal<StickerTab>('stickers');
  private readonly query = signal('');
  private readonly searching = computed(() => this.query.value.trim().length > 0);

  /** The section the bar highlights; null while a search replaces the sections. */
  private readonly activeSection = signal<string | null>(null);

  /* -- stickers ---------------------------------------------------------------------------- */

  /**
   * Everything about a sticker except where its file is: the URLs are resolved on the first render
   * instead, by [stickerUrls].
   */
  private readonly stickerSections: StickerSection[] = STICKER_CATEGORIES.map(category => {
    const items = STICKERS.filter(sticker => sticker.category === category.id).map(
      (sticker): StickerCell => ({
        id: sticker.id,
        label: sticker.label,
        haystack: [sticker.label, ...sticker.keywords].join(' ').toLowerCase(),
      }),
    );
    return {
      id: category.id,
      label: category.label,
      items,
      placeholder: sectionHeight(items.length, STICKER_HEADING, STICKER_CELL, STICKER_COLUMNS, STICKER_ROW_GAP),
    };
  }).filter(section => section.items.length > 0);

  private readonly stickerResults = computed(() => {
    const words = this.query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return this.stickerSections.flatMap(section => section.items).filter(cell => words.every(word => cell.haystack.includes(word)));
  });

  private urls: Map<string, string> | null = null;

  /** Set by [stickerUrls] when the pack cannot be located, and read by the render that asked. */
  private assetError = false;

  /* -- emoji ------------------------------------------------------------------------------- */

  private readonly recent = signal<string[]>(readRecent());
  private emojiNames: Map<string, string> | null = null;

  private readonly emojiSections = computed<EmojiSection[]>(() => {
    const sections: EmojiSection[] = EMOJI_GROUPS.map(group => ({
      id: group.id,
      label: group.label,
      items: group.items,
      placeholder: sectionHeight(group.items.length, EMOJI_HEADING, EMOJI_CELL, EMOJI_COLUMNS, EMOJI_ROW_GAP),
    })).filter(section => section.items.length > 0);

    const recent = this.recent.value;
    if (!recent.length) return sections;
    const names = this.namesByChar();
    const items = recent.map((char): EmojiItem => ({ char, name: names.get(char) ?? char }));
    return [
      {
        id: RECENT_ID,
        label: 'Recent',
        items,
        placeholder: sectionHeight(items.length, EMOJI_HEADING, EMOJI_CELL, EMOJI_COLUMNS, EMOJI_ROW_GAP),
      },
      ...sections,
    ];
  });

  private readonly emojiResults = computed(() => (this.searching.value ? searchEmoji(this.query.value.trim()) : []));

  /* -- category bar ------------------------------------------------------------------------ */

  private readonly barItems = computed<BarItem[]>(() => {
    if (this.tab.value === 'stickers') {
      const present = new Set(this.stickerSections.map(section => section.id));
      return STICKER_CATEGORIES.filter(category => present.has(category.id)).map(category => ({
        id: category.id,
        label: category.label,
        emoji: category.icon,
        icon: null,
      }));
    }
    const groups = new Map(EMOJI_GROUPS.map(group => [group.id, group]));
    return this.emojiSections.value.map(section =>
      section.id === RECENT_ID
        ? { id: RECENT_ID, label: 'Recent', emoji: null, icon: 'time-outline' as EditorIconName }
        : { id: section.id, label: section.label, emoji: groups.get(section.id)?.icon ?? null, icon: null },
    );
  });

  /* -- scroll tracking --------------------------------------------------------------------- */

  private frame?: HTMLVeSheetElement;
  private bar?: HTMLElement;

  private scroller: HTMLElement | null = null;
  private bandObserver: IntersectionObserver | null = null;
  private endObserver: IntersectionObserver | null = null;
  /** Sections crossing the band at the top of the scroll area. */
  private readonly inBand = new Set<string>();
  private atEnd = false;
  private lockedUntil = 0;
  /** A section to jump to once it has been rendered (a bar tap that cleared the search). */
  private pendingJump: string | null = null;
  /** The sections the observers are watching, so a repaint that changed none of them does nothing. */
  private observedKey: string | null = null;
  /** The category the bar has already been scrolled to, for the same reason. */
  private revealed: string | null = null;

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed value to
   * the vdom, so a ref would run again and a listener would be taken off and put back on every
   * repaint, and there is one repaint per section the scroll passes.
   */
  private readonly keepFrame = (el?: HTMLVeSheetElement) => {
    this.frame = el;
  };

  private readonly keepBar = (el?: HTMLElement) => {
    this.bar = el;
  };

  private readonly onTab = (event: CustomEvent<string>) => {
    const tab: StickerTab = event.detail === 'emoji' ? 'emoji' : 'stickers';
    if (tab === this.tab.value) return;
    this.tab.value = tab;
    this.activeSection.value = null;
    this.pendingJump = null;
    this.scrollToTop();
  };

  private readonly onSearch = (event: CustomEvent<string>) => {
    this.query.value = event.detail;
    this.scrollToTop();
  };

  private readonly close = () => {
    void this.frame?.blurSearch();
    this.ctx.store.closePanel();
  };

  /**
   * One listener per emoji grid rather than one per glyph: several hundred buttons each with its own
   * handler is avoidable work every time the tab opens, and the glyph itself is the button's text.
   *
   * `closest` stops at a shadow boundary, and both the button and this listener are in this
   * component's own root, which is what keeps that true.
   */
  private readonly onEmojiGridClick = (event: MouseEvent) => {
    const button = (event.target as HTMLElement | null)?.closest('button');
    const char = button?.textContent?.trim();
    if (!char) return;
    void this.frame?.blurSearch();
    if (this.ctx.store.addSticker({ emoji: char })) this.rememberEmoji(char);
    this.ctx.store.closePanel();
  };

  async componentDidLoad() {
    // The frame owns the scrolling element and it is in the frame's shadow root, which no
    // `querySelector` from here reaches. The Angular sheet walked up its ancestors looking for a box
    // with `overflow-y: auto`; the frame answers the question itself now.
    this.scroller = (await this.frame?.bodyElement()) ?? null;
    // The awaited call can land after the sheet was closed, which is the one moment this component
    // has that Angular's `DestroyRef` covered for free.
    if (!this.el.isConnected) return;
    this.syncObservers();
  }

  componentDidRender() {
    this.syncObservers();

    // Keep the highlighted category inside the bar when there are more than fit across. The
    // comparison is what makes this cheap enough to run on every repaint: the highlight changes once
    // per section the scroll passes, and the repaints in between are the scroll's own.
    const active = this.activeSection.value;
    if (active !== this.revealed) {
      this.revealed = active;
      this.revealBarItem(active);
    }
  }

  disconnectedCallback() {
    this.watcher.stop();
    this.bandObserver?.disconnect();
    this.endObserver?.disconnect();
  }

  /* ========================================================================================= */
  /* Chrome                                                                                    */
  /* ========================================================================================= */

  /**
   * A bar tap scrolls the grid so the section starts at the top. While a search is showing, it
   * clears the search first - the customer is asking to browse again - and jumps once the sections
   * are back on screen.
   */
  private jumpTo(id: string): void {
    this.ctx.store.haptic('selection');
    this.activeSection.value = id;
    this.lockedUntil = performance.now() + JUMP_LOCK_MS;
    if (this.searching.value) {
      void this.frame?.blurSearch();
      this.pendingJump = id;
      this.query.value = '';
      return;
    }
    this.scrollToSection(id);
  }

  /* ========================================================================================= */
  /* Picking                                                                                   */
  /* ========================================================================================= */

  private pickSticker(assetId: string): void {
    void this.frame?.blurSearch();
    this.ctx.store.addSticker({ assetId });
    this.ctx.store.closePanel();
  }

  private rememberEmoji(char: string): void {
    const next = [char, ...this.recent.value.filter(item => item !== char)].slice(0, RECENT_MAX);
    this.recent.value = next;
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // Storage can be full or disabled; recents are a convenience, the sticker was still added.
    }
  }

  private namesByChar(): Map<string, string> {
    if (!this.emojiNames) {
      this.emojiNames = new Map();
      for (const group of EMOJI_GROUPS) {
        for (const item of group.items) this.emojiNames.set(item.char, item.name);
      }
    }
    return this.emojiNames;
  }

  /**
   * Where the 34 SVGs are served from, worked out on the first render rather than where the sections
   * are built: `stickerUrl` resolves against the base a host set with `setEditorAssetPath`, and
   * throws when nothing has. Thrown from a field initializer that would take the element down before
   * it rendered anything, including the line that says what is missing.
   */
  private stickerUrls(): Map<string, string> {
    if (this.urls) return this.urls;
    const urls = new Map<string, string>();
    try {
      for (const sticker of STICKERS) urls.set(sticker.id, stickerUrl(sticker.id));
    } catch (error) {
      // One message for all 34, because they fail for the one reason. It is a host's integration
      // mistake rather than something the customer can act on, so the console carries the detail and
      // the sheet just says the pack is not there. The emoji tab needs no files and still works.
      this.assetError = true;
      debugWarn('[ve-sticker-sheet]', error);
    }
    this.urls = urls;
    return urls;
  }

  /* ========================================================================================= */
  /* Scroll                                                                                    */
  /* ========================================================================================= */

  private scrollToTop(): void {
    void this.frame?.scrollBodyTo(0);
  }

  /**
   * Puts the start of a section at the top of the grid. The frame does the scrolling, with
   * `scrollTo` rather than `element.scrollIntoView()`: the latter also scrolls every scrollable
   * ancestor, including `overflow: hidden` ones such as the editor column, which would nudge the
   * whole editor off its layout.
   */
  private scrollToSection(id: string): void {
    const area = this.scroller;
    if (!area) return;
    const sections = this.sectionElements();
    const index = sections.findIndex(el => el.dataset.section === id);
    if (index < 0) return;
    // The first section also brings back the "Recommended" heading above it.
    const top = index === 0 ? 0 : area.scrollTop + sections[index].getBoundingClientRect().top - area.getBoundingClientRect().top;
    void this.frame?.scrollBodyTo(top, 'smooth');
  }

  private sectionElements(): HTMLElement[] {
    return Array.from(this.el.shadowRoot?.querySelectorAll<HTMLElement>('[data-section]') ?? []);
  }

  /**
   * Re-observe whenever the rendered sections change: a tab switch or a search swaps them all.
   *
   * The Angular sheet could run this from an effect over its `viewChildren`, which only fired when
   * the list itself changed. Here every repaint is a candidate, and the scroll produces one per
   * section it passes through the highlight, so the ids are compared first: rebuilt observers would
   * clear the band on every frame of a smooth scroll and replay a pending jump with it.
   */
  private syncObservers(): void {
    // Nothing to observe against until `componentDidLoad` has been told where the scrolling is,
    // which is one render later. It calls back here when it knows.
    if (!this.scroller) return;
    const sections = this.sectionElements();
    const key = sections.map(el => el.dataset.section).join('|');
    if (key === this.observedKey) return;
    this.observedKey = key;
    this.observeSections(sections, this.el.shadowRoot?.querySelector<HTMLElement>('.stk__end') ?? null);
  }

  private observeSections(sections: HTMLElement[], end: HTMLElement | null): void {
    const area = this.scroller;
    if (!area || typeof IntersectionObserver === 'undefined') return;

    // A band across the top fifth of the scroll area: the first section crossing it is the one the
    // customer is looking at. The band starts 2px down because a section whose bottom edge merely
    // touches the top (where a jump leaves the section before its target) still counts as
    // intersecting, and would win the highlight back.
    this.bandObserver ??= new IntersectionObserver(entries => this.onBandEntries(entries), {
      root: area,
      rootMargin: '-2px 0px -80% 0px',
    });
    // The last sections are too short to ever reach the band, so reaching the bottom of the list
    // highlights the last category instead.
    this.endObserver ??= new IntersectionObserver(
      entries => {
        this.atEnd = entries[entries.length - 1]?.isIntersecting ?? false;
        this.updateActive();
      },
      { root: area },
    );

    this.bandObserver.disconnect();
    this.endObserver.disconnect();
    this.inBand.clear();
    this.atEnd = false;
    for (const section of sections) this.bandObserver.observe(section);
    if (end) this.endObserver.observe(end);

    if (!sections.length) {
      // A search replaced the sections: nothing in the bar is "where you are" any more.
      if (!this.pendingJump) this.activeSection.value = null;
      return;
    }

    const jump = this.pendingJump;
    if (jump) {
      this.pendingJump = null;
      this.lockedUntil = performance.now() + JUMP_LOCK_MS;
      this.scrollToSection(jump);
    } else if (!this.activeSection.value) {
      this.activeSection.value = sections[0].dataset.section ?? null;
    }
  }

  private onBandEntries(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.section;
      if (!id) continue;
      if (entry.isIntersecting) this.inBand.add(id);
      else this.inBand.delete(id);
    }
    this.updateActive();
  }

  private updateActive(): void {
    if (performance.now() < this.lockedUntil || this.searching.value) return;
    const order = this.barItems.value.map(item => item.id);
    const next = this.atEnd ? (order[order.length - 1] ?? null) : (order.find(id => this.inBand.has(id)) ?? null);
    if (next && next !== this.activeSection.value) this.activeSection.value = next;
  }

  private revealBarItem(id: string | null): void {
    const bar = this.bar;
    if (!id || !bar) return;
    const button = bar.querySelector<HTMLElement>(`[data-bar="${CSS.escape(id)}"]`);
    if (!button) return;
    const left = button.offsetLeft;
    const right = left + button.offsetWidth;
    if (left < bar.scrollLeft) bar.scrollTo({ left: left - 8, behavior: 'smooth' });
    else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollTo({ left: right - bar.clientWidth + 8, behavior: 'smooth' });
  }

  /* ========================================================================================= */
  /* Render                                                                                    */
  /* ========================================================================================= */

  private stickerButton(cell: StickerCell, urls: Map<string, string>) {
    return (
      <button type="button" class="stk__sticker" key={cell.id} aria-label={cell.label} onClick={() => this.pickSticker(cell.id)}>
        <img src={urls.get(cell.id)} alt="" loading="lazy" decoding="async" draggable={false} />
      </button>
    );
  }

  private stickerBody() {
    const urls = this.stickerUrls();
    if (this.assetError) return <p class="stk__empty">Stickers are unavailable</p>;

    if (this.searching.value) {
      const results = this.stickerResults.value;
      if (!results.length) return <p class="stk__empty">No stickers found</p>;
      return <div class="stk__grid stk__grid--results">{results.map(cell => this.stickerButton(cell, urls))}</div>;
    }

    return [
      <h3 class="stk__title" key="title">
        Recommended
      </h3>,
      /*
        The key carries the tab it belongs to: the sticker categories and the emoji groups both have
        a "food" section, and on a tab switch the vdom would otherwise match the two by that key and
        patch one grid of buttons into the other rather than replacing it.
      */
      ...this.stickerSections.map(section => (
        <section class="stk__section" key={`sticker-${section.id}`} data-section={section.id} style={{ 'contain-intrinsic-size': section.placeholder }}>
          <h4 class="stk__heading">{section.label}</h4>
          <div class="stk__grid">{section.items.map(cell => this.stickerButton(cell, urls))}</div>
        </section>
      )),
      <div class="stk__end" key="end"></div>,
    ];
  }

  private emojiBody() {
    if (this.searching.value) {
      const results = this.emojiResults.value;
      if (!results.length) return <p class="stk__empty">No emoji found</p>;
      return (
        <div class="stk__emoji-grid stk__emoji-grid--results" onClick={this.onEmojiGridClick}>
          {results.map(emojiButton)}
        </div>
      );
    }

    return [
      ...this.emojiSections.value.map(section => (
        <section class="stk__section" key={`emoji-${section.id}`} data-section={section.id} style={{ 'contain-intrinsic-size': section.placeholder }}>
          <h4 class="stk__heading stk__heading--emoji">{section.label}</h4>
          <div class="stk__emoji-grid" onClick={this.onEmojiGridClick}>
            {section.items.map(emojiButton)}
          </div>
        </section>
      )),
      <div class="stk__end" key="end"></div>,
    ];
  }

  render() {
    return this.watcher.run(() => {
      const tab = this.tab.value;
      const active = this.activeSection.value;

      return (
        <Host>
          <ve-sheet
            class="stk__frame"
            ref={this.keepFrame}
            searchPlaceholder="Search stickers and emoji"
            searchValue={this.query.value}
            tabs={TABS}
            activeTab={tab}
            onVeSearch={this.onSearch}
            onVeTab={this.onTab}
            onVeConfirm={this.close}
          >
            <div class="stk__content">{tab === 'stickers' ? this.stickerBody() : this.emojiBody()}</div>
          </ve-sheet>

          <nav class="stk__bar" ref={this.keepBar} aria-label="Categories">
            {/* Keyed by the tab, so the whole strip is replaced rather than patched button by button
                when the tabs change: the two tabs share section ids. */}
            <div class="stk__bar-track" key={tab}>
              {this.barItems.value.map(item => (
                <button
                  type="button"
                  key={item.id}
                  class={{ 'stk__cat': true, 'stk__cat--on': item.id === active }}
                  aria-label={item.label}
                  aria-current={item.id === active ? 'true' : null}
                  data-bar={item.id}
                  onClick={() => this.jumpTo(item.id)}
                >
                  {item.icon ? <ve-icon name={item.icon}></ve-icon> : <span class="stk__cat-emoji">{item.emoji}</span>}
                </button>
              ))}
            </div>
          </nav>
        </Host>
      );
    });
  }
}

/** A glyph is the button's own text, which is what [onEmojiGridClick] reads back. */
function emojiButton(item: EmojiItem, index: number) {
  return (
    <button type="button" class="stk__emoji" key={index} aria-label={item.name}>
      {item.char}
    </button>
  );
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
