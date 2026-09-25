import { Component, Prop } from '@stencil/core';

import { closeWhenGone } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { MAX_ZOOM_RAMP_MS, MAX_ZOOM_SCALE, MIN_ZOOM_SCALE, type ZoomEase } from '../../editor';
import { zoomLevelLabel, zoomRampLabel } from './zoom-labels';

/** The three curves, in the order the row shows them, with the word each is shown by. */
const EASES: readonly { id: ZoomEase; label: string }[] = [
  { id: 'smooth', label: 'Smooth' },
  { id: 'snappy', label: 'Snappy' },
  { id: 'steady', label: 'Steady' },
];

/** The level slider works in tenths, so its steps are the readout's one decimal. */
const LEVEL_UNITS = 10;

/** The ramp slider's step: a tenth of a second, which is also what the readout shows. */
const RAMP_STEP_MS = 100;

/**
 * The selected zoom's settings: how far in it goes, how the camera moves, and how long the move
 * takes. WHERE it goes is not here - the area is picked on the picture itself, by dragging and
 * pinching the box the preview draws while this sheet is open and the video is paused - so the sheet
 * says that in one line rather than offering two sliders for a centre nobody can aim by number.
 *
 * Compact on purpose, and short inside compact: three rows and the hint, well inside the 259px the
 * transition sheet is held to, so the picture the box is dragged on stays as large as it can be.
 *
 * Every control writes the manifest live through `store.updateZoom`, as every other sheet does, and
 * the tick only closes the sheet: undo is the way back. Each slider drag passes a coalesce key of its
 * own, so a drag - which calls the store sixty times a second - lands as ONE undo step, and the next
 * drag is another. A curve tapped is a step of its own.
 *
 * The chosen curve is in each tile's NAME (`Smooth, selected`) and never in `aria-pressed`: on the
 * Samsung A13's WebView (Chrome 99) a change to `aria-pressed` inside a shadow root never reaches
 * Android's accessibility tree, and a button with both a label and `aria-pressed` arrives there as a
 * ToggleButton with no text at all - nothing for TalkBack to read or for Maestro to find. The
 * transition sheet and the timeline's dots made the same move.
 *
 * Each slider sits between a visible word and a visible readout, because a slider reaches Android's
 * tree with no name of its own; the word and the number are what TalkBack and Maestro have.
 */
@Component({
  tag: 've-zoom-sheet',
  styleUrls: ['../sheet-common.css', 've-zoom-sheet.css'],
  shadow: true,
})
export class VeZoomSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);
  private stopClosing?: () => void;

  /**
   * Counts the sliders' gestures, for the coalesce keys: `zoom-level:<n>` folds every value of ONE
   * drag into one undo step, and a new `n` keeps the next drag of the same slider out of it - one
   * shared key would fold two separate drags into one undo.
   */
  private gestures = 0;

  connectedCallback() {
    // Undo can take the zoom away, and Delete on the timeline can too; either way there is nothing
    // left to set and the sheet goes. Deferred, because closing the panel unmounts this element and
    // would otherwise be doing it from inside the undo that emptied the selection.
    this.stopClosing = closeWhenGone(
      () => !this.ctx.store.selectedZoom.value,
      () => this.ctx.store.closePanel(),
    );
  }

  disconnectedCallback() {
    this.stopClosing?.();
    this.watcher.stop();
  }

  /*
   * Stable functions rather than arrows in the render: a new value is a changed value to the vdom,
   * so a fresh arrow would take the listener off and put it back on, and hand the slider a new
   * `format` it has to repaint for, on every frame of a drag.
   */
  private readonly onConfirm = () => this.ctx.store.closePanel();

  private readonly formatLevel = (units: number): string => zoomLevelLabel(units / LEVEL_UNITS);

  private readonly formatRamp = (ms: number): string => zoomRampLabel(ms);

  private readonly onGestureStart = () => {
    this.gestures++;
  };

  /** Inside the slider's gesture; the coalesce key folds the whole drag into one step. */
  private readonly onLevel = (event: CustomEvent<number>) => {
    const zoom = this.ctx.store.selectedZoom.value;
    if (!zoom) return;
    const scale = event.detail / LEVEL_UNITS;
    if (scale !== zoom.scale) this.ctx.store.updateZoom(zoom.id, { scale }, { coalesce: `zoom-level:${this.gestures}` });
  };

  private readonly onRamp = (event: CustomEvent<number>) => {
    const zoom = this.ctx.store.selectedZoom.value;
    if (!zoom) return;
    const rampMs = Math.round(event.detail);
    if (rampMs !== zoom.rampMs) this.ctx.store.updateZoom(zoom.id, { rampMs }, { coalesce: `zoom-ramp:${this.gestures}` });
  };

  private chooseEase(ease: ZoomEase): void {
    const zoom = this.ctx.store.selectedZoom.value;
    if (!zoom || zoom.ease === ease) return;
    this.ctx.store.updateZoom(zoom.id, { ease });
    this.ctx.store.haptic('selection');
  }

  render() {
    return this.watcher.run(() => {
      const zoom = this.ctx.store.selectedZoom.value;

      return (
        <ve-sheet heading="Zoom" onVeConfirm={this.onConfirm}>
          {zoom ? (
            <div class="zs" key="zoom">
              {/* Every row keyed: the body is conditional, and the vdom pairs unkeyed siblings by position. */}
              <div class="zs__row" key="level">
                <span class="zs__word">Level</span>
                <ve-slider
                  class="zs__slider"
                  ctx={this.ctx}
                  label="Zoom level"
                  value={Math.round(zoom.scale * LEVEL_UNITS)}
                  min={Math.round(MIN_ZOOM_SCALE * LEVEL_UNITS)}
                  max={Math.round(MAX_ZOOM_SCALE * LEVEL_UNITS)}
                  step={1}
                  pin="none"
                  format={this.formatLevel}
                  onVeGestureStart={this.onGestureStart}
                  onVeLive={this.onLevel}
                />
                {/* The number a test can read, and the one TalkBack can: the slider arrives unnamed. */}
                <span class="zs__value" data-readout="level">
                  {zoomLevelLabel(zoom.scale)}
                </span>
              </div>

              {/* The word is left readable rather than made a group's name: a group's name does not reach Android. */}
              <div class="zs__row zs__row--eases" key="eases">
                <span class="zs__word">Smoothness</span>
                <div class="zs__chips">
                  {EASES.map(ease => {
                    const on = ease.id === zoom.ease;
                    return (
                      <button
                        type="button"
                        key={ease.id}
                        data-ease={ease.id}
                        class={{ 'zs__chip': true, 'zs__chip--on': on }}
                        aria-label={on ? `${ease.label}, selected` : ease.label}
                        onClick={() => this.chooseEase(ease.id)}
                      >
                        <span class="zs__pill">{ease.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div class="zs__row" key="ramp">
                <span class="zs__word">Ramp</span>
                <ve-slider
                  class="zs__slider"
                  ctx={this.ctx}
                  label="Zoom ramp"
                  value={zoom.rampMs}
                  min={0}
                  max={MAX_ZOOM_RAMP_MS}
                  step={RAMP_STEP_MS}
                  pin="none"
                  format={this.formatRamp}
                  onVeGestureStart={this.onGestureStart}
                  onVeLive={this.onRamp}
                />
                <span class="zs__value zs__value--wide" data-readout="ramp">
                  {zoomRampLabel(zoom.rampMs)}
                </span>
              </div>

              {/* Says what a touch on the video does NOW: with the zoomed picture on screen (after a
                  scrub or while playing) a tap brings the box back, and only then does a drag move it. */}
              <p class="zs__hint" key="hint">
                {this.ctx.store.cameraLive.value ? 'Tap the video to change the area' : 'Drag or pinch the box on the video to pick the area'}
              </p>
            </div>
          ) : null}
        </ve-sheet>
      );
    });
  }
}
