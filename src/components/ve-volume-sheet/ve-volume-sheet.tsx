import { computed } from '@preact/signals-core';
import { Component, Prop } from '@stencil/core';

import { closeWhenGone } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { findClip, findVoiceover } from '../../editor';
import type { VolumeTarget } from '../../state/editor.types';
import { percentLabel } from '../ve-slider/slider-geometry';

/** What unmuting brings a track back to when nothing better is known. */
const DEFAULT_RESTORE_VOLUME = 0.8;

/**
 * Volume for whatever the store's `volumeTarget` names - a clip segment, the music or a voiceover
 * take - as a mute button beside a percentage slider.
 *
 * The clips' own sound is not one of the targets: the voiceover sheet and the timeline's speaker
 * switch it in place, which is one tap instead of a sheet.
 *
 * Three kinds of target, one sheet, and only a clip carries a `muted` flag of its own. That is the
 * whole of why `restoreVolume` exists: for the music and a take, muting IS setting the level to
 * zero, and nothing in the manifest remembers where it came from.
 */
@Component({
  tag: 've-volume-sheet',
  styleUrls: ['../sheet-common.css', 've-volume-sheet.css'],
  shadow: true,
})
export class VeVolumeSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);
  private stopClosing?: () => void;

  /**
   * The level before the last mute, so unmuting a track that was muted by dragging it to zero - or
   * by the button, for music and voiceovers, which have no separate muted flag - brings it back.
   */
  private restoreVolume = DEFAULT_RESTORE_VOLUME;

  /**
   * The target's level 0..1, a muted clip reading as silent; null when the target is gone.
   *
   * A computed rather than a method, because the render, the close rule and three handlers all ask
   * the same question and two of them ask it inside a gesture. Its body reads `ctx`, which is not
   * set while the field is being initialised, and is only ever run on a read, which is later.
   */
  private readonly level = computed<number | null>(() => {
    const { store } = this.ctx;
    const target = store.volumeTarget.value;
    const m = store.manifest.value;
    if (!target) return null;
    switch (target.kind) {
      case 'clip': {
        const clip = findClip(m, target.id);
        return clip ? (clip.muted ? 0 : clip.volume) : null;
      }
      case 'music':
        return m.music ? m.music.volume : null;
      case 'voice':
        return findVoiceover(m, target.id)?.volume ?? null;
    }
  });

  connectedCallback() {
    // Where an already quiet target came from, before anything here has had a chance to remember
    // it. The Angular constructor wrapped this read in `untracked`; a read outside an effect body
    // is untracked in preact, so there is nothing left to wrap.
    const level = this.level.value;
    if (level !== null && level > 0) this.restoreVolume = level;

    // An undo can take away the very thing the sheet is adjusting (the music removed, the segment
    // un-split); a volume sheet for nothing just goes. Deferred, because closing the panel unmounts
    // this element, and undeferred that happens inside the undo's own write.
    this.stopClosing = closeWhenGone(
      () => this.level.value === null,
      () => this.ctx.store.closePanel(),
    );
  }

  disconnectedCallback() {
    this.stopClosing?.();
    this.watcher.stop();
  }

  private readonly onConfirm = () => this.ctx.store.closePanel();

  /**
   * The slider's gesture opened: remember where it came from in case it is dragged to silence.
   *
   * This is why `ve-slider` promises `veGestureStart` before the first `veLive`. By the time a live
   * value arrives the level is already on its way to zero, and the way back would be lost.
   */
  private readonly onGestureStart = () => {
    const level = this.level.value;
    if (level !== null && level > 0) this.restoreVolume = level;
  };

  /** Inside the slider's gesture. */
  private readonly onLive = (event: CustomEvent<number>) => {
    const { store } = this.ctx;
    const target = store.volumeTarget.value;
    const level = this.level.value;
    if (!target || level === null) return;
    const volume = event.detail / 100;
    // The slider works in whole percent and the manifest in fractions, so a knob moved within one
    // step would otherwise write a level the target already holds.
    if (volume !== level) store.setVolume(target, volume, true);
  };

  private readonly toggleMute = () => {
    const { store } = this.ctx;
    const target = store.volumeTarget.value;
    const level = this.level.value;
    if (!target || level === null) return;

    switch (target.kind) {
      case 'clip': {
        const clip = findClip(store.manifest.value, target.id);
        if (!clip) return;
        if (clip.muted || clip.volume === 0) {
          // A clip dragged to zero is muted AND at zero; unmuting it to a silent zero would look
          // like the button did nothing.
          const patch = clip.volume > 0 ? { muted: false } : { muted: false, volume: this.restoreVolume };
          store.patchClip(clip.id, patch, 'Unmute');
        } else {
          this.restoreVolume = clip.volume;
          store.patchClip(clip.id, { muted: true }, 'Mute');
        }
        break;
      }

      case 'music':
      case 'voice':
        if (level > 0) {
          this.restoreVolume = level;
          store.setVolume(target, 0, false);
        } else {
          store.setVolume(target, this.restoreVolume, false);
        }
        break;
    }
    store.haptic('light');
  };

  /** Gives every segment the selected one's level and mute, as one step. */
  private readonly applyToAll = () => {
    const { store } = this.ctx;
    const target = store.volumeTarget.value;
    if (target?.kind !== 'clip') return;
    const clip = findClip(store.manifest.value, target.id);
    if (!clip) return;
    const { volume, muted } = clip;
    const changed = store.commit('Volume for all', (m) =>
      m.clips.every((c) => c.volume === volume && c.muted === muted)
        ? m
        : { ...m, clips: m.clips.map((c) => ({ ...c, volume, muted })) },
    );
    store.showToast(changed ? 'Volume applied to all clips' : 'All clips already have this volume');
    if (changed) store.haptic('light');
  };

  render() {
    return this.watcher.run(() => {
      const { store } = this.ctx;
      const target = store.volumeTarget.value;
      const level = this.level.value;
      const muted = level === 0;
      // Only a clip has siblings to be given its level, and only when there is more than one.
      const canApplyToAll = target?.kind === 'clip' && store.manifest.value.clips.length > 1;

      return (
        <ve-sheet heading={headingFor(target)} onVeConfirm={this.onConfirm}>
          {target ? (
            <div class="sheet__content">
              <div class="vol__row">
                <button
                  type="button"
                  class={{ 'vol__mute': true, 'vol__mute--on': muted }}
                  // Written as a string on purpose: the vdom removes an attribute set to boolean
                  // false, and a toggle with no `aria-pressed` at all is announced as a plain button.
                  aria-pressed={String(muted)}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  onClick={this.toggleMute}
                >
                  <ve-icon name={muted ? 'volume-mute' : 'volume-high'}></ve-icon>
                </button>

                <ve-slider
                  class="vol__slider"
                  ctx={this.ctx}
                  value={Math.round((level ?? 0) * 100)}
                  label="Volume"
                  format={percentLabel}
                  onVeGestureStart={this.onGestureStart}
                  onVeLive={this.onLive}
                ></ve-slider>
              </div>

              {canApplyToAll ? (
                <button type="button" class="sheet__apply-all" onClick={this.applyToAll}>
                  Apply to all clips
                </button>
              ) : null}
            </div>
          ) : null}
        </ve-sheet>
      );
    });
  }
}

/** The sheet's name, which is the only thing on screen that says which sound is being changed. */
function headingFor(target: VolumeTarget | null): string {
  switch (target?.kind) {
    case 'music':
      return 'Sound volume';
    case 'voice':
      return 'Voiceover volume';
    default:
      return 'Clip volume';
  }
}
