import { render, describe, it, expect } from '@stencil/vitest';

describe('ve-spinner', () => {
  it('renders an arc that announces itself', async () => {
    const { root } = await render(<ve-spinner></ve-spinner>);
    await expect(root).toEqualHtml(`
      <ve-spinner class="hydrated">
        <mock:shadow-root>
          <div class="arc" role="progressbar" aria-label="Loading" aria-busy="true"></div>
        </mock:shadow-root>
      </ve-spinner>
    `);
  });

  it('takes the label the host gives it', async () => {
    const { root } = await render(<ve-spinner label="Building your video"></ve-spinner>);
    await expect(root).toEqualHtml(`
      <ve-spinner class="hydrated">
        <mock:shadow-root>
          <div class="arc" role="progressbar" aria-label="Building your video" aria-busy="true"></div>
        </mock:shadow-root>
      </ve-spinner>
    `);
  });
});
