import { beforeEach, describe, expect, it, vi } from 'vitest';

/* The platform and the plugin, stood in for as `render-host.unit.test.ts` does: one platform to answer with, and capabilities(). */
const bridge = vi.hoisted(() => ({
  native: false,
  capabilities: vi.fn<() => Promise<{ supported: boolean; features?: unknown }>>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => bridge.native },
  registerPlugin: () => ({ capabilities: bridge.capabilities }),
  WebPlugin: class {},
}));

import { composerRenderHost } from './render-host';

beforeEach(() => {
  bridge.native = false;
  bridge.capabilities.mockReset();
});

describe('composerRenderHost: what the render draws', () => {
  it('draws every feature on the web, whose engine is the package own', async () => {
    expect(await composerRenderHost().renderFeatures()).toEqual(['overlayQuad', 'peopleMatte']);
    expect(bridge.capabilities).not.toHaveBeenCalled();
  });

  it('draws what the plugin reports on a phone, only the names this build knows', async () => {
    bridge.native = true;
    bridge.capabilities.mockResolvedValue({ supported: true, features: ['peopleMatte', 'hologram', 'overlayQuad'] });
    expect(await composerRenderHost().renderFeatures()).toEqual(['overlayQuad', 'peopleMatte']);
  });

  it('draws nothing extra for a build that says nothing, or cannot be asked', async () => {
    bridge.native = true;
    bridge.capabilities.mockResolvedValue({ supported: true });
    expect(await composerRenderHost().renderFeatures()).toEqual([]);
    bridge.capabilities.mockRejectedValue(new Error('no plugin'));
    const log = vi.fn();
    expect(await composerRenderHost({ log }).renderFeatures()).toEqual([]);
    expect(log).toHaveBeenCalledWith('[composerRenderHost] capabilities() failed', expect.any(Error));
  });
});
