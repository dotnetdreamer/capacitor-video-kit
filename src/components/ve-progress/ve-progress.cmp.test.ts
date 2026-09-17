import { render, describe, it, expect } from '@stencil/vitest';

/**
 * A browser test, because everything this component promises is geometry: a fraction of a track
 * drawn as a transform, a stripe narrower than the bar it sweeps, and a number out of range that
 * must not paint a full bar. The mock DOM computes no styles and answers yes to all three.
 *
 * Rendered from markup rather than from JSX so that both surfaces the shell can drive are covered:
 * the attributes a host writes, and the properties `setProps` assigns the way the shell's own
 * render does.
 */

/** The bar inside a box of a known width, since everything it draws is a fraction of one. */
async function bar(attrs: string): Promise<{ host: HTMLElement; fill: HTMLElement }> {
  const { root } = await render<HTMLElement>(`<div style="width: 200px"><ve-progress ${attrs}></ve-progress></div>`);
  const host = root.querySelector('ve-progress') as HTMLElement;
  return { host, fill: host.shadowRoot!.querySelector('.fill') as HTMLElement };
}

describe('ve-progress', () => {
  it('fills the track to the fraction it was given, and announces the same figure the card shows', async () => {
    const { host, fill } = await bar('value="0.25"');

    expect(host.getBoundingClientRect().width).toBeCloseTo(200, 1);
    expect(fill.getBoundingClientRect().width).toBeCloseTo(50, 1);
    expect(host.getAttribute('aria-valuenow')).toBe('25');
    expect(host.getAttribute('role')).toBe('progressbar');
  });

  it('holds a number from outside inside the track', async () => {
    // Measured one at a time, because `render` clears the stage: the second bar detaches the first,
    // and a detached element measures zero, which is the same answer a clamp that had failed gives.
    const over = await bar('value="1.6"');
    expect(over.fill.getBoundingClientRect().width).toBeCloseTo(200, 1);

    const under = await bar('value="-0.2"');
    expect(under.fill.getBoundingClientRect().width).toBeCloseTo(0, 1);
  });

  it('reads a number it cannot use as nothing done, rather than as everything done', async () => {
    // The failure this is here for: `scaleX(NaN)` is invalid at computed-value time, so the whole
    // transform is dropped and the fill paints across the full track. A render that has not started
    // would look like a render that has finished.
    const { fill } = await bar('value="whenever"');

    expect(fill.getBoundingClientRect().width).toBeCloseTo(0, 1);
  });

  it('sweeps a stripe, with no figure to announce, while the amount is unknown', async () => {
    const { host, fill } = await bar('type="indeterminate" value="0"');

    expect(fill.getBoundingClientRect().width).toBeCloseTo(80, 1);
    expect(getComputedStyle(fill).animationName).toBe('ve-progress-sweep');
    expect(host.hasAttribute('aria-valuenow')).toBe(false);
    expect(host.getAttribute('aria-busy')).toBe('true');
  });

  it('moves when the shell writes the next number the composer reported', async () => {
    const { root, setProps } = await render<HTMLElement>('<ve-progress value="0.25"></ve-progress>');
    const fill = root.shadowRoot!.querySelector('.fill') as HTMLElement;

    await setProps({ value: 0.5 });

    // The position is read from the custom property rather than measured, because the transition
    // between two readings is still running at this point and a measurement would be timing.
    expect(fill.style.getPropertyValue('--ve-progress-scale')).toBe('0.5');
    expect(root.getAttribute('aria-valuenow')).toBe('50');
  });

  it('takes the name the shell gives it, so the bar and its card are announced as one thing', async () => {
    const { host } = await bar('label="Preparing your video" value="0.4"');

    expect(host.getAttribute('aria-label')).toBe('Preparing your video');
  });
});
