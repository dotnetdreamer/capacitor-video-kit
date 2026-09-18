import { Component, Host, Prop, State } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import {
  OUTPUT_QUALITIES,
  aspectOf,
  estimatedBytes,
  outputFor,
  qualityOf,
  type EditOutput,
  type OutputAspect,
} from '../../editor';
import type { EditorEncodeSupport } from '../../host/host.types';

/** The two shapes, and what each is for. The label is what the chip says. */
const ALL_ASPECTS: readonly { id: OutputAspect; label: string; hint: string }[] = [
  { id: '9:16', label: '9:16', hint: 'Upright' },
  { id: '16:9', label: '16:9', hint: 'Wide' },
];

/**
 * The shape and the size of the finished post: how it stands, how many pixels it is, and how many
 * frames a second - with what that will come to on disk under all three.
 *
 * Every rung is ASKED ABOUT before it is offered. A phone from four years ago has no 4K encoder and
 * a browser without WebCodecs has whatever its recorder will take, so a ladder that offered all of
 * them everywhere would be a promise this package cannot keep: the render fails at the end, after
 * the editing, which is the worst moment to find out. What comes back unsupported is greyed out
 * with the reason beside it, because a disabled chip with nothing to say reads as a broken app.
 *
 * The size is an estimate in the honest sense - an encoder allowed to spend less on a still shot
 * does - and it is worth showing anyway: it is the difference between choosing 4K and understanding
 * what choosing 4K means.
 */
@Component({
  tag: 've-quality-sheet',
  styleUrls: ['../sheet-common.css', 've-quality-sheet.css'],
  shadow: true,
})
export class VeQualitySheet {
  @Prop() ctx!: EditorContext;

  /**
   * What the host said it can encode, by frame. Empty until the answer lands, which is a tick or
   * two on a phone: everything is offered in the meantime rather than greyed out, because a ladder
   * that starts disabled and fills in reads as broken twice over.
   */
  @State() private support: readonly EditorEncodeSupport[] = [];

  private readonly watcher = new SignalWatcher(this);

  connectedCallback() {
    void this.askWhatItCanEncode();
  }

  disconnectedCallback() {
    this.watcher.stop();
  }

  /**
   * Asks the host about every rung at once, in both shapes and at both rates.
   *
   * Both shapes, because an encoder states its limits one way round and a portrait post is the same
   * pixels turned through a right angle - the native probes try both, and asking for exactly the
   * frames that may be chosen is what keeps this honest whatever they do with them.
   */
  private async askWhatItCanEncode(): Promise<void> {
    const render = this.ctx.store.host.render;
    if (!render?.encodeSupport) return;
    const allowed = this.ctx.store.host.output;
    const frames: EditOutput[] = [];
    for (const aspect of allowed.aspects) {
      for (const quality of allowed.qualities) {
        for (const fps of allowed.fps) frames.push(outputFor(aspect, quality, fps));
      }
    }
    try {
      this.support = await render.encodeSupport(frames);
    } catch {
      // A host that cannot answer has said nothing, and nothing is what it was before it was asked.
      this.support = [];
    }
  }

  /** What this device said about one frame, or null for a frame nobody has been asked about. */
  private answerFor(output: EditOutput): EditorEncodeSupport | null {
    return (
      this.support.find(
        (one) => one.width === output.width && one.height === output.height && one.fps === output.fps,
      ) ?? null
    );
  }

  private readonly close = () => this.ctx.store.closePanel();

  private readonly pickAspect = (aspect: OutputAspect) => {
    const store = this.ctx.store;
    const output = store.output.value;
    this.choose(outputFor(aspect, qualityOf(output).id, output.fps), 'Shape');
  };

  private readonly pickQuality = (id: string) => {
    const store = this.ctx.store;
    const output = store.output.value;
    this.choose(outputFor(aspectOf(output), id, output.fps), 'Quality');
  };

  private readonly pickFps = (fps: number) => {
    const store = this.ctx.store;
    const output = store.output.value;
    this.choose(outputFor(aspectOf(output), qualityOf(output).id, fps), 'Frame rate');
  };

  /**
   * Takes the choice, unless this device has said it cannot encode it.
   *
   * The guard is here as well as on the chip's `disabled` because the two are different promises: a
   * disabled chip is what a customer sees, and this is what happens if one is somehow pressed - a
   * keyboard reaching a control the vdom has not caught up with, say.
   */
  private choose(output: EditOutput, label: string): void {
    const answer = this.answerFor(output);
    if (answer && !answer.supported) return;
    this.ctx.store.setOutput(output, label);
    this.ctx.store.haptic('selection');
  }

  render() {
    return this.watcher.run(() => {
      const store = this.ctx.store;
      const output = store.output.value;
      const aspect = aspectOf(output);
      const quality = qualityOf(output);
      const totalMs = store.totalMs.value;
      // What this APP allows, which is a different question from what this DEVICE can encode: one
      // is a product decision and the other is a probe, and a chip has to pass both.
      const allowed = store.host.output;
      const aspects = ALL_ASPECTS.filter((one) => allowed.aspects.includes(one.id));
      const qualities = OUTPUT_QUALITIES.filter((one) => allowed.qualities.includes(one.id));

      // The one rung that is off and has something to say, which is what the line under the row
      // reads. Several unsupported rungs almost always share a reason, so the first is the answer.
      const blocked = qualities
        .map((one) => this.answerFor(outputFor(aspect, one.id, output.fps)))
        .find((answer) => answer && !answer.supported && !!answer.reason);

      return (
        <Host>
          <ve-sheet heading="Quality" onVeConfirm={this.close}>
            <div class="sheet__content qs">
              {aspects.length > 1 ? (
              <div class="qs__row" role="group" aria-label="Shape">
                {aspects.map((one) => (
                  <button
                    key={one.id}
                    type="button"
                    class={{ qs__chip: true, 'qs__chip--on': one.id === aspect }}
                    aria-pressed={String(one.id === aspect)}
                    onClick={() => this.pickAspect(one.id)}
                  >
                    {/* The shape itself, so the row can be read without doing the arithmetic. */}
                    <span class={{ qs__shape: true, 'qs__shape--wide': one.id === '16:9' }} aria-hidden="true"></span>
                    <span class="qs__label">{one.label}</span>
                    <span class="qs__hint">{one.hint}</span>
                  </button>
                ))}
              </div>
              ) : null}

              <div class="qs__row" role="group" aria-label="Resolution">
                {qualities.map((one) => {
                  const answer = this.answerFor(outputFor(aspect, one.id, output.fps));
                  const off = !!answer && !answer.supported;
                  return (
                    <button
                      key={one.id}
                      type="button"
                      class={{ qs__chip: true, 'qs__chip--on': one.id === quality.id && !off }}
                      aria-pressed={String(one.id === quality.id)}
                      disabled={off}
                      // The reason travels with the chip as well as being printed below it, so a
                      // screen reader hears why rather than "dimmed button".
                      title={answer?.reason ?? ''}
                      onClick={() => this.pickQuality(one.id)}
                    >
                      <span class="qs__label">{one.label}</span>
                    </button>
                  );
                })}
              </div>

              {allowed.fps.length > 1 ? (
              <div class="qs__row" role="group" aria-label="Frame rate">
                {allowed.fps.map((fps) => {
                  const answer = this.answerFor(outputFor(aspect, quality.id, fps));
                  const off = !!answer && !answer.supported;
                  return (
                    <button
                      key={fps}
                      type="button"
                      class={{ qs__chip: true, 'qs__chip--on': fps === output.fps && !off }}
                      aria-pressed={String(fps === output.fps)}
                      disabled={off}
                      title={answer?.reason ?? ''}
                      onClick={() => this.pickFps(fps)}
                    >
                      <span class="qs__label">{fps}fps</span>
                    </button>
                  );
                })}
              </div>
              ) : null}

              <p class="qs__size">
                {`${output.width}x${output.height} · about ${megabytes(estimatedBytes(totalMs, output))}`}
              </p>
              {blocked?.reason ? <p class="qs__note">{blocked.reason}</p> : null}
            </div>
          </ve-sheet>
        </Host>
      );
    });
  }
}

/** `98.3 MB`, in the units a customer reads a video in. */
function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}
