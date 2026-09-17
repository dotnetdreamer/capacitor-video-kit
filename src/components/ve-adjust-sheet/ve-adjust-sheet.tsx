import { Component, Prop, State } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { ADJUST_SLIDERS, type AdjustSlider, type EditAdjust } from '../../editor';
import type { EditorIconName } from '../../icons/icons';

const ADJUST_ICONS: Readonly<Record<keyof EditAdjust, EditorIconName>> = {
  brightness: 'sunny-outline',
  contrast: 'contrast-outline',
  saturation: 'color-palette-outline',
  warmth: 'thermometer-outline',
  tint: 'color-fill-outline',
  fade: 'cloudy-outline',
};

/**
 * Two taps on the same property this close together reset it. Measured by hand rather than with
 * `dblclick`, which an Android WebView only fires when the page cannot zoom and which would still
 * deliver the first `click` on its own.
 */
const DOUBLE_TAP_MS = 320;

/**
 * TikTok's Adjust sheet: one slider for the property being tuned, and a row of round property
 * buttons under it. Adjust is the whole video's colour, applied after the filter, so everything here
 * changes `manifest.adjust`.
 *
 * Tap a property to tune it, double-tap it to put it back to 0; the head's "none" icon resets all
 * of them. A property that is not at 0 carries a dot, so a change made a while ago stays findable.
 *
 * About eighty lines of the Angular sheet were gesture bookkeeping against `ion-range`, which moved
 * its value to the finger from the first touch and had to be argued out of it. `ve-slider` owns its
 * pointer, so the drag test, the knob restores and the start value kept to compare a release against
 * are all gone, and what is left is this sheet's own two questions: which property the slider is
 * pointed at, and the detent that ticks when one passes back through neutral.
 */
@Component({
  tag: 've-adjust-sheet',
  styleUrls: ['../sheet-common.css', 've-adjust-sheet.css'],
  shadow: true,
})
export class VeAdjustSheet {
  @Prop() ctx!: EditorContext;

  /**
   * Which property the slider is pointed at. It is not in the store because nothing outside this
   * sheet asks: the manifest carries all six values whether or not one of them is being looked at.
   */
  @State() activeId: keyof EditAdjust = ADJUST_SLIDERS[0].id;

  private readonly watcher = new SignalWatcher(this);

  /** The last property tapped and when, for the hand timed double tap. */
  private lastTap: { key: keyof EditAdjust; at: number } | null = null;

  /**
   * The property the slider's open gesture belongs to, remembered before the first live value.
   *
   * Live values follow this rather than the active property. A property tapped with a second hand
   * while the first is still dragging changes `activeId` at once, but the slider is only replaced on
   * the next render, and a value arriving in that gap belongs to the gesture that is open rather
   * than to the property just chosen. Read against `activeId` instead, the drag wrote the old
   * property's value into the new one and both landed in a single undo step named after the old.
   */
  private held: keyof EditAdjust = ADJUST_SLIDERS[0].id;

  disconnectedCallback() {
    this.watcher.stop();
  }

  /*
   * One stable function each rather than a fresh arrow per render, because a new value is a changed
   * value to the vdom and the listener would be taken off and put back on every repaint.
   */
  private readonly resetAll = () => {
    const { store } = this.ctx;
    const before = store.manifest.value;
    store.resetAdjust();
    // Nothing moves on screen when every property was already at 0, so the buzz is the only answer
    // a reset gets, and it is owed only when there was something to reset.
    if (store.manifest.value !== before) store.haptic('light');
  };

  private readonly close = () => this.ctx.store.closePanel();

  /**
   * The value above the knob, where TikTok shows it and where it stays next to the finger. A row of
   * its own under the head would have cost the height the six property buttons need to fit the
   * screen, and the property's name is already under the highlighted button.
   */
  private readonly formatPin = (raw: number): string => {
    const v = Math.round(raw);
    // `+24`, `−24`, `0`; fade has no sign because it only goes one way.
    if (v < 0) return `−${-v}`;
    return v > 0 && this.activeSlider().min < 0 ? `+${v}` : String(v);
  };

  /** Before the first live value of a drag, which is the promise `ve-slider` makes about the order. */
  private readonly onGestureStart = () => {
    this.held = this.activeId;
  };

  /** Inside the slider's gesture: one drag of the knob is one undo step, named after the property. */
  private readonly onLive = (event: CustomEvent<number>) => {
    const { store } = this.ctx;
    const key = this.held;
    const value = event.detail;
    const before = toScale(store.manifest.value.adjust[key]);
    // Only a real change touches the store: every preview writes a new manifest object.
    if (value === before) return;
    // TikTok's detent: a tick under the finger when the property passes back through untouched.
    if (crossesZero(before, value)) store.haptic('selection');
    store.previewAdjust(key, value / 100);
  };

  private activeSlider(): AdjustSlider {
    return ADJUST_SLIDERS.find(slider => slider.id === this.activeId) ?? ADJUST_SLIDERS[0];
  }

  private tapProperty(slider: AdjustSlider): void {
    const now = performance.now();
    const last = this.lastTap;
    if (last && last.key === slider.id && now - last.at < DOUBLE_TAP_MS) {
      this.lastTap = null;
      this.resetProperty(slider);
      return;
    }
    this.lastTap = { key: slider.id, at: now };
    if (this.activeId !== slider.id) {
      this.activeId = slider.id;
      this.ctx.store.haptic('selection');
    }
  }

  private resetProperty(slider: AdjustSlider): void {
    const { store } = this.ctx;
    const key = slider.id;
    const changed = store.commit(`Reset ${slider.label}`, m =>
      m.adjust[key] === 0 ? m : { ...m, adjust: { ...m.adjust, [key]: 0 } },
    );
    if (changed) {
      // A double tap leaves nothing on screen to show for itself, so the sheet says what it did.
      store.showToast(`${slider.label} reset`);
      store.haptic('light');
    }
  }

  render() {
    return this.watcher.run(() => {
      const adjust = this.ctx.store.manifest.value.adjust;
      const active = this.activeSlider();
      const twoSided = active.min < 0;

      return (
        // The frame's own button is called "None", which here would tell a screen reader nothing
        // about what it does. Angular had no input for that and waited a frame to rewrite the
        // rendered attribute through a `querySelector` that a shadow root now answers with null.
        <ve-sheet heading="Adjust" showNone={true} noneLabel="Reset" onVeNone={this.resetAll} onVeConfirm={this.close}>
          <div class="sheet__content as">
            <div class="as__track">
              {twoSided ? <span class="as__zero" aria-hidden="true" key="zero"></span> : null}
              {/*
                One slider for all six properties, keyed by the property it is pointed at, which is
                the other half of the answer to a property tapped mid drag: the element is replaced,
                the old one's `disconnectedCallback` closes its gesture under the name of the
                property it began on, and the rest of that drag reaches nothing. Kept in place
                instead, the drag would run on and land under the newly chosen property's name.

                `from` is what runs the fill out from the middle rather than from the left end, which
                is the only way a two sided scale reads as one.
              */}
              <ve-slider
                key={active.id}
                ctx={this.ctx}
                value={toScale(adjust[active.id])}
                min={active.min * 100}
                max={100}
                step={1}
                from={0}
                label={active.label}
                format={this.formatPin}
                onVeGestureStart={this.onGestureStart}
                onVeLive={this.onLive}
              ></ve-slider>
            </div>

            <div class="as__props">
              {ADJUST_SLIDERS.map(slider => (
                <button
                  type="button"
                  key={slider.id}
                  class={{ 'as__prop': true, 'as__prop--on': slider.id === this.activeId }}
                  // A string on purpose: the vdom removes an attribute set to boolean false, and a
                  // button with no `aria-pressed` at all is announced as a plain button.
                  aria-pressed={String(slider.id === this.activeId)}
                  onClick={() => this.tapProperty(slider)}
                >
                  <span class="as__circle">
                    <ve-icon name={ADJUST_ICONS[slider.id]}></ve-icon>
                    {adjust[slider.id] !== 0 ? <span class="as__dot" aria-hidden="true" key="dot"></span> : null}
                  </span>
                  <span class="as__prop-label">{slider.label}</span>
                </button>
              ))}
            </div>
          </div>
        </ve-sheet>
      );
    });
  }
}

/** A manifest value (-1..1) on the slider's whole-number scale. */
function toScale(value: number): number {
  return Math.round(value * 100);
}

/**
 * Whether moving from `from` to `to` reaches or passes 0. Leaving 0 does not count, so a drag that
 * starts at neutral does not buzz on its first step.
 */
function crossesZero(from: number, to: number): boolean {
  return from !== 0 && (to === 0 || Math.sign(to) !== Math.sign(from));
}
