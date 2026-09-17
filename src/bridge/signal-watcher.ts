import { forceUpdate } from '@stencil/core';
import { effect } from '@preact/signals-core';

/**
 * Drives a Stencil 4 component's rendering from the signals its render function reads.
 *
 * Stencil 4 has no reactive primitive of its own and no hook inside its render pipeline, so the
 * only place a component's reads can be observed is the render call itself. `run()` calls the
 * render body inside a `@preact/signals-core` effect: the first pass through the effect IS the
 * render, so the value handed back to Stencil is the real one and nothing renders twice. Every
 * later run of that effect means a signal the last paint read has changed, and all it does is ask
 * Stencil for a repaint - Stencil still decides when that happens, and the repaint calls back into
 * `run()`, which installs a fresh effect.
 *
 * Installing a fresh effect each time is the whole of the dependency tracking. The set of signals
 * being watched is always exactly what the last paint read, so a branch the render stopped taking
 * stops causing repaints, and a branch it started taking starts.
 *
 * This is the same mechanism @stencil/store uses for its own automatic re-rendering, built on the
 * same two public functions, and it is what @stencil/core/signals replaces in Stencil 5: at that
 * upgrade this file is deleted and the store above it is untouched.
 *
 * A component uses it in three lines:
 *
 * ```tsx
 * private readonly watcher = new SignalWatcher(this);
 * disconnectedCallback() { this.watcher.stop(); }
 * render() { return this.watcher.run(() => <div>{store.totalMs.value}</div>); }
 * ```
 */
export class SignalWatcher {
  private dispose: (() => void) | null = null;

  constructor(private readonly host: unknown) {}

  run<T>(body: () => T): T {
    this.dispose?.();
    let result!: T;
    let collecting = true;
    this.dispose = effect(() => {
      if (collecting) {
        result = body();
        return;
      }
      forceUpdate(this.host);
    });
    collecting = false;
    return result;
  }

  /**
   * Drops the effect. Called from `disconnectedCallback`, so an element out of the document holds
   * on to no signals and asks for no repaints.
   */
  stop(): void {
    this.dispose?.();
    this.dispose = null;
  }
}
