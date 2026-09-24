import { describe, expect, it, vi } from 'vitest';

import { registerBackHandlerWith, type PrioritisedBackButton } from './back-button';
import type { EditorPlatformHost } from './host.types';

/*
 * A prioritised back button, stood in for as Ionic's runs one: the handlers by priority, the
 * highest first, each passing the press on by calling `processNextHandler`. `press` answers the
 * priorities that were run, in order, so a test sees who a press reached.
 */
function backButton() {
  const handlers: { priority: number; run: (next: () => void) => void; unsubscribe: ReturnType<typeof vi.fn> }[] = [];
  const platform: PrioritisedBackButton = {
    backButton: {
      subscribeWithPriority(priority, run) {
        const entry = { priority, run, unsubscribe: vi.fn() };
        handlers.push(entry);
        return { unsubscribe: entry.unsubscribe };
      },
    },
  };
  const press = (): number[] => {
    const reached: number[] = [];
    const queue = [...handlers].sort((a, b) => b.priority - a.priority);
    const next = (): void => {
      const handler = queue.shift();
      if (!handler) return;
      reached.push(handler.priority);
      handler.run(next);
    };
    next();
    return reached;
  };
  return { platform, handlers, press };
}

describe('registerBackHandlerWith', () => {
  it('runs the editor\'s handler ahead of Ionic\'s overlay handler at 100', () => {
    const { platform, handlers, press } = backButton();
    const overlays = vi.fn();
    platform.backButton.subscribeWithPriority(100, overlays);

    registerBackHandlerWith(platform)(() => true);
    expect(handlers.map((handler) => handler.priority)).toEqual([100, 101]);
    expect(press()).toEqual([101]);
    expect(overlays).not.toHaveBeenCalled();
  });

  /* False is an editor with nothing open: the press closes whatever the editor is in, or the app. */
  it('passes a press the editor did not consume on to the next handler down', () => {
    const { platform, press } = backButton();
    const overlays = vi.fn();
    platform.backButton.subscribeWithPriority(100, overlays);
    let consumed = false;

    registerBackHandlerWith(platform)(() => consumed);
    expect(press()).toEqual([101, 100]);
    expect(overlays).toHaveBeenCalledTimes(1);

    consumed = true;
    expect(press()).toEqual([101]);
    expect(overlays).toHaveBeenCalledTimes(1);
  });

  it('answers an unsubscribe that takes the handler off again', () => {
    const { platform, handlers } = backButton();

    const unsubscribe = registerBackHandlerWith(platform)(() => true);
    expect(handlers[0]!.unsubscribe).not.toHaveBeenCalled();
    unsubscribe();
    expect(handlers[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  /*
   * Ionic's own declaration, restated, so that a change here that stopped taking its `Platform` fails
   * to compile rather than in an app: a handler that may answer a promise, and an rxjs
   * `Subscription`, which has more on it than `unsubscribe`.
   */
  it('takes Ionic\'s Platform as it is declared, and is a registerBackHandler', () => {
    interface IonicSubscription {
      closed: boolean;
      unsubscribe(): void;
      add(teardown: () => void): void;
    }
    interface IonicPlatform {
      backButton: {
        subscribeWithPriority(priority: number, callback: (processNextHandler: () => void) => Promise<unknown> | void): IonicSubscription;
      };
      is(platformName: string): boolean;
    }
    const subscribe = vi.fn((): IonicSubscription => ({ closed: false, unsubscribe: vi.fn(), add: vi.fn() }));
    const ionic: IonicPlatform = { backButton: { subscribeWithPriority: subscribe }, is: () => true };

    const registerBackHandler: EditorPlatformHost['registerBackHandler'] = registerBackHandlerWith(ionic);
    registerBackHandler?.(() => true);
    expect(subscribe).toHaveBeenCalledWith(101, expect.any(Function));
  });
});
