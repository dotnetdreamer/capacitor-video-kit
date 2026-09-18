import { Component, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { CROP_PRESETS, cropForAspect, presetFor, type CropPreset } from '../../state/clip-framing';

/** The square every chip fits its box inside. The stylesheet holds the same number, as the grid row. */
const SHAPE_PX = 44;

/**
 * TikTok's Crop sheet: a row of ratios, and the picture itself moved and pinched on the preview
 * above - which is where a crop is actually done. The sheet holds only the decisions a finger
 * cannot make for itself.
 *
 * A ratio is a shape for the FINISHED picture, not for the part of the source that is kept: "1:1"
 * on a landscape video is a tall, narrow slice of it, and on a portrait one it is a short, wide
 * one. The arithmetic for that lives in [cropForAspect], next to the rest of the framing maths the
 * preview and the render agree on, so this component only ever hands a rectangle to the store.
 *
 * Every tap here is one undo step. The pan and the pinch are one step per gesture, recorded by
 * `OverlayGestures` - the same rule that has always held for a layer being dragged.
 *
 * What the Angular component kept in five computeds are five locals in `render`. Two signals stand
 * behind all of them, the render reads both, and `SignalWatcher` installs a fresh effect over
 * exactly what the last paint read: a value nothing but the render asks for has nothing to gain
 * from being remembered between paints.
 */
@Component({
  tag: 've-crop-sheet',
  styleUrls: ['../sheet-common.css', 've-crop-sheet.css'],
  shadow: true,
})
export class VeCropSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  disconnectedCallback() {
    this.watcher.stop();
  }

  /*
   * One stable function each rather than a fresh arrow per render, because a new value is a changed
   * value to the vdom and the listener would be taken off and put back on every repaint.
   */
  private readonly reset = () => {
    const clip = this.ctx.store.cropClip.value;
    if (clip) this.ctx.store.resetClipFraming(clip.id);
  };

  private readonly close = () => this.ctx.store.closePanel();

  private pick(preset: CropPreset): void {
    const store = this.ctx.store;
    const clip = store.cropClip.value;
    const aspect = store.sourceAspect.value;
    if (!clip || !(aspect > 0)) return;
    const crop = cropForAspect(aspect, preset.aspect, clip.crop);
    // Free on an uncropped clip is the whole frame again, which the store recognises as no change
    // and does not record: the customer gets no undo step for a tap that did nothing.
    store.commitClipFraming(clip.id, { crop }, `Crop ${preset.label}`);
    store.haptic('selection');
  }

  render() {
    return this.watcher.run(() => {
      const store = this.ctx.store;
      /** The segment being cropped: whatever is selected, or the one under the playhead. */
      const clip = store.cropClip.value;
      /**
       * The source's shape. Zero until the `<video>` element has its metadata, which is a moment at
       * the start of the very first clip; the ratios are dimmed until then rather than computed
       * against a shape nobody knows, which would cut the wrong part of the picture.
       */
      const sourceAspect = store.sourceAspect.value;
      const ready = sourceAspect > 0 && !!clip;
      const activeId = presetFor(sourceAspect, clip?.crop);
      /** Whether there is anything to reset: a crop, a rectangle, or a fit of this clip's own. */
      const framed = !!clip && (!!clip.crop || !!clip.rect || clip.fit !== undefined);
      /**
       * The biggest box of the finished picture's shape that fits the chip's 44px square. Free keeps
       * the source's own shape, which crops nothing.
       *
       * In pixels, and worked out here, because the stylesheet cannot say it: the Angular sheet put
       * the ratio on a box that already had a width and a height, which makes a browser ignore the
       * ratio, so all five chips are squares today. Leaving one axis to a `max-` clamp instead only
       * moves the problem, since the clamp does not travel back through the ratio.
       */
      const boxOf = (preset: CropPreset): { width: string; height: string } => {
        const aspect = preset.aspect ?? (sourceAspect || 1);
        return {
          width: `${Math.round(aspect >= 1 ? SHAPE_PX : SHAPE_PX * aspect)}px`,
          height: `${Math.round(aspect >= 1 ? SHAPE_PX / aspect : SHAPE_PX)}px`,
        };
      };

      return (
        // The frame's own button is called "None", which here would tell a screen reader nothing
        // about what it does. Angular had no input for that and waited a frame to rewrite the
        // rendered attribute by hand; the frame takes the word itself now.
        <ve-sheet heading="Crop" showNone={true} noneLabel="Reset" onVeNone={this.reset} onVeConfirm={this.close}>
          <div class="sheet__content cs">
            <div class="cs__ratios" role="group" aria-label="Crop ratio">
              {CROP_PRESETS.map(preset => (
                <button
                  type="button"
                  key={preset.id}
                  class={{ 'cs__ratio': true, 'cs__ratio--on': preset.id === activeId }}
                  disabled={!ready}
                  // A string on purpose: the vdom removes an attribute set to boolean false, and a
                  // chip with no `aria-pressed` at all is announced as a plain button.
                  aria-pressed={String(preset.id === activeId)}
                  onClick={() => this.pick(preset)}
                >
                  {/*
                    The box is the shape the finished picture comes out at, so the row can be read
                    at a glance without anyone having to work out what a ratio does to a landscape
                    video.
                  */}
                  <span class="cs__shape" style={boxOf(preset)}></span>
                  <span class="cs__ratio-label">{preset.label}</span>
                </button>
              ))}
            </div>

            <p class="cs__hint">
              <ve-icon name="crop-outline"></ve-icon>
              {framed ? 'Drag an edge to crop a side, or drag and pinch the video' : 'Drag an edge to crop a side, or pick a shape'}
            </p>
          </div>
        </ve-sheet>
      );
    });
  }
}
