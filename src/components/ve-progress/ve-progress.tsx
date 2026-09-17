import { Component, Host, Prop } from '@stencil/core';

import { clamp } from '../../editor';

/**
 * The bar the editor shows while the native composer builds the video.
 *
 * It is `ion-progress-bar`'s shape without Ionic, kept deliberately close to it so the render card
 * around it is a straight port: a `value` in 0..1 and a `type` that is either `determinate` or
 * `indeterminate`. The two colours it exposes are the same two Ionic exposed, renamed off Ionic's
 * generic `--background` and `--progress-background` so a host setting one of those on the editor
 * cannot reach in here by accident.
 *
 * It holds no state and reads nothing from the store. The number belongs to whoever is running the
 * render: `EditorRenderHost.render` reports it, the shell writes it into a signal, and the shell
 * also decides which of the two states the bar is in, because that decision is about the render and
 * not about the bar. The editor's rule is `progress > 0 ? 'determinate' : 'indeterminate'`, so the
 * bar sweeps for as long as the encoder has said nothing at all.
 *
 * There is no cancel and no phase here, because the composer has neither. Its `progress` event
 * carries `{ jobId, progress }` and nothing else: no stage, no step, no estimate. Cancelling is the
 * shell's `AbortController`, which reaches the render through the host rather than through a button
 * on the bar, and the overlay the bar sits in offers no way to stop a render today.
 */
@Component({
  tag: 've-progress',
  styleUrl: 've-progress.css',
  shadow: true,
})
export class VeProgress {
  /**
   * How much is done, as a fraction of one.
   *
   * Clamped, and a number that is not finite is read as nothing done, because these numbers cross
   * the bridge from a native encoder and nothing between there and here checks them. Both engines
   * already clamp to 0.99 and only ever emit on a one per cent step, but the clamp is what keeps a
   * host's own arithmetic honest: `scaleX(NaN)` is an invalid declaration, which drops the whole
   * transform and paints a bar that reads as finished.
   */
  @Prop() value = 0;

  /**
   * Whether the number means anything yet. `indeterminate` sweeps a stripe instead of filling, for
   * the part of a render that reports nothing: the spec is rasterised, the job is queued, and on
   * iOS the export sits in `.pending` and `.waiting` states that carry no number at all.
   */
  @Prop() type: 'determinate' | 'indeterminate' = 'determinate';

  /**
   * What a screen reader announces the bar as. A `progressbar` with no name is announced as a
   * number with nothing attached to it, so the shell passes the sentence its own card is showing
   * and the two are heard as one thing.
   */
  @Prop() label = 'Progress';

  render() {
    const busy = this.type === 'indeterminate';
    const amount = Number.isFinite(this.value) ? clamp(this.value, 0, 1) : 0;

    return (
      <Host
        role="progressbar"
        aria-label={this.label}
        aria-valuemin="0"
        /*
         * Announced as a whole per cent over 0..100 rather than as a fraction over 0..1, which is
         * the same range the card's own figure is rounded to. Screen readers disagree about whether
         * a maximum of 1 is a percentage or a count, and the one thing that must not happen is the
         * bar saying 0.42 while the text beside it says 42%.
         */
        aria-valuemax="100"
        aria-valuenow={busy ? null : String(Math.round(amount * 100))}
        /* With no figure to announce, this is what tells a screen reader the bar is working at all. */
        aria-busy={busy ? 'true' : null}
      >
        <div
          class={{ fill: true, 'fill--busy': busy }}
          /*
           * A custom property rather than an inline `transform`, so the stylesheet owns what each
           * state looks like: an inline transform would beat the sweep's parked position under
           * reduced motion. The dash in the name is what makes Stencil write it with
           * `setProperty`; camel-cased it would be set as an unknown key of `style` and do nothing.
           */
          style={{ '--ve-progress-scale': String(amount) }}
        ></div>
      </Host>
    );
  }
}
