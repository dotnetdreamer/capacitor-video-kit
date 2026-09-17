import { render, describe, it, expect } from '@stencil/vitest';

import { EDITOR_ICONS, type EditorIconName } from '../../icons/icons';

/**
 * A browser test rather than a unit test. Three of the five things this component promises - the
 * one em box, a transform applied from outside, and an SVG that actually parsed - are questions
 * about layout and about the browser's own parser, and the mock DOM answers all three yes whatever
 * the component does.
 */

/** What the browser makes of a shape's markup, so an assertion compares two parsed trees. */
function parsed(name: EditorIconName): string {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.innerHTML = EDITOR_ICONS[name];
  return svg.innerHTML;
}

function glyph(icon: HTMLElement): string {
  return icon.shadowRoot!.querySelector('svg')!.innerHTML;
}

describe('ve-icon', () => {
  it('draws the shape it was named and stays out of the accessibility tree', async () => {
    const { root } = await render(<ve-icon name="play"></ve-icon>);

    expect(glyph(root)).toBe(parsed('play'));
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.shadowRoot!.querySelectorAll('svg')).toHaveLength(1);
  });

  it('announces itself once it is given a label', async () => {
    const { root } = await render(<ve-icon name="trash-outline" label="Delete"></ve-icon>);

    expect(root.getAttribute('role')).toBe('img');
    expect(root.getAttribute('aria-label')).toBe('Delete');
    expect(root.hasAttribute('aria-hidden')).toBe(false);
  });

  it('is sized by the font size it inherits, which is how every stylesheet in the editor sizes one', async () => {
    const { root } = await render(
      <div style={{ fontSize: '26px' }}>
        <ve-icon name="musical-note"></ve-icon>
      </div>,
    );
    const icon = root.querySelector<HTMLElement>('ve-icon')!;

    expect(icon.getBoundingClientRect().width).toBeCloseTo(26, 1);
    expect(icon.shadowRoot!.querySelector('svg')!.getBoundingClientRect().height).toBeCloseTo(26, 1);
  });

  it('takes a transform from outside, which is what keeps a handle glyph upright', async () => {
    const { root } = await render(
      <div style={{ fontSize: '20px' }}>
        <ve-icon name="resize-outline"></ve-icon>
      </div>,
    );
    const icon = root.querySelector<HTMLElement>('ve-icon')!;

    icon.style.transform = 'scale(2)';

    // The painted box doubles while the layout box does not, which only happens if the transform
    // reached an element that can be transformed at all.
    expect(icon.getBoundingClientRect().width).toBeCloseTo(40, 1);
    expect(icon.offsetWidth).toBeCloseTo(20, 1);
  });

  it('swaps the shape when the name changes, so a play button can become a pause button', async () => {
    const { root, setProps } = await render(<ve-icon name="play"></ve-icon>);

    await setProps({ name: 'pause' });

    expect(glyph(root)).toBe(parsed('pause'));
  });
});
