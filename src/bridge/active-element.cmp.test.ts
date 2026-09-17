import { afterEach, describe, expect, it } from 'vitest';

import { activeElementDeep } from './active-element';

/*
 * The one thing the mock DOM cannot show, because it has no focus at all: what a real browser
 * actually answers when a field inside a shadow root has the caret. Everything the helper exists
 * for is in the first assertion of the first test.
 */

function shadowHost(tag: string, parent: Node = document.body, init: ShadowRootInit = { mode: 'open' }): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(tag);
  parent.appendChild(host);
  return { host, root: host.attachShadow(init) };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('activeElementDeep', () => {
  it('reaches the field inside a component, where document.activeElement stops at the host', () => {
    const { host, root } = shadowHost('ve-text-sheet');
    const field = document.createElement('textarea');
    root.appendChild(field);
    field.focus();

    expect(document.activeElement).toBe(host);
    expect(activeElementDeep()).toBe(field);
  });

  it('goes all the way down, however many components are nested', () => {
    const outer = shadowHost('ve-editor');
    const middle = shadowHost('ve-sticker-sheet', outer.root);
    const inner = shadowHost('ve-sheet', middle.root);
    const search = document.createElement('input');
    inner.root.appendChild(search);
    search.focus();

    expect(activeElementDeep()).toBe(search);
    expect(activeElementDeep(middle.root)).toBe(search);
  });

  it('stops at a host that holds the focus itself', () => {
    const { host, root } = shadowHost('ve-toolbar');
    root.appendChild(document.createElement('button'));
    host.tabIndex = 0;
    host.focus();

    expect(activeElementDeep()).toBe(host);
  });

  it('stops at the host of a closed root, which cannot be asked', () => {
    const { host, root } = shadowHost('ve-closed', document.body, { mode: 'closed' });
    const field = document.createElement('input');
    root.appendChild(field);
    field.focus();

    expect(host.shadowRoot).toBe(null);
    expect(activeElementDeep()).toBe(host);
  });

  it('hands back the field itself, and not the host standing in for it', () => {
    const { root } = shadowHost('ve-sticker-sheet');
    const search = document.createElement('input');
    root.appendChild(search);
    search.focus();

    const active = activeElementDeep();
    expect(active).toBe(search);

    // Measured, because it decides how much of the port this helper is really for: blurring the
    // host clears this too, a host whose tree holds the focus being in the focus chain itself. So
    // the two sheets that only ever blur would have crossed the boundary by luck, and what does not
    // survive it is a comparison. One helper for both, rather than a rule about which is which.
    if (active instanceof HTMLElement) active.blur();
    expect(root.activeElement).toBe(null);
    expect(document.activeElement).toBe(document.body);
  });

  it('answers with the body when nothing has been focused', () => {
    expect(activeElementDeep()).toBe(document.body);
  });
});
