import { Component, Element, Event, type EventEmitter, Host, Prop } from '@stencil/core';

import { activeElementDeep } from '../../bridge/active-element';
import type { AlertButton } from './alert.types';

/**
 * The editor's confirmation, for a host that has no dialog of its own.
 *
 * The package asks the customer two questions - discard the edits on the way out, and what to do
 * when a render failed - and both of them went to Ionic's `AlertController` in the app. A host
 * application usually has a dialog already, one that looks like the rest of it, so
 * `EditorPlatformHost.confirm` is where the question goes when there is one. This is what happens
 * when there is not: a browser, a host that has not wired one up, and the dev harness. [EditorConfirm]
 * in `editor-confirm.ts` is the piece that decides between the two, and it is the only thing that
 * should be putting this element on the screen.
 *
 * Deliberately not `<dialog>`. `showModal()` gives a focus trap, a backdrop and top layer paint for
 * free, and it is iOS 15.4 and up; this package ships to phones older than that. There `<dialog>` is an
 * element the browser has never heard of: it lays out as an ordinary block wherever the shell put
 * it, `showModal` is not a function, and what the customer gets is the question printed into the
 * editor with nothing modal about it. So the backdrop, the focus and the escape key are done by
 * hand here, which works the same on every phone the app runs on.
 *
 * It takes no `ctx`: it reads nothing from the store and changes nothing in it. Every other
 * component in the editor takes one because every other component is part of the edit; this one is
 * a question with two buttons, and the answer goes back to whoever asked through `veDismiss`.
 */
@Component({
  tag: 've-alert',
  styleUrl: 've-alert.css',
  shadow: true,
})
export class VeAlert {
  @Element() el!: HTMLElement;

  /** The question, in a few words. */
  @Prop() header!: string;

  /** What answering either way will do. Both of the editor's own say what is kept, not what is lost. */
  @Prop() message!: string;

  /**
   * The answers, in the order they are shown. Empty by default rather than required, because a
   * missing list would otherwise throw inside `render` and take the whole editor down with it; an
   * alert with no buttons is still readable and the backdrop still dismisses it.
   */
  @Prop() buttons: readonly AlertButton[] = [];

  /**
   * The `role` of the button that was pressed, or null for a dismissal: a press on the backdrop or
   * the escape key. The editor's back press is the third way out and does not come through here -
   * the shell settles its own question directly, the way it used to dismiss the Ionic alert.
   *
   * Null is an answer rather than an error. Both callers read it as "neither of those": stay in the
   * editor, keep the edits, post nothing.
   */
  @Event() veDismiss!: EventEmitter<string | null>;

  private panel?: HTMLElement;
  private returnFocusTo: Element | null = null;
  private answered = false;

  connectedCallback() {
    // Read before the dialog takes the focus, and only the first time: Stencil moving the element
    // in the vdom disconnects and reconnects it, and a second reading would name a button inside
    // this alert as the place to put the focus back.
    this.returnFocusTo ??= activeElementDeep();
  }

  componentDidLoad() {
    // The panel rather than the first button. It carries the question and the message as its
    // accessible name and description, so a screen reader reads what is being asked before it
    // reads the first way of answering it.
    this.panel?.focus();
  }

  disconnectedCallback() {
    const previous = this.returnFocusTo;
    // A dismissed dialog hands the focus back to whatever had it, which on a phone is the toolbar
    // button that started this. Skipped when that element has gone too, because the whole editor
    // being torn down is the other way this element leaves the document.
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }

  /**
   * Answers once and never again. Two buttons pressed in the same frame, or an escape landing after
   * a press while the element is still on its way out, would otherwise send a second and
   * contradictory answer to a caller that has already acted on the first.
   */
  private readonly answer = (role: string | null) => {
    if (this.answered) return;
    this.answered = true;
    this.veDismiss.emit(role);
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      // Stopped here so it reaches neither the host page nor the editor's own back handler, which
      // would dismiss this dialog a second time on the way past.
      event.preventDefault();
      event.stopPropagation();
      this.answer(null);
      return;
    }
    if (event.key !== 'Tab' || !this.panel) return;

    // A modal that lets the tab key walk out of it leaves the customer answering a question they
    // cannot see. Everything focusable in here is a button, so the trap is the two ends of that row
    // joined up; the panel itself is the third position, held only until the first tab.
    const buttons = [...this.panel.querySelectorAll('button')];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!first) return;

    const active = activeElementDeep(this.el.shadowRoot ?? document);
    if (event.shiftKey && (active === first || active === this.panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  private readonly keepPanel = (el?: HTMLElement) => {
    this.panel = el;
  };

  render() {
    return (
      <Host>
        <div class="alert__backdrop" onClick={() => this.answer(null)}></div>
        <div
          class="alert__panel"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="alert-header"
          aria-describedby="alert-message"
          tabindex={-1}
          ref={this.keepPanel}
          onKeyDown={this.onKeyDown}
        >
          <div class="alert__text">
            <h2 class="alert__header" id="alert-header">
              {this.header}
            </h2>
            <p class="alert__message" id="alert-message">
              {this.message}
            </p>
          </div>
          <div class="alert__buttons">
            {this.buttons.map(button => (
              <button
                key={button.role}
                type="button"
                class={{
                  'alert__btn': true,
                  'alert__btn--danger': button.role === 'destructive',
                  'alert__btn--quiet': button.role === 'cancel',
                }}
                onClick={() => this.answer(button.role)}
              >
                {button.text}
              </button>
            ))}
          </div>
        </div>
      </Host>
    );
  }
}
