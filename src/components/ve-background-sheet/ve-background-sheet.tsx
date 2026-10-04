import { Component, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { BACKGROUND_COLORS, type BackgroundColor } from '../../editor';

/**
 * The colour of the canvas: what shows wherever no video is drawn - around a video made smaller than
 * the frame, in letterbox bars, past the end of the base track. It is what turns two videos placed
 * with room around them into a screenshot-style post.
 *
 * A row of swatches and nothing to place: every tap goes straight to the store as one undo step, and
 * the preview above shows the canvas changing. Black is the first swatch, and choosing it is how the
 * colour is taken off again.
 *
 * The chosen swatch is in its NAME (`White, selected`) and never in `aria-pressed`: on the Samsung
 * A13's WebView (Chrome 99) a change to `aria-pressed` inside a shadow root never reaches Android's
 * accessibility tree, while a change to the name does - the animation sheet made the same move.
 */
@Component({
  tag: 've-background-sheet',
  styleUrls: ['../sheet-common.css', 've-background-sheet.css'],
  shadow: true,
})
export class VeBackgroundSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  disconnectedCallback() {
    this.watcher.stop();
  }

  private readonly onConfirm = () => this.ctx.store.closePanel();

  private pick(swatch: BackgroundColor): void {
    this.ctx.store.setBackground(swatch.colour);
  }

  render() {
    return this.watcher.run(() => {
      // Black for a post with none, which is the first swatch lit.
      const current = this.ctx.store.background.value ?? '#000000';
      return (
        <ve-sheet heading="Canvas" onVeConfirm={this.onConfirm}>
          <div class="sheet__content bg">
            <div class="bg__swatches" role="group" aria-label="Canvas colour">
              {BACKGROUND_COLORS.map(swatch => {
                const on = swatch.colour === current;
                return (
                  <button
                    type="button"
                    key={swatch.colour}
                    class={{ 'bg__swatch': true, 'bg__swatch--on': on }}
                    aria-label={on ? `${swatch.label}, selected` : swatch.label}
                    onClick={() => this.pick(swatch)}
                  >
                    <span class="bg__colour" style={{ background: swatch.colour }}></span>
                  </button>
                );
              })}
            </div>
            <p class="bg__hint">Shows wherever a video does not fill the frame</p>
          </div>
        </ve-sheet>
      );
    });
  }
}
