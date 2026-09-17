import { signal } from '@preact/signals-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const forceUpdate = vi.fn();

/*
 * Stencil's own `forceUpdate` does nothing for a host it has never rendered, so on a plain object
 * there is no way to tell a repaint request from no request at all. Standing in for it is what
 * makes "asked for a repaint" something a test can see; nothing else in @stencil/core is touched.
 */
vi.mock('@stencil/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@stencil/core')>()),
  forceUpdate: (ref: unknown) => forceUpdate(ref),
}));

const { SignalWatcher } = await import('./signal-watcher');

describe('SignalWatcher', () => {
  const host = { tag: 've-test' };

  beforeEach(() => {
    forceUpdate.mockClear();
  });

  it('hands the render body back to Stencil, and asks for nothing while rendering', () => {
    const watcher = new SignalWatcher(host);
    const count = signal(3);

    expect(watcher.run(() => `count is ${count.value}`)).toBe('count is 3');
    expect(forceUpdate).not.toHaveBeenCalled();

    watcher.stop();
  });

  it('asks its host for a repaint when a signal the last render read changes', () => {
    const watcher = new SignalWatcher(host);
    const count = signal(0);
    watcher.run(() => count.value);

    count.value = 1;
    expect(forceUpdate).toHaveBeenCalledTimes(1);
    expect(forceUpdate).toHaveBeenCalledWith(host);

    // A write that lands on the value already there is not a change, so it is not a repaint.
    count.value = 1;
    expect(forceUpdate).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it('stops repainting for a signal the render has stopped reading', () => {
    const watcher = new SignalWatcher(host);
    const shown = signal('a');
    const hidden = signal('b');

    watcher.run(() => shown.value + hidden.value);
    hidden.value = 'c';
    expect(forceUpdate).toHaveBeenCalledTimes(1);

    // The repaint takes the other branch, which is the whole point of collecting the dependencies
    // afresh on every render rather than once.
    watcher.run(() => shown.value);
    forceUpdate.mockClear();

    hidden.value = 'd';
    expect(forceUpdate).not.toHaveBeenCalled();

    shown.value = 'e';
    expect(forceUpdate).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it('holds on to nothing once the element has left the document', () => {
    const watcher = new SignalWatcher(host);
    const subscribed = vi.fn();
    const dropped = vi.fn();
    const count = signal(0, { watched: subscribed, unwatched: dropped });

    watcher.run(() => count.value);
    expect(subscribed).toHaveBeenCalledTimes(1);

    watcher.stop();
    expect(dropped).toHaveBeenCalledTimes(1);

    count.value = 1;
    expect(forceUpdate).not.toHaveBeenCalled();
  });

  it('is safe to stop twice, which is what a double disconnect does', () => {
    const watcher = new SignalWatcher(host);
    watcher.run(() => 1);
    watcher.stop();
    expect(() => watcher.stop()).not.toThrow();
  });
});
