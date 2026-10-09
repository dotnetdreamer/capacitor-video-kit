import { Component, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { SOUND_EFFECTS } from '../../editor';
import type { SoundEffectTarget } from '../../state/editor.types';

import { SOUND_EFFECT_ICONS } from './effect-icons';

/**
 * What the sheet is putting through an effect, and the effect it has now: the selected sound on a
 * lane, or an older edit's one sound. Read off the selection, which is safe because `select` closes
 * this sheet whenever the selection changes - the two cannot come to disagree.
 */
type Target = SoundEffectTarget & { effect: string | null };

/**
 * Effects for the selected sound: the head's "none" takes the effect off, as the Filters sheet's
 * does, and a row of tiles under it puts one on - a megaphone today. Each tap is one undo step and
 * applies at once; the preview plays the sound through it as soon as `EditorMedia` has made the copy
 * it plays from, playing or not, so the customer hears the choice by pressing Play, which a compact
 * sheet leaves in reach.
 */
@Component({
  tag: 've-audio-effects-sheet',
  styleUrls: ['../sheet-common.css', 've-audio-effects-sheet.css'],
  shadow: true,
})
export class VeAudioEffectsSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  disconnectedCallback() {
    this.watcher.stop();
  }

  /** What the sheet is about now; see [Target]. Null when no sound is selected. */
  private target(): Target | null {
    const { store } = this.ctx;
    const audio = store.selectedAudio.value;
    if (audio) return { kind: 'audio', id: audio.id, effect: audio.effect ?? null };
    const music = store.musicSelected.value ? store.manifest.value.music : null;
    return music ? { kind: 'music', effect: music.effect ?? null } : null;
  }

  private choose(effectId: string | null): void {
    const target = this.target();
    if (!target || target.effect === effectId) return;
    if (this.ctx.store.setSoundEffect(target, effectId)) this.ctx.store.haptic('selection');
  }

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed prop to
   * Stencil, and the frame would take its listeners off and put them back on every repaint.
   */
  private readonly onNone = () => this.choose(null);

  private readonly onConfirm = () => this.ctx.store.closePanel();

  render() {
    return this.watcher.run(() => {
      const target = this.target();
      return (
        <ve-sheet heading="Audio effects" showNone={!!target} noneLabel="No effect" onVeNone={this.onNone} onVeConfirm={this.onConfirm}>
          {target ? (
            <div class="sheet__content afx" key="effects">
              <div class="afx__row">
                {SOUND_EFFECTS.map(preset => {
                  const on = target.effect === preset.id;
                  return (
                    <button
                      type="button"
                      key={preset.id}
                      class={{ 'afx__tile': true, 'afx__tile--on': on }}
                      // A string, because the vdom drops an attribute set to boolean false and a tile
                      // with no `aria-pressed` at all is announced as a plain button.
                      aria-pressed={String(on)}
                      onClick={() => this.choose(preset.id)}
                    >
                      <span class="afx__face">
                        <ve-icon class="afx__icon" name={SOUND_EFFECT_ICONS[preset.id] ?? 'sparkles-outline'}></ve-icon>
                      </span>
                      <span class="afx__label">{preset.label}</span>
                    </button>
                  );
                })}
              </div>
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
