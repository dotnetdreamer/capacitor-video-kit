import { render, waitForStable, describe, it, expect } from '@stencil/vitest';

import { activeElementDeep } from '../../bridge/active-element';
import type { AlertButton } from './alert.types';
import { DISCARD_EDITS } from './editor-confirm';

/**
 * A browser test, because what this component is for is focus and keys. The mock DOM has no focus
 * at all, so it answers yes to a dialog that never took it and yes to one that never gave it back,
 * and the customer is the one who finds out.
 *
 * Written against markup rather than JSX so that it compiles before anything has generated
 * `components.d.ts` for this tag.
 */

/** The element as the shell drives it: two attributes and one list set as a property. */
type AlertElement = HTMLElement & { header: string; message: string; buttons: readonly AlertButton[] };

interface Opened {
  root: AlertElement;
  panel: HTMLElement;
  buttons: HTMLElement[];
  answers: (string | null)[];
}

async function open(buttons: readonly AlertButton[] = DISCARD_EDITS.buttons): Promise<Opened> {
  const { root, setProps } = await render<AlertElement>(`<ve-alert header="${DISCARD_EDITS.header}" message="${DISCARD_EDITS.message}"></ve-alert>`);
  await setProps({ buttons });

  const answers: (string | null)[] = [];
  root.addEventListener('veDismiss', event => answers.push((event as CustomEvent<string | null>).detail));

  return {
    root,
    panel: root.shadowRoot!.querySelector<HTMLElement>('.alert__panel')!,
    buttons: [...root.shadowRoot!.querySelectorAll<HTMLElement>('.alert__btn')],
    answers,
  };
}

describe('ve-alert', () => {
  it('asks the question and answers with the role of the button pressed', async () => {
    const { root, panel, buttons, answers } = await open();

    expect(panel.getAttribute('role')).toBe('alertdialog');
    expect(root.shadowRoot!.querySelector('.alert__header')!.textContent).toBe('Discard edits?');
    expect(buttons.map(button => button.textContent)).toEqual(['Keep editing', 'Discard']);

    buttons[1].click();

    expect(answers).toEqual(['destructive']);
  });

  it('reads the question out before the answers, which is what focusing the panel is for', async () => {
    const { panel } = await open();

    expect(activeElementDeep()).toBe(panel);
    expect(panel.getAttribute('aria-labelledby')).toBe('alert-header');
    expect(panel.getAttribute('aria-describedby')).toBe('alert-message');
  });

  it('answers null when the backdrop is pressed, which is neither of the two things offered', async () => {
    const { root, answers } = await open();

    root.shadowRoot!.querySelector<HTMLElement>('.alert__backdrop')!.click();

    expect(answers).toEqual([null]);
  });

  it('answers null on escape, and keeps the press to itself', async () => {
    const { panel, answers } = await open();
    const reachedThePage: string[] = [];
    const listener = (event: KeyboardEvent) => reachedThePage.push(event.key);
    document.addEventListener('keydown', listener);

    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    document.removeEventListener('keydown', listener);

    expect(answers).toEqual([null]);
    // The editor's own back handler is on the page. Left to bubble, it would close this dialog a
    // second time and then go on to close whatever is behind it.
    expect(reachedThePage).toEqual([]);
  });

  it('answers once however many times it is pressed', async () => {
    const { buttons, answers } = await open();

    buttons[0].click();
    buttons[1].click();

    expect(answers).toEqual(['cancel']);
  });

  it('keeps the tab key inside the dialog, at both ends', async () => {
    const { panel, buttons } = await open();
    const tab = (shiftKey: boolean) => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }));

    // Backwards out of the panel it was given on the way in, which is the first press a customer
    // reaching for the keyboard makes.
    tab(true);
    expect(activeElementDeep()).toBe(buttons[1]);

    tab(false);
    expect(activeElementDeep()).toBe(buttons[0]);
  });

  it('marks the answer that cannot be undone', async () => {
    const { buttons } = await open();

    expect(getComputedStyle(buttons[1]).color).not.toBe(getComputedStyle(buttons[0]).color);
  });

  it('hands the focus back to whatever had it, which is the button that asked', async () => {
    const { root: opener } = await render<HTMLElement>('<button>Delete</button>');
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await customElements.whenDefined('ve-alert');
    const alert = document.createElement('ve-alert') as AlertElement;
    alert.header = DISCARD_EDITS.header;
    alert.message = DISCARD_EDITS.message;
    alert.buttons = DISCARD_EDITS.buttons;
    opener.parentElement!.append(alert);
    await waitForStable(alert);

    expect(activeElementDeep()).toBe(alert.shadowRoot!.querySelector('.alert__panel'));

    alert.remove();

    expect(document.activeElement).toBe(opener);
  });
});
