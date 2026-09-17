import { Component, Prop } from '@stencil/core';

import { closeWhenGone } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { percentLabel } from '../ve-slider/slider-geometry';

/**
 * Opacity of the selected layer - or, for an effect layer, its strength, which the manifest keeps in
 * the same field. There is no swatch: the preview above already shows the layer changing.
 *
 * The name is worked out once and handed over twice, to the frame as its heading and to the slider
 * as its label, because the slider's label is what the undo step is called: a customer who dragged
 * a vignette's strength should be offered "Undo Strength" and not "Undo Opacity".
 */
@Component({
  tag: 've-opacity-sheet',
  styleUrls: ['../sheet-common.css', 've-opacity-sheet.css'],
  shadow: true,
})
export class VeOpacitySheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);
  private stopClosing?: () => void;

  connectedCallback() {
    // Undo can remove the layer, and a deselect leaves nothing to adjust; either way the sheet goes.
    // Deferred, because closing the panel unmounts this element and the effect would otherwise be
    // doing that from inside the undo that emptied the selection.
    this.stopClosing = closeWhenGone(
      () => !this.ctx.store.selectedOverlay.value,
      () => this.ctx.store.closePanel(),
    );
  }

  disconnectedCallback() {
    this.stopClosing?.();
    this.watcher.stop();
  }

  private readonly onConfirm = () => this.ctx.store.closePanel();

  /** Inside the slider's gesture. */
  private readonly onLive = (event: CustomEvent<number>) => {
    const layer = this.ctx.store.selectedOverlay.value;
    if (!layer) return;
    const opacity = event.detail / 100;
    // A value the layer already holds is not a change: the store would refuse the patch as well,
    // and the comparison is where the slider's whole percent meets the manifest's fraction.
    if (opacity !== layer.opacity) this.ctx.store.previewOverlay(layer.id, { opacity });
  };

  render() {
    return this.watcher.run(() => {
      const layer = this.ctx.store.selectedOverlay.value;
      const name = layer?.kind === 'effect' ? 'Strength' : 'Opacity';

      return (
        <ve-sheet heading={name} onVeConfirm={this.onConfirm}>
          {layer ? (
            <div class="sheet__content">
              <ve-slider ctx={this.ctx} value={Math.round(layer.opacity * 100)} label={name} format={percentLabel} onVeLive={this.onLive}></ve-slider>
            </div>
          ) : null}
        </ve-sheet>
      );
    });
  }
}
