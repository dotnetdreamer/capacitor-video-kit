import { Component, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { SOUND_EFFECTS, SOUND_EFFECT_SETTING_MAX, clamp, musicSpeed, soundEffectPreset, soundEffectSettings, type SoundEffectControl, type SoundEffectSpeed } from '../../editor';
import type { SoundEffectTarget } from '../../state/editor.types';
import { formatSpeed } from '../ve-speed-sheet/speed-curve';

import { SOUND_EFFECT_ICONS } from './effect-icons';

/**
 * What the sheet is putting through an effect, and where that sound is now: the selected sound on a
 * lane, or an older edit's one sound, with its effect, every slider of it and its speed. Read off the
 * selection, which is safe because `select` closes this sheet whenever the selection changes - the
 * two cannot come to disagree.
 */
type Target = SoundEffectTarget & { effect: string | null; settings: Record<string, number>; speed: number };

/** How close to a slider's default the knob has to come to stick to it, in the slider's steps. */
const SNAP_RADIUS = 3;

/**
 * Effects for the selected sound: the head's "none" takes the effect off, as the Filters sheet's
 * does, a row of tiles under it puts one on - a megaphone, slow + reverb - and the sliders of the
 * one it has come under the tiles: how hard the megaphone is and its tone, how slow the song goes and
 * how big its room is. A tap is one undo step and so is a drag of a slider, and both apply at once;
 * the preview plays the sound through the effect as soon as `EditorMedia` has made the copy it plays
 * from, playing or not, so the customer hears the choice by pressing Play, which a compact sheet
 * leaves in reach. A slider let go has a new copy made, and the old one plays until it lands.
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

  /** What the sheet is about now; see [Target]. Null when no sound is selected. */
  private target(): Target | null {
    const { store } = this.ctx;
    const audio = store.selectedAudio.value;
    const sound = audio ?? (store.musicSelected.value ? store.manifest.value.music : null);
    if (!sound) return null;
    const where: SoundEffectTarget = audio ? { kind: 'audio', id: audio.id } : { kind: 'music' };
    return { ...where, effect: sound.effect ?? null, settings: soundEffectSettings(sound.effect, sound.effectSettings), speed: musicSpeed(sound) };
  }

  private choose(effectId: string | null): void {
    const target = this.target();
    if (!target || target.effect === effectId) return;
    if (this.ctx.store.setSoundEffect(target, effectId)) this.ctx.store.haptic('selection');
  }

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed prop to
   * Stencil, and the frame would take its listeners off and put them back on every repaint - and a
   * slider's, under a finger, on every frame of the drag.
   */
  private readonly onNone = () => this.choose(null);

  private readonly onConfirm = () => this.ctx.store.closePanel();

  /**
   * The Slow slider, in hundredths of a speed, inside its gesture: the sound's own speed
   * ([SoundEffectSpeed]), set as the Speed sheet sets it, so a slower sound that would run into the
   * next one on its lane stops where that one begins.
   */
  private readonly onSpeed = (event: CustomEvent<number>) => {
    const target = this.target();
    const speed = event.detail / 100;
    if (!target || speed === target.speed) return;
    if (target.kind === 'audio') this.ctx.store.setAudioSpeed(target.id, speed, true);
    else this.ctx.store.setMusicSpeed(speed, true);
  };

  /** The Slow slider's value as a speed, for a screen reader: "0.8x". */
  private readonly formatSpeedSlider = (value: number): string => formatSpeed(value / 100);

  /**
   * The live handler of the slider for `key`, inside its gesture, made once for each key. It reads the
   * sound when it is called, so a sound given another effect while a finger is still on an old slider
   * is handed a value its effect has no slider for, which changes nothing.
   */
  private onSetting(key: string): (event: CustomEvent<number>) => void {
    let handler = this.settingHandlers.get(key);
    if (!handler) {
      handler = (event: CustomEvent<number>) => {
        const target = this.target();
        if (target) this.ctx.store.setSoundEffectSetting(target, key, event.detail);
      };
      this.settingHandlers.set(key, handler);
    }
    return handler;
  }

  /** The Slow slider of an effect that holds the sound's speed, the speed itself at its end. */
  private speedRow(speed: SoundEffectSpeed, target: Target) {
    const min = Math.round(speed.min * 100);
    const max = Math.round(speed.max * 100);
    return (
      <div class="afx__control" key="speed">
        <span class="afx__control-label">{speed.label}</span>
        {/*
          No pin, as the Filters sheet's strength has none: the number at the end of the row is the
          readout, and a second one riding the knob chased it across the row. The speed reads as the
          Speed sheet reads it, and as itself even where that sheet has taken it past this slider's
          ends - the knob waits at the end it is past.
        */}
        <ve-slider
          class="afx__slider"
          ctx={this.ctx}
          label={speed.name}
          value={clamp(Math.round(target.speed * 100), min, max)}
          min={min}
          max={max}
          step={1}
          pin="none"
          format={this.formatSpeedSlider}
          onVeLive={this.onSpeed}
        />
        <span class="afx__control-value">{formatSpeed(target.speed)}</span>
      </div>
    );
  }

  /** One of the effect's own sliders, 0 to 100, sticking at its default on the way through. */
  private settingRow(control: SoundEffectControl, target: Target) {
    const value = target.settings[control.key] ?? control.default;
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
      const target = this.target();
      const preset = target ? soundEffectPreset(target.effect) : null;
      return (
        <ve-sheet heading="Audio effects" showNone={!!target} noneLabel="No effect" onVeNone={this.onNone} onVeConfirm={this.onConfirm}>
          {target ? (
            <div class="sheet__content afx" key="effects">
              {/*
                The tiles first and staying put, the sliders under them, as the Filters sheet has its
                strength: choosing an effect never moves the row the finger is tapping along. Keyed by
                the effect, so another effect's sliders are new sliders, and one being dragged when its
                effect is changed lets its gesture go as it is taken away.
              */}
              <div class="afx__row" key="row">
                {SOUND_EFFECTS.map(each => {
                  const on = target.effect === each.id;
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
              {preset ? (
                <div class="afx__controls" key={`controls-${preset.id}`}>
                  {preset.speed ? this.speedRow(preset.speed, target) : null}
                  {preset.controls.map(control => this.settingRow(control, target))}
                </div>
              ) : null}
            </div>
          ) : (
            <p class="sheet__content afx__empty" key="empty">
              Select a sound first
            </p>
          )}
        </ve-sheet>
      );
    });
  }
}
