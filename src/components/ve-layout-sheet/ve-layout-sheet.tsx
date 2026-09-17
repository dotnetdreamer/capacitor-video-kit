import { Component, Host, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { closeWhenGone } from '../../bridge/deferred-effect';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { sameRect, type LayoutPresetId } from '../../editor';
import { percentLabel } from '../ve-slider/slider-geometry';
import { LAYOUT_CHIPS, matchLayoutPreset, type LayoutChip } from './layout-chips';

/**
 * Where the two videos sit on the frame: split screen, a corner inset, or one over the other.
 *
 * A layout is nothing but a pair of rectangles written onto the clips of the two layers - the same
 * `rect` the crop tool already writes, and the same one the native engines already draw - so there
 * is no geometry here at all. The presets hold it, this row shows it, and every tap goes straight
 * to the store as one undo step with the preview above showing the result.
 */
@Component({
  tag: 've-layout-sheet',
  styleUrls: ['../sheet-common.css', 've-layout-sheet.css'],
  shadow: true,
})
export class VeLayoutSheet {
  @Prop() ctx!: EditorContext;

  /** The value above the knob: `80%`, shared with the volume and opacity sliders. */
  private readonly formatPercent = percentLabel;

  private readonly watcher = new SignalWatcher(this);
  private stopClose?: () => void;

  connectedCallback() {
    const { store } = this.ctx;
    // Remove takes the second video off, and so can an undo: there is then nothing left to lay out.
    // Deferred, so the sheet is not unmounting itself part way through the undo that emptied it.
    this.stopClose = closeWhenGone(
      () => !store.videoTrack.value,
      () => store.closePanel(),
    );
  }

  disconnectedCallback() {
    this.stopClose?.();
    this.stopClose = undefined;
    this.watcher.stop();
  }

  private readonly onConfirm = () => this.ctx.store.closePanel();

  private readonly pick = (chip: LayoutChip) => {
    const track = this.ctx.store.videoTrack.value;
    if (track) this.ctx.store.applyLayoutPreset(track.id, chip.id, chip.label);
  };

  /** Inside the slider's gesture, which is why the change is live: one drag, one undo step. */
  private readonly onOpacity = (event: CustomEvent<number>) => {
    const track = this.ctx.store.videoTrack.value;
    if (!track) return;
    const opacity = event.detail / 100;
    if (opacity !== track.opacity) this.ctx.store.setTrackOpacity(track.id, opacity, true);
  };

  private readonly swap = () => {
    const track = this.ctx.store.videoTrack.value;
    if (track) this.ctx.store.swapTrackZ(track.id);
  };

  private readonly remove = () => {
    const track = this.ctx.store.videoTrack.value;
    if (track) this.ctx.store.removeVideoTrack(track.id);
  };

  /**
   * Which preset the two layers are on now.
   *
   * Every clip of a layer carries that layer's rectangle, so the first one answers for the layer and
   * a layer whose clips disagree is on no preset at all.
   */
  private activePreset(): LayoutPresetId | null {
    const { store } = this.ctx;
    const track = store.videoTrack.value;
    if (!track) return null;
    const clips = store.manifest.value.clips;
    const baseRect = clips[0]?.rect ?? null;
    const trackRect = track.clips[0]?.rect ?? null;
    if (clips.some(clip => !sameRect(clip.rect, baseRect))) return null;
    if (track.clips.some(clip => !sameRect(clip.rect, trackRect))) return null;
    return matchLayoutPreset(baseRect, trackRect);
  }

  render() {
    return this.watcher.run(() => {
      const track = this.ctx.store.videoTrack.value;
      const activeId = this.activePreset();

      return (
        <Host>
          <ve-sheet heading="Layout" onVeConfirm={this.onConfirm}>
            {track ? (
              <div class="sheet__content ls">
                <div class="ls__presets" role="group" aria-label="Layout">
                  {LAYOUT_CHIPS.map(chip => (
                    <button
                      type="button"
                      key={chip.id}
                      class={{ 'ls__preset': true, 'ls__preset--on': chip.id === activeId }}
                      // A string, because the vdom drops an attribute set to boolean false and a
                      // chip with no `aria-pressed` at all is announced as a plain button.
                      aria-pressed={String(chip.id === activeId)}
                      onClick={() => this.pick(chip)}
                    >
                      {/*
                        The frame with both rectangles in it, so the row can be read without anyone
                        having to work out what "top left" means to a video that is already on screen.
                      */}
                      <span class="ls__frame" aria-hidden="true">
                        <span class="ls__box ls__box--base" style={{ left: `${chip.base.x}%`, top: `${chip.base.y}%`, width: `${chip.base.w}%`, height: `${chip.base.h}%` }}></span>
                        <span
                          class="ls__box ls__box--track"
                          style={{ left: `${chip.track.x}%`, top: `${chip.track.y}%`, width: `${chip.track.w}%`, height: `${chip.track.h}%` }}
                        ></span>
                      </span>
                      <span class="ls__label">{chip.label}</span>
                    </button>
                  ))}
                </div>

                <ve-slider ctx={this.ctx} value={Math.round(track.opacity * 100)} label="Opacity" format={this.formatPercent} onVeLive={this.onOpacity}></ve-slider>

                <div class="ls__actions">
                  <button type="button" class="ls__action" onClick={this.swap}>
                    <ve-icon name="swap-vertical-outline"></ve-icon>
                    <span>Swap</span>
                  </button>
                  <button type="button" class="ls__action ls__action--danger" onClick={this.remove}>
                    <ve-icon name="trash-outline"></ve-icon>
                    <span>Remove</span>
                  </button>
                </div>
              </div>
            ) : null}
          </ve-sheet>
        </Host>
      );
    });
  }
}
