import { Component, Element, Prop } from '@stencil/core';
import { computed, signal } from '@preact/signals-core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { FILTER_CATEGORIES, FILTER_PRESETS, clamp, cssFor, filterPreset, resolveFilterOps, slotAt, sourceMsAt, type FilterCategory } from '../../editor';

/** One preset as its thumbnail draws it. */
interface FilterThumb {
  id: string;
  label: string;
  /** CSS `filter` for the frame. */
  filter: string;
  /** Translucent layers over the filtered frame, bottom to top - CSS has no tint filter. */
  tints: string[];
}

/**
 * The undo step's name. The row says Intensity, because that is the word beside the slider, and the
 * history says what was changed.
 */
const STRENGTH_LABEL = 'Filter strength';

/**
 * TikTok's Filters sheet: the "none" icon and the categories in the frame's head, a strength slider
 * once a filter is on, and a row of thumbnails - the video's own frame under the playhead drawn
 * through each preset. A filter is the whole video's look, so this only ever changes `filterId` and
 * `filterIntensity`.
 */
@Component({
  tag: 've-filter-sheet',
  styleUrls: ['../sheet-common.css', 've-filter-sheet.css'],
  shadow: true,
})
export class VeFilterSheet {
  @Prop() ctx!: EditorContext;

  @Element() el!: HTMLElement;

  private readonly watcher = new SignalWatcher(this);

  /**
   * Which category's presets are on screen. Set from the applied filter on the way in, so the sheet
   * opens on the customer's own choice rather than on Trending.
   *
   * A signal rather than `@State`, because [thumbs] reads it: a computed that read a plain field
   * would be right once and then stay on the first category's presets for ever.
   */
  private readonly category = signal<FilterCategory>(FILTER_CATEGORIES[0].id);

  /** A frame URL the WebView failed to load, so the tiles fall back rather than showing a broken image. */
  private readonly brokenFrame = signal<string | null>(null);

  /**
   * Its own computed so the thumbnails are rebuilt when Adjust changes, not on every manifest change:
   * a strength drag writes a new manifest each frame but leaves `adjust` the same object, and a
   * computed handing back the object it handed back last time wakes nobody.
   */
  private readonly adjust = computed(() => this.ctx.store.manifest.value.adjust);

  /**
   * Each preset at full strength with the current Adjust on top - exactly what the preview will show
   * once it is tapped, since choosing a filter resets its strength to 100.
   *
   * "none" is left out: the head's none icon is that choice, and a second "Original" tile beside it
   * would only be the same button twice.
   */
  private readonly thumbs = computed<FilterThumb[]>(() => {
    const adjust = this.adjust.value;
    const category = this.category.value;
    return FILTER_PRESETS.filter(preset => preset.category === category && preset.id !== 'none').map(preset => {
      const css = cssFor(resolveFilterOps({ filterId: preset.id, filterIntensity: 1, adjust }));
      return { id: preset.id, label: preset.label, filter: css.filter, tints: css.tints };
    });
  });

  /**
   * The picture under the playhead: the filmstrip frame nearest to it.
   *
   * The playhead moves every frame while the video plays, but this only yields a new string when a
   * different filmstrip frame becomes the nearest one (once a second at the default density), and a
   * computed that returns an equal string re-renders no tiles.
   *
   * There is no poster branch any more. `EditorMedia` already falls back to a one frame strip built
   * from the clip's own poster, with the host's `fileUrl` applied to it, so a second fallback here
   * would only be the same picture reached a different way.
   */
  private readonly frame = computed<string | null>(() => {
    const { store } = this.ctx;
    const at = store.playheadMs.value;
    const slot = slotAt(store.manifest.value, at);
    if (!slot) return null;
    const strip = store.filmstrips.value.get(slot.clip.clipKey);
    if (!strip || strip.urls.length === 0) return null;
    const url = strip.urls[clamp(Math.round(sourceMsAt(slot, at) / strip.stepMs), 0, strip.urls.length - 1)];
    return url && url !== this.brokenFrame.value ? url : null;
  });

  private row?: HTMLElement;

  /**
   * One stable function rather than a fresh arrow per render: a new value is a changed value to the
   * vdom, and a ref that changes identity runs again on every repaint.
   */
  private readonly keepRow = (el?: HTMLElement) => {
    this.row = el;
  };

  private readonly onTab = (event: CustomEvent<string>) => {
    const category = FILTER_CATEGORIES.find(c => c.id === event.detail)?.id;
    if (!category || category === this.category.value) return;
    this.category.value = category;
    // A new category is a new row; starting it part-way along would hide its first presets.
    if (this.row) this.row.scrollLeft = 0;
  };

  /** Checks the id rather than the preset, so an id no preset knows any more can still be cleared. */
  private readonly onNone = () => {
    const { store } = this.ctx;
    if (store.manifest.value.filterId === 'none') return;
    store.setFilter('none');
    store.haptic('selection');
  };

  private readonly onConfirm = () => this.ctx.store.closePanel();

  /**
   * A live value from the slider, inside a gesture the slider has already opened. It also ends that
   * gesture, under [STRENGTH_LABEL], including when this sheet is closed with a finger still down:
   * the drag so far is still the customer's change.
   */
  private readonly onStrength = (event: CustomEvent<number>) => {
    this.ctx.store.previewFilterIntensity(event.detail / 100);
  };

  componentWillLoad() {
    this.category.value = filterPreset(this.ctx.store.manifest.value.filterId).category;
  }

  componentDidLoad() {
    this.centreSelected();
  }

  disconnectedCallback() {
    this.watcher.stop();
  }

  private choose(id: string): void {
    const { store } = this.ctx;
    if (store.manifest.value.filterId === id) return;
    store.setFilter(id);
    store.haptic('selection');
  }

  /** Puts the chosen preset in the middle of the row when the sheet opens, like TikTok does. */
  private centreSelected(): void {
    const row = this.row;
    const on = this.el.shadowRoot?.querySelector<HTMLElement>('.fs__thumb--on');
    if (!row || !on) return;
    row.scrollLeft = Math.max(0, on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2);
  }

  render() {
    return this.watcher.run(() => {
      const manifest = this.ctx.store.manifest.value;
      const { filterId } = manifest;
      /** 0..100, as the slider and the readout show it. */
      const intensity = Math.round(manifest.filterIntensity * 100);
      const frame = this.frame.value;
      const onFrameError = () => {
        this.brokenFrame.value = frame;
      };

      return (
        <ve-sheet tabs={FILTER_CATEGORIES} activeTab={this.category.value} showNone={true} onVeTab={this.onTab} onVeNone={this.onNone} onVeConfirm={this.onConfirm}>
          <div class="fs">
            {/*
              The thumbnails come first and stay put: the strength row appears under them when a
              filter is picked, so choosing one never moves the row the finger is already tapping
              along. Both children are divs and one of them is conditional, so both are keyed - the
              vdom matches unkeyed siblings of the same tag by position.
            */}
            <div class="fs__row" key="row" ref={this.keepRow}>
              {this.thumbs.value.map(thumb => {
                const on = thumb.id === filterId;
                return (
                  <button
                    type="button"
                    key={thumb.id}
                    class={{ 'fs__thumb': true, 'fs__thumb--on': on }}
                    // A string, because the vdom drops an attribute set to boolean false and a tile
                    // with no `aria-pressed` at all is announced as a plain button.
                    aria-pressed={String(on)}
                    onClick={() => this.choose(thumb.id)}
                  >
                    <span class="fs__frame">
                      {frame ? (
                        <img key="frame" class="fs__img" alt="" draggable={false} decoding="async" src={frame} style={{ filter: thumb.filter }} onError={onFrameError} />
                      ) : (
                        <span key="fallback" class="fs__img fs__img--fallback" style={{ filter: thumb.filter }}></span>
                      )}
                      {thumb.tints.map((tint, index) => (
                        <span key={`tint-${index}`} class="fs__tint" style={{ background: tint }}></span>
                      ))}
                    </span>
                    <span class="fs__label">{thumb.label}</span>
                  </button>
                );
              })}
            </div>

            {filterPreset(filterId).id !== 'none' ? (
              <div class="fs__strength" key="strength">
                {/*
                  Not `aria-hidden`, though it reads like it should be: the slider beside it carries
                  `aria-label="Filter strength"`, and hiding the word was on the reasoning that a
                  screen reader hears the name from the control itself.

                  It does not. On a current Chromium the slider reaches Android as an
                  `android.widget.SeekBar` marked `important-for-accessibility=false` and carrying
                  no name at all, so with this hidden the whole row - the only control for how
                  strong the filter is - was announced as nothing whatsoever. A visible word that is
                  also readable is the cheap half of that fix, and the half that does not depend on
                  which WebView the app happens to be running on.
                */}
                <span class="fs__strength-label">Intensity</span>
                {/*
                  No pin: the readout on the right already shows the number, and two of them chased
                  each other across the row while the knob moved.
                */}
                <ve-slider class="fs__slider" ctx={this.ctx} label={STRENGTH_LABEL} value={intensity} min={0} max={100} step={1} pin="none" onVeLive={this.onStrength} />
                <span class="fs__strength-value">{intensity}</span>
              </div>
            ) : null}
          </div>
        </ve-sheet>
      );
    });
  }
}
