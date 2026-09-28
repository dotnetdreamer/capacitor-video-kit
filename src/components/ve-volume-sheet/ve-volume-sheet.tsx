import { computed } from '@preact/signals-core';
import { Component, Prop } from '@stencil/core';

import { closeWhenGone } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { MAX_MUSIC_FADE_MS, MIN_MUSIC_FADE_MS, MUSIC_FADE_MS, MUSIC_FADE_STEP_MS, findClip, findVoiceover, type EditMusic } from '../../editor';
import type { VolumeTarget } from '../../state/editor.types';
import { percentLabel } from '../ve-slider/slider-geometry';
import { durationChip } from '../ve-timeline/timeline-geometry';

/** What unmuting brings a track back to when nothing better is known. */
const DEFAULT_RESTORE_VOLUME = 0.8;

/**
 * Volume for whatever the store's `volumeTarget` names - a clip segment, the music or a voiceover
 * take - as a mute button beside a percentage slider. The music also gets a switch each for its fade
 * in and fade out, with a slider for the fade's length under a switch that is on; no engine fades a
 * voiceover or a clip.
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
    const changed = store.commit('Volume for all', m =>
      m.clips.every(c => c.volume === volume && c.muted === muted) ? m : { ...m, clips: m.clips.map(c => ({ ...c, volume, muted })) },
    );
    store.showToast(changed ? 'Volume applied to all clips' : 'All clips already have this volume');
    if (changed) store.haptic('light');
  };

  private readonly toggleFadeIn = () => this.toggleFade('fadeInMs', 'Fade in');
  private readonly toggleFadeOut = () => this.toggleFade('fadeOutMs', 'Fade out');

  /** Inside the fade slider's gesture, which the slider opened and names. */
  private readonly onFadeInLive = (event: CustomEvent<number>) => this.ctx.store.previewMusic({ fadeInMs: event.detail });
  private readonly onFadeOutLive = (event: CustomEvent<number>) => this.ctx.store.previewMusic({ fadeOutMs: event.detail });

  /**
   * The length each fade had when it was last switched off, so switching it back on while the sheet
   * is open brings back what was set rather than the default.
   */
  private readonly restoreFade = { fadeInMs: MUSIC_FADE_MS, fadeOutMs: MUSIC_FADE_MS };

  /**
   * A fade on or off, on at the length it had before. Read at tap time, not from the render, so a
   * double tap between frames still flips it twice - the rule the toolbar's Loop keeps.
   */
  private toggleFade(field: 'fadeInMs' | 'fadeOutMs', name: string): void {
    const { store } = this.ctx;
    const music = store.manifest.value.music;
    if (!music) return;
    const current = music[field] ?? 0;
    if (current > 0) this.restoreFade[field] = current;
    const ms = current > 0 ? 0 : this.restoreFade[field];
    store.commitMusic(field === 'fadeInMs' ? { fadeInMs: ms } : { fadeOutMs: ms }, current > 0 ? `${name} off` : `${name} on`);
    store.haptic('light');
  }

  /**
   * One fade: a switch row that reads its length while it is on, and the slider that sets that
   * length under it. The whole row is the switch, so the target is the full width rather than the
   * small track.
   *
   * The length is in the switch's NAME as well as on screen, for two reasons. A slider reaches the
   * A13's WebView tree with no name or value at all, so the row is the one place a test can read
   * what the slider was dragged to. And on that WebView a changed `aria-checked` inside a shadow root
   * is not passed on while a changed name is, so the name is also what says the fade is on.
   */
  private fade(label: string, ms: number, onToggle: () => void, onLive: (event: CustomEvent<number>) => void) {
    const on = ms > 0;
    const length = durationChip(ms);
    return (
      <div class="vol__fade-group">
        <button type="button" role="switch" class="vol__fade" aria-checked={String(on)} aria-label={on ? `${label} ${length}` : label} onClick={onToggle}>
          <span class="vol__fade-label">{label}</span>
          {on ? <span class="vol__fade-value">{length}</span> : null}
          <span class={{ 'vol__switch': true, 'vol__switch--on': on }} aria-hidden="true">
            <span class="vol__switch-knob"></span>
          </span>
        </button>
        {on ? (
          <ve-slider
            class="vol__fade-slider"
            ctx={this.ctx}
            value={ms}
            min={MIN_MUSIC_FADE_MS}
            max={MAX_MUSIC_FADE_MS}
            step={MUSIC_FADE_STEP_MS}
            label={`${label} duration`}
            // The row above already reads the length, and two numbers chasing each other is noise.
            pin="none"
            format={durationChip}
            onVeLive={onLive}
          ></ve-slider>
        ) : null}
      </div>
    );
  }

  render() {
    return this.watcher.run(() => {
      const { store } = this.ctx;
      const target = store.volumeTarget.value;
      const level = this.level.value;
      const muted = level === 0;
      // Only a clip has siblings to be given its level, and only when there is more than one.
      const canApplyToAll = target?.kind === 'clip' && store.manifest.value.clips.length > 1;
      const music: EditMusic | null = target?.kind === 'music' ? store.manifest.value.music : null;

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

              {music ? (
                <div class="vol__fades">
                  {this.fade('Fade in', music.fadeInMs ?? 0, this.toggleFadeIn, this.onFadeInLive)}
                  {this.fade('Fade out', music.fadeOutMs, this.toggleFadeOut, this.onFadeOutLive)}
                </div>
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
