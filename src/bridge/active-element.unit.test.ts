import { describe, expect, it } from 'vitest';

import { activeElementDeep } from './active-element';

/*
 * The mock DOM has no focus of its own: `document.activeElement` is undefined whatever is focused
 * and a shadow root never reports one. So the walk is what is tested here, over real elements and
 * real shadow roots with the focus bookkeeping staged by hand, and `active-element.cmp.test.ts`
 * proves in Chromium that a browser really does answer the way these fixtures say it does.
 */
type Focusable = { activeElement: Element | null };

function stage(root: Document | ShadowRoot, active: Element | null): void {
  (root as unknown as Focusable).activeElement = active;
}

/** A host with an open shadow root, its own focus staged, appended to the body. */
function shadowHost(tag: string, parent: Node = document.body): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(tag);
  parent.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  stage(root, null);
  return { host, root };
}

describe('activeElementDeep', () => {
  it('reaches the field inside a component, where document.activeElement stops at the host', () => {
    const { host, root } = shadowHost('ve-text-sheet');
    const field = document.createElement('textarea');
    root.appendChild(field);
    stage(document, host);
    stage(root, field);

    expect(document.activeElement).toBe(host);
    expect(activeElementDeep()).toBe(field);
  });

  it('goes all the way down, however many components are nested', () => {
    const outer = shadowHost('ve-editor');
    const middle = shadowHost('ve-sticker-sheet', outer.root);
    const inner = shadowHost('ve-sheet', middle.root);
    const search = document.createElement('input');
    inner.root.appendChild(search);

    stage(document, outer.host);
    stage(outer.root, middle.host);
    stage(middle.root, inner.host);
    stage(inner.root, search);

    expect(activeElementDeep()).toBe(search);
  });

  it('stops at a host that is focused itself', () => {
    const { host, root } = shadowHost('ve-toolbar');
    root.appendChild(document.createElement('button'));
    stage(document, host);

    // A host carrying a tabindex, or one whose root delegates focus, reports nothing focused inside
    // it. Ending the walk on the host is then the true answer and not a case to guard against.
    expect(activeElementDeep()).toBe(host);
  });

  it('answers with a plain focused element untouched', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    stage(document, button);

    expect(activeElementDeep()).toBe(button);
  });

  it('answers with nothing when nothing is focused', () => {
    stage(document, null);
    expect(activeElementDeep()).toBe(null);
  });

  it('starts wherever it is asked to, for a component that only cares about its own root', () => {
    const sheet = shadowHost('ve-effects-sheet');
    const nested = shadowHost('ve-sheet', sheet.root);
    const search = document.createElement('input');
    nested.root.appendChild(search);

    stage(document, sheet.host);
    stage(sheet.root, nested.host);
    stage(nested.root, search);

    expect(activeElementDeep(sheet.root)).toBe(search);
    expect(activeElementDeep(nested.root)).toBe(search);
  });
});
