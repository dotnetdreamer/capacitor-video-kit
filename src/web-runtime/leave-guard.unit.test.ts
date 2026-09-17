import { afterEach, describe, expect, it, vi } from 'vitest';

import { holdPageOpen, pageHolds, releaseAllHolds } from './leave-guard';

/**
 * The close-tab question, which is the web's whole answer to a foreground service.
 *
 * What is worth pinning is the ref counting, because both halves of it are bugs a customer would
 * meet: a listener that goes while an upload is still running loses the question, and one that stays
 * after everything finished asks it about a tab with nothing in it.
 */

afterEach(() => {
  releaseAllHolds();
  vi.restoreAllMocks();
});

/** The listener the guard attached, so the test can fire `beforeunload` at it directly. */
function attachedListener(spy: ReturnType<typeof vi.spyOn>): EventListener | null {
  for (const call of spy.mock.calls) {
    if (call[0] === 'beforeunload') return call[1] as EventListener;
  }
  return null;
}

function fireBeforeUnload(listener: EventListener): { prevented: boolean; returnValue: unknown } {
  let prevented = false;
  const event = {
    type: 'beforeunload',
    returnValue: undefined as unknown,
    preventDefault: () => {
      prevented = true;
    },
  };
  listener(event as unknown as Event);
  return { prevented, returnValue: event.returnValue };
}

describe('holdPageOpen', () => {
  it('listens only while something is held', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    const release = holdPageOpen('rendering');
    expect(attachedListener(add)).not.toBeNull();

    release();
    expect(remove.mock.calls.some(call => call[0] === 'beforeunload')).toBe(true);
  });

  it('keeps listening while a second hold is still out', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    const render = holdPageOpen('rendering');
    const upload = holdPageOpen('uploading');
    // One listener for both, which is why the count matters rather than the flag.
    expect(add.mock.calls.filter(call => call[0] === 'beforeunload')).toHaveLength(1);

    render();
    // The upload is still going: letting the tab close silently here is the bug this prevents.
    expect(remove.mock.calls.some(call => call[0] === 'beforeunload')).toBe(false);
    expect(pageHolds()).toEqual(['uploading']);

    upload();
    expect(remove.mock.calls.some(call => call[0] === 'beforeunload')).toBe(true);
    expect(pageHolds()).toEqual([]);
  });

  it('releasing twice releases once', () => {
    const release = holdPageOpen('rendering');
    holdPageOpen('uploading');
    release();
    release();
    // The second call must not take the other hold's place with it.
    expect(pageHolds()).toEqual(['uploading']);
  });

  it('asks the browser to confirm while work is in flight', () => {
    const add = vi.spyOn(window, 'addEventListener');
    holdPageOpen('rendering');
    const listener = attachedListener(add);
    expect(listener).not.toBeNull();
    if (!listener) return;

    const fired = fireBeforeUnload(listener);
    // Both halves: `preventDefault` is the current specification and `returnValue` is what older
    // browsers act on. Neither carries wording of ours - every browser shows its own.
    expect(fired.prevented).toBe(true);
    expect(fired.returnValue).toBe('');
  });

  it('says nothing once everything has finished', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const release = holdPageOpen('rendering');
    const listener = attachedListener(add);
    expect(listener).not.toBeNull();
    if (!listener) return;

    release();
    // The listener is detached by now; fired anyway, it must still decline to ask.
    expect(fireBeforeUnload(listener).prevented).toBe(false);
  });
});
