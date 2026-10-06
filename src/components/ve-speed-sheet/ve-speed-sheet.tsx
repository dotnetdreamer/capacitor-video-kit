import { Component, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { MAX_SPEED, MIN_SPEED, SPEED_CHIPS, musicSpeed, setClipSpeed } from '../../editor';
import { SLIDER_EDGE_PX } from '../ve-slider/slider-geometry';
import { ONE_X, SLIDER_MAX, formatSpeed, roundSpeed, sliderToSpeed, speedToSlider } from './speed-curve';

/**
 * What the sheet is setting the speed of, and that speed: the selected segment, a sound on an audio
 * lane, or an older edit's one sound. Read off the selection, which is safe because `select` closes
 * this sheet whenever the selection changes - the two cannot come to disagree.
 */
type SpeedTarget = { kind: 'clip'; id: string; speed: number } | { kind: 'audio'; id: string; speed: number } | { kind: 'music'; speed: number };

/** The only point the knob sticks to, and how far either side of it a finger is close enough. */
const SNAP_TO_ONE_X = [ONE_X];
const SNAP_RADIUS_UNITS = 3;

/**
 * Where the 1x tick sits under the track. The knob does not travel the full width of the slider -
 * its bar stops [SLIDER_EDGE_PX] in at either end so the knob and the value above it stay inside
 * the sheet's gutter - so the tick is placed along that shorter run, not along the whole row.
 */
const ONE_X_LEFT = `calc(${SLIDER_EDGE_PX}px + (100% - ${SLIDER_EDGE_PX * 2}px) * ${ONE_X / SLIDER_MAX})`;

const MIN_LABEL = formatSpeed(MIN_SPEED);
const MAX_LABEL = formatSpeed(MAX_SPEED);

/**
 * Speed for the selected clip segment or sound: a readout, TikTok's preset chips, a fine slider that
 * snaps to 1x, and - for a segment, with more than one - the offer to give them all the same speed.
 * Every change stretches the timeline, so the timeline above follows it live. A sound keeps its pitch
 * at any speed, as a clip's does, and keeps its place on the post: it only runs longer or shorter.
 */
@Component({
  tag: 've-speed-sheet',
  styleUrls: ['../sheet-common.css', 've-speed-sheet.css'],
  shadow: true,
})
export class VeSpeedSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  disconnectedCallback() {
    this.watcher.stop();
  }

  /*
   * One stable function each rather than a fresh arrow per render. A changed value is a changed prop
   * to Stencil, so a `format` rebuilt on every repaint would re-render the slider under the finger,
   * which is every repaint of a drag.
   */
  private readonly close = () => {
    this.ctx.store.closePanel();
  };

  /** The text above the knob, in speeds rather than in slider units. */
  private readonly formatSlider = (value: number): string => formatSpeed(roundSpeed(sliderToSpeed(value)));

  /** What the sheet is about now; see [SpeedTarget]. Null when nothing that has a speed is selected. */
  private target(): SpeedTarget | null {
    const { store } = this.ctx;
    const clip = store.selectedClip.value;
    if (clip) return { kind: 'clip', id: clip.id, speed: clip.speed };
    const audio = store.selectedAudio.value;
    if (audio) return { kind: 'audio', id: audio.id, speed: musicSpeed(audio) };
    const music = store.musicSelected.value ? store.manifest.value.music : null;
    return music ? { kind: 'music', speed: musicSpeed(music) } : null;
  }

  /** The one way a speed is set from here, live inside the slider's gesture or as a step. */
  private setSpeed(target: SpeedTarget, speed: number, live: boolean): void {
    const { store } = this.ctx;
    switch (target.kind) {
      case 'clip':
        store.setClipSpeed(target.id, speed, live);
        break;
      case 'audio':
        store.setAudioSpeed(target.id, speed, live);
        break;
      case 'music':
        store.setMusicSpeed(speed, live);
        break;
    }
  }

  private readonly pickChip = (speed: number): void => {
    const target = this.target();
    if (!target || target.speed === speed) return;
    this.setSpeed(target, speed, false);
    this.ctx.store.haptic('selection');
  };

  /** Inside the slider's gesture. */
  private readonly onLive = (event: CustomEvent<number>): void => {
    const target = this.target();
    if (!target) return;
    const speed = roundSpeed(sliderToSpeed(event.detail));
    if (speed !== target.speed) this.setSpeed(target, speed, true);
  };

  /**
   * Gives every segment the selected one's speed, as one undo step - the same offer the volume sheet
   * makes. It folds the same `setClipSpeed` a single segment goes through, so the speed each one ends
   * up with is rounded and clamped identically, and a manifest where they all already match comes
   * back unchanged and records nothing.
   */
  private readonly applyToAll = (): void => {
    const { store } = this.ctx;
    const clip = store.selectedClip.value;
    if (!clip) return;
    const { speed } = clip;
    const changed = store.commit('Speed for all', m => m.clips.reduce((next, c) => setClipSpeed(next, c.id, speed), m));
    store.showToast(changed ? 'Speed applied to all clips' : 'All clips already have this speed');
    if (changed) store.haptic('light');
  };

  render() {
    return this.watcher.run(() => {
      const { store } = this.ctx;
      const target = this.target();
      // TikTok offers one speed for the whole video; with a single segment it would do nothing. A sound
      // has no siblings it would make sense to give its speed to.
      const canApplyToAll = target?.kind === 'clip' && store.manifest.value.clips.length > 1;

      return (
        <ve-sheet heading={headingFor(target)} onVeConfirm={this.close}>
          {target ? (
            <div class="sheet__content speed" key="speed">
              <div class="speed__value">{formatSpeed(target.speed)}</div>

              <div class="speed__chips" role="radiogroup" aria-label="Speed presets">
                {SPEED_CHIPS.map(chip => (
                  <button
                    type="button"
                    role="radio"
                    key={chip}
                    class={{ 'speed__chip': true, 'speed__chip--on': target.speed === chip }}
                    // A string, because the vdom removes an attribute set to boolean false and a
                    // radio with no `aria-checked` at all is announced as a plain button.
                    aria-checked={String(target.speed === chip)}
                    onClick={() => this.pickChip(chip)}
                  >
                    <span class="speed__pill">{formatSpeed(chip)}</span>
                  </button>
                ))}
              </div>

              <div class="speed__track">
                {/*
                  The knob's position is a pure function of the manifest's own speed, so a live drag
                  moves it by way of the store rather than beside it, and an undo lands the knob back
                  where the step it removed had it.
                */}
                <ve-slider
                  ctx={this.ctx}
                  value={speedToSlider(target.speed)}
                  max={SLIDER_MAX}
                  label="Speed"
                  format={this.formatSlider}
                  pin="press"
                  snap={SNAP_TO_ONE_X}
                  snapRadius={SNAP_RADIUS_UNITS}
                  onVeLive={this.onLive}
                ></ve-slider>
                <div class="speed__scale" aria-hidden="true">
                  <span class="speed__scale-end">{MIN_LABEL}</span>
                  <span class="speed__scale-one" style={{ left: ONE_X_LEFT }}>
                    1x
                  </span>
                  <span class="speed__scale-end">{MAX_LABEL}</span>
                </div>
              </div>

              {canApplyToAll ? (
                <button type="button" class="sheet__apply-all" key="apply-all" onClick={this.applyToAll}>
                  Apply to all clips
                </button>
              ) : null}
            </div>
          ) : (
            <p class="sheet__content speed__empty" key="empty">
              Select a clip first
            </p>
          )}
        </ve-sheet>
      );
    });
  }
}

/** The sheet's name, which is the only thing on screen that says which speed is being changed. */
function headingFor(target: SpeedTarget | null): string {
  switch (target?.kind) {
    case 'audio':
      return 'Audio speed';
    case 'music':
      return 'Sound speed';
    default:
      return 'Speed';
  }
}
