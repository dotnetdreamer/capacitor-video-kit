import { Component, Element, Event, type EventEmitter, Host, Prop, State } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { quantiseSlider, sliderFraction, sliderGrab, sliderKnobX, sliderSnap, sliderValueAt, type SliderPin, type SliderTrack } from './slider-geometry';

/** What the value above the knob says when a sheet does not say otherwise. */
const defaultFormat = (value: number): string => String(Math.round(value));

/** A page step, in whole steps of the scale, for the keyboard. */
const PAGE_STEPS = 10;

/** One drag, from the moment a finger lands until it lifts. */
interface SliderDrag {
  readonly pointerId: number;
  /** Measured once on the way in: the bar does not move while a finger is on it. */
  readonly track: SliderTrack;
  /** What the knob was picked up by, so it stays under the same part of the finger. */
  readonly offsetPx: number;
  /** Whether a value has actually been handed to the sheet, which is what makes this an edit. */
  moved: boolean;
}

/**
 * The editor's slider: a thin grey bar, a white fill, a white knob and the value floating above it,
 * wired to the store so that a whole drag is exactly ONE undo step.
 *
 * It is written from pointer events rather than built on a range input or a component library,
 * which is a change of mechanism and not of behaviour. The Angular editor drove `ion-range`, and
 * three of its sheets carried about eighty lines each of gesture code whose only job was to undo
 * what Ionic had already decided: Ionic moves its value to wherever the finger is from the very
 * first touch, so a finger put down a few pixels off the knob's centre changed the value before it
 * had moved at all, and every sheet had to notice that, throw the value away and put the knob back
 * on the next microtask. Owning the pointer means the knob is picked up by the offset it was
 * grabbed at and simply travels with the finger, and all of that goes away.
 *
 * What it promises, which is what six sheets are written against:
 *
 *  - The knob's position is a pure function of the `value` prop. A sheet maps slider units to its
 *    own value, writes them to the store, and the store repaints this element; nothing here keeps a
 *    value of its own to fall out of step with the manifest.
 *  - `veGestureStart` fires before the first `veLive`, and the store's gesture is already open when
 *    it does. The volume sheet needs that order: it is where it remembers the level to bring a
 *    track dragged to silence back to.
 *  - A press that never moves changes nothing and records no undo step.
 *  - A press on the bar beyond the knob's own radius jumps to the finger and lands as one step.
 *  - A drag that ends back where it started records nothing, which is `endGesture`'s own rule.
 *  - Being unmounted mid drag closes the gesture. Undo can take away the very layer the sheet is
 *    adjusting while a finger is still down, and a gesture left open would be inherited by whatever
 *    the customer did next.
 */
@Component({
  tag: 've-slider',
  styleUrl: 've-slider.css',
  shadow: true,
})
export class VeSlider {
  @Prop() ctx!: EditorContext;

  @Element() el!: HTMLElement;

  /** In slider units. */
  @Prop() value!: number;
  @Prop() min = 0;
  @Prop() max = 100;
  @Prop() step = 1;

  /**
   * Where the fill runs from, for a scale that has a neutral point rather than a bottom end. The
   * Adjust sheet's five two sided properties pass 0, so the bar fills out from the middle in the
   * direction the property was taken. Unset, the fill starts at `min`.
   */
  @Prop() from?: number;

  /** The undo step's name, and the slider's accessible name. */
  @Prop() label!: string;

  /** The text above the knob, given the value. */
  @Prop() format: (value: number) => string = defaultFormat;

  /**
   * Whether that text is shown. `press` is for a sheet that already shows the value large somewhere
   * else and only wants it next to the finger; `none` is for a sheet with a readout in the same row,
   * where two numbers chased each other across the row while the knob moved.
   */
  @Prop() pin: SliderPin = 'always';

  /** Slider values the knob sticks to when it comes within `snapRadius` of them. */
  @Prop() snap: readonly number[] = [];
  @Prop() snapRadius = 0;

  /** A drag, or a press on the bar, has begun; the store's gesture is already open. */
  @Event() veGestureStart!: EventEmitter<void>;

  /** A live value inside that gesture, in slider units, snapped. */
  @Event() veLive!: EventEmitter<number>;

  /** Drives the value above the knob when `pin` is `press`; nothing else reads it. */
  @State() held = false;

  private drag: SliderDrag | null = null;
  /** The snap point the knob is sitting on, so the tick fires once on the way in rather than per move. */
  private heldAt: number | null = null;
  /** The last value handed to the sheet, so an unchanged one is not sent sixty times a second. */
  private lastSent = 0;
  private trackEl?: HTMLDivElement;

  /**
   * One stable function rather than a fresh arrow per render: a new value is a changed value to
   * Stencil, and the ref would run again on every repaint.
   */
  private readonly keepTrack = (el?: HTMLDivElement) => {
    this.trackEl = el;
  };

  disconnectedCallback() {
    this.closeDrag();
  }

  /* ========================================================================================= */
  /* The gesture                                                                               */
  /* ========================================================================================= */

  private readonly onPointerDown = (event: PointerEvent) => {
    if (this.drag || !event.isPrimary || !this.trackEl) return;
    const rect = this.trackEl.getBoundingClientRect();
    const track: SliderTrack = { left: rect.left, width: rect.width };
    const grab = sliderGrab(event.clientX, sliderKnobX(this.value, track, this.min, this.max));

    this.drag = { pointerId: event.pointerId, track, offsetPx: grab.offsetPx, moved: false };
    this.lastSent = this.value;
    // The point the knob already rests on, so a drag that starts on 1x does not tick its way out of it.
    this.heldAt = sliderSnap(this.value, this.snap, this.snapRadius);
    this.held = true;

    this.capture(event.pointerId);
    this.ctx.store.beginGesture();
    this.veGestureStart.emit();

    // A press on the bar away from the knob is itself the change: the knob goes to the finger, and
    // lifting without moving again lands that jump as one step.
    if (!grab.onKnob) this.push(event.clientX);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.drag?.pointerId !== event.pointerId) return;
    this.push(event.clientX);
  };

  private readonly onPointerEnd = (event: PointerEvent) => {
    if (this.drag?.pointerId !== event.pointerId) return;
    this.closeDrag();
  };

  /**
   * Gives this element the finger until it lifts, so a drag that leaves the 44px row - which every
   * slightly vertical drag does within a few pixels - keeps moving the knob instead of stopping dead.
   *
   * It is allowed to fail. `setPointerCapture` throws when the id names no pointer the browser has
   * down, which is a pointer that ended between the event being dispatched and this handler running,
   * and is also what a synthetic event in a test looks like. Neither is worth dropping the gesture
   * over: without capture the drag still works for as long as the finger stays over the element.
   */
  private capture(pointerId: number): void {
    try {
      this.el.setPointerCapture(pointerId);
    } catch {
      /* Uncaptured, and still a drag. */
    }
  }

  private push(clientX: number): void {
    const drag = this.drag;
    if (!drag) return;

    const raw = sliderValueAt(clientX + drag.offsetPx, drag.track, this.min, this.max, this.step);
    const snapped = sliderSnap(raw, this.snap, this.snapRadius);
    // Once on the way in, tracked by the point being held: a tick per move event buzzes the phone
    // sixty times a second for as long as the finger stays near the mark.
    if (snapped !== null && snapped !== this.heldAt) this.ctx.store.haptic('selection');
    this.heldAt = snapped;

    const next = snapped ?? raw;
    if (next === this.lastSent) return;
    this.lastSent = next;
    drag.moved = true;
    this.veLive.emit(next);
  }

  private closeDrag(): void {
    const drag = this.drag;
    this.drag = null;
    this.heldAt = null;
    this.held = false;
    if (!drag) return;

    if (this.el.hasPointerCapture(drag.pointerId)) this.el.releasePointerCapture(drag.pointerId);
    // Only pressed, never dragged: nothing here is the customer's change, so nothing becomes an undo
    // step. A drag that ended back where it started is `endGesture`'s own case, and records nothing
    // either, because it compares the manifest by value rather than by identity.
    if (drag.moved) this.ctx.store.endGesture(this.label);
    else this.ctx.store.cancelGesture();
  }

  /**
   * Arrow, page, home and end, each as its own one step change.
   *
   * `role="slider"` without them would be a promise the element does not keep, and the Adjust sheet
   * was already written for a keyboard reaching its range. The gesture is opened and closed around
   * the single value, so the store sees the same shape it sees from a finger.
   */
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (this.drag) return;
    const stride = this.step > 0 ? this.step : (this.max - this.min) / 100;
    let raw: number;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        raw = this.value - stride;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        raw = this.value + stride;
        break;
      case 'PageDown':
        raw = this.value - stride * PAGE_STEPS;
        break;
      case 'PageUp':
        raw = this.value + stride * PAGE_STEPS;
        break;
      case 'Home':
        raw = this.min;
        break;
      case 'End':
        raw = this.max;
        break;
      default:
        return;
    }
    event.preventDefault();

    const next = quantiseSlider(raw, this.min, this.max, this.step);
    if (next === this.value) return;
    const { store } = this.ctx;
    store.beginGesture();
    this.veGestureStart.emit();
    this.veLive.emit(next);
    store.endGesture(this.label);
  };

  /* ========================================================================================= */
  /* Rendering                                                                                 */
  /* ========================================================================================= */

  render() {
    const { min, max, value, pin } = this;
    const at = sliderFraction(value, min, max);
    const origin = sliderFraction(this.from ?? min, min, max);
    const text = this.format(value);

    return (
      <Host
        role="slider"
        tabindex="0"
        aria-label={this.label}
        aria-orientation="horizontal"
        aria-valuemin={String(min)}
        aria-valuemax={String(max)}
        aria-valuenow={String(value)}
        aria-valuetext={text}
        onPointerDown={this.onPointerDown}
        onPointerMove={this.onPointerMove}
        onPointerUp={this.onPointerEnd}
        onPointerCancel={this.onPointerEnd}
        onKeyDown={this.onKeyDown}
      >
        <div
          class={{
            'sl': true,
            'sl--held': this.held,
            'sl--press': pin === 'press',
            'sl--no-pin': pin === 'none',
          }}
        >
          <div class="sl__track" ref={this.keepTrack}>
            <div class="sl__fill" style={{ left: pct(Math.min(origin, at)), width: pct(Math.abs(at - origin)) }}></div>
            <div class="sl__knob" style={{ left: pct(at) }}>
              {pin === 'none' ? null : <div class="sl__pin">{text}</div>}
            </div>
          </div>
        </div>
      </Host>
    );
  }
}

/**
 * A fraction as a CSS percentage, rounded off the dust a binary division leaves behind: 0.33 times
 * 100 is 33.000000000000004, and writing that into `left` is four decimal places of nothing in the
 * inspector on every repaint. Four places is still under a thousandth of a pixel on any bar.
 */
const pct = (fraction: number): string => `${Math.round(fraction * 1e6) / 1e4}%`;
