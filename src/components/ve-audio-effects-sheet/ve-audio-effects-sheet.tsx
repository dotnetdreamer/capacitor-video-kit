import { Component, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import {
  SOUND_EFFECTS,
  SOUND_EFFECT_SETTING_MAX,
  audioEffectSpeed,
  clamp,
  soundEffectPreset,
  soundEffectSettings,
  type EditAudioEffect,
  type SoundEffectControl,
  type SoundEffectSpeed,
} from '../../editor';
import { formatSpeed } from '../ve-speed-sheet/speed-curve';

import { SOUND_EFFECT_ICONS } from './effect-icons';

/** How close to a slider's default the knob has to come to stick to it, in the slider's steps. */
const SNAP_RADIUS = 3;

/**
 * The effects for an audio effect layer: a row of tiles - a megaphone, slow + reverb - and under it the
 * sliders of the one the selected layer has: how hard the megaphone is and its tone, how slow the
 * layer plays what it covers and how big its room is. With no layer selected, a tile adds one at the
 * playhead ([EditorStore.chooseAudioEffect]); with one, a tile changes its effect, and the head's "none"
 * takes the layer away, as the Filters sheet's takes a filter off. A tap is one undo step and so is a
 * drag of a slider. The preview plays every sound the layer covers through it as soon as `EditorMedia`
 * has made the copy it plays from, so the customer hears the choice by pressing Play, which a compact
 * sheet leaves in reach; a slider let go has a new copy made, and the old one plays until it lands.
 */
@Component({
  tag: 've-audio-effects-sheet',
  styleUrls: ['../sheet-common.css', 've-audio-effects-sheet.css'],
  shadow: true,
})
export class VeAudioEffectsSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  /** Each slider's live handler, by its key: see [onSetting]. */
  private readonly settingHandlers = new Map<string, (event: CustomEvent<number>) => void>();

  disconnectedCallback() {
    this.watcher.stop();
  }

  /** The layer the sheet is about, read off the selection; null while it is adding one. */
  private layer(): EditAudioEffect | null {
    return this.ctx.store.selectedAudioEffect.value;
  }

  private choose(effectId: string): void {
    if (this.layer()?.effect === effectId) return;
    if (this.ctx.store.chooseAudioEffect(effectId)) this.ctx.store.haptic('selection');
  }

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed prop to
   * Stencil, and the frame would take its listeners off and put them back on every repaint - and a
   * slider's, under a finger, on every frame of the drag.
   */
  private readonly onNone = () => {
    const layer = this.layer();
    if (layer) this.ctx.store.deleteAudioEffect(layer.id);
  };

  private readonly onConfirm = () => this.ctx.store.closePanel();

  /** The Slow slider, in hundredths of a speed, inside its gesture: the layer's own ([EditAudioEffect.speed]). */
  private readonly onSpeed = (event: CustomEvent<number>) => {
    const layer = this.layer();
    if (layer) this.ctx.store.setAudioEffectSpeed(layer.id, event.detail / 100);
  };

  /** The Slow slider's value as a speed, for a screen reader: "0.8x". */
  private readonly formatSpeedSlider = (value: number): string => formatSpeed(value / 100);

  /**
   * The live handler of the slider for `key`, inside its gesture, made once for each key. It reads the
   * layer when it is called, so a layer given another effect while a finger is still on an old slider
   * is handed a value its effect has no slider for, which changes nothing.
   */
  private onSetting(key: string): (event: CustomEvent<number>) => void {
    let handler = this.settingHandlers.get(key);
    if (!handler) {
      handler = (event: CustomEvent<number>) => {
        const layer = this.layer();
        if (layer) this.ctx.store.setAudioEffectSetting(layer.id, key, event.detail);
      };
      this.settingHandlers.set(key, handler);
    }
    return handler;
  }

  /** The Slow slider of an effect that slows, the speed itself at its end. */
  private speedRow(speed: SoundEffectSpeed, layer: EditAudioEffect) {
    const min = Math.round(speed.min * 100);
    const max = Math.round(speed.max * 100);
    const value = audioEffectSpeed(layer);
    return (
      <div class="afx__control" key="speed">
        <span class="afx__control-label">{speed.label}</span>
        {/*
          No pin, as the Filters sheet's strength has none: the number at the end of the row is the
          readout, and a second one riding the knob chased it across the row. It sticks at the effect's
          own speed on the way through, as the other sliders stick at their defaults.
        */}
        <ve-slider
          class="afx__slider"
          ctx={this.ctx}
          label={speed.name}
          value={clamp(Math.round(value * 100), min, max)}
          min={min}
          max={max}
          step={1}
          pin="none"
          snap={[Math.round(speed.default * 100)]}
          snapRadius={SNAP_RADIUS}
          format={this.formatSpeedSlider}
          onVeLive={this.onSpeed}
        />
        <span class="afx__control-value">{formatSpeed(value)}</span>
      </div>
    );
  }

  /** One of the effect's own sliders, 0 to 100, sticking at its default on the way through. */
  private settingRow(control: SoundEffectControl, layer: EditAudioEffect) {
    const value = soundEffectSettings(layer.effect, layer.effectSettings)[control.key] ?? control.default;
    return (
      <div class="afx__control" key={control.key}>
        <span class="afx__control-label">{control.label}</span>
        <ve-slider
          class="afx__slider"
          ctx={this.ctx}
          label={control.name}
          value={value}
          min={0}
          max={SOUND_EFFECT_SETTING_MAX}
          step={1}
          pin="none"
          snap={[control.default]}
          snapRadius={SNAP_RADIUS}
          onVeLive={this.onSetting(control.key)}
        />
        <span class="afx__control-value">{value}</span>
      </div>
    );
  }

  render() {
    return this.watcher.run(() => {
      const layer = this.layer();
      const preset = layer ? soundEffectPreset(layer.effect) : null;
      return (
        <ve-sheet heading="Audio effects" showNone={!!layer} noneLabel="No effect" onVeNone={this.onNone} onVeConfirm={this.onConfirm}>
          <div class="sheet__content afx" key="effects">
            {/*
              The tiles first and staying put, the sliders under them, as the Filters sheet has its
              strength: choosing an effect never moves the row the finger is tapping along. Keyed by
              the effect, so another effect's sliders are new sliders, and one being dragged when its
              effect is changed lets its gesture go as it is taken away.
            */}
            <div class="afx__row" key="row">
              {SOUND_EFFECTS.map(each => {
                const on = layer?.effect === each.id;
                return (
                  <button
                    type="button"
                    key={each.id}
                    class={{ 'afx__tile': true, 'afx__tile--on': on }}
                    // A string, because the vdom drops an attribute set to boolean false and a tile
                    // with no `aria-pressed` at all is announced as a plain button.
                    aria-pressed={String(on)}
                    onClick={() => this.choose(each.id)}
                  >
                    <span class="afx__face">
                      <ve-icon class="afx__icon" name={SOUND_EFFECT_ICONS[each.id] ?? 'sparkles-outline'}></ve-icon>
                    </span>
                    <span class="afx__label">{each.label}</span>
                  </button>
                );
              })}
            </div>
            {layer && preset ? (
              <div class="afx__controls" key={`controls-${preset.id}`}>
                {preset.speed ? this.speedRow(preset.speed, layer) : null}
                {preset.controls.map(control => this.settingRow(control, layer))}
              </div>
            ) : (
              <p class="afx__hint" key="hint">
                An effect changes every sound it covers
              </p>
            )}
          </div>
        </ve-sheet>
      );
    });
  }
}
