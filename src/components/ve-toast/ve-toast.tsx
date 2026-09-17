import { Component, Host, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';

/**
 * The editor's one line of feedback: a dark pill over the bottom of the stage saying what just
 * happened, or why nothing did.
 *
 * Everything in the editor that has something to say says it through `store.showToast`, and the
 * store owns the message and its life: which sentence, how long it stays (1600ms, or the 2200 and
 * 2400 that a handful of the longer ones ask for), and the rule that a new message replaces the one
 * on screen rather than queueing behind it. This component is the pill and
 * nothing else. It holds no timer, so an editor torn down mid message leaves nothing behind but the
 * store's own timeout, which `store.dispose()` clears.
 *
 * Deliberately not a toast controller. Ionic's presented an element of its own over the whole page,
 * outlived the editor that asked for it, and could not be placed: these messages belong over the
 * video, above the round back and next buttons, and most of them answer a tap that landed on the
 * stage itself.
 *
 * The shell renders one of these and never inside a condition: the element stays and the pill
 * inside it comes and goes. The comment on the `Host` below says what that buys.
 */
@Component({
  tag: 've-toast',
  styleUrl: 've-toast.css',
  shadow: true,
})
export class VeToast {
  /** The editor this pill belongs to. Only `store.toast` is read: the message and its clock are the store's. */
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  disconnectedCallback() {
    this.watcher.stop();
  }

  render() {
    return this.watcher.run(() => {
      const toast = this.ctx.store.toast.value;
      return (
        /*
         * The live region is the element itself, and it is here whether or not there is anything in
         * it: a screen reader announces a change inside a region it was already watching, so a
         * region that arrives with its text already in it is the one thing that may be read out
         * late or not at all. That is what the element being rendered unconditionally buys.
         */
        <Host role="status" aria-live="polite">
          {/*
           * Keyed by the store's own id, so a message arriving while another is still up replaces
           * the element rather than the text and the slide plays again. The id is the only thing
           * that tells two identical sentences apart, which is why the store keeps one.
           */}
          {toast ? (
            <div class="pill" key={toast.id}>
              {toast.text}
            </div>
          ) : null}
        </Host>
      );
    });
  }
}
