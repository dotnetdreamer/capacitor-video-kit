import { effect } from '@preact/signals-core';

/**
 * Reads its dependencies now and does the work on the next microtask, once per burst of writes.
 *
 * This is the answer for an effect whose body calls back into the store, and it exists because
 * Angular's effects and @preact/signals-core's read alike on the page and are scheduled nothing
 * alike. Angular coalesces a burst of writes and runs the body after change detection, so the body
 * always sees a settled store. A preact effect runs its body synchronously inside the `.value =`
 * assignment that woke it, which for this store is the middle of a change:
 *
 *  - `EditorStore.commit()` writes `past` and `future` through `pushHistory` BEFORE it writes
 *    `manifest`. A body woken by the history write reads a manifest the step has not landed in yet,
 *    and one that calls `commit()` itself pushes its own entry ahead of a step still being applied.
 *  - A gesture pushes its single history entry in `endGesture()`, when the finger lifts, long after
 *    the `preview()` writes that moved the manifest. A body woken by one of those writes that calls
 *    into `commit()` hits `flushGesture()`, which ends the drag early: two undo steps, the first of
 *    them labelled "Change", from one continuous movement.
 *  - A body that closes a panel unmounts the component whose own effect is still on the stack.
 *
 * A microtask puts the work back where Angular ran it: after the store has finished with itself,
 * still before the browser paints. Deduping the microtask is the other half of the match. One
 * `commit()` writes three signals, and a body reading all three would run three times where Angular
 * ran once; here the tracked half runs three times, cheaply, and the work runs once, on the values
 * the last of the three left behind.
 *
 * `deps` is tracked, so it has to read every signal the work depends on and must not write one.
 * `run` is not tracked, because a microtask carries no effect context, so it can read whatever it
 * likes without widening the dependencies and is where a write, a commit or an unmount belongs.
 * That is the split the Angular bodies wrote by hand as a tracked head and an `untracked()` tail,
 * made structural, which is why an `untracked()` call inside a `run` body has nothing left to do.
 *
 * The returned disposer belongs in `disconnectedCallback`. Work already queued when it is called is
 * dropped, because the element is on its way out and the store must not hear from it again.
 */
export function deferredEffect<T>(deps: () => T, run: (value: T) => void): () => void {
  let queued = false;
  let alive = true;
  let latest!: T;

  const dispose = effect(() => {
    // Tracked and pure. The value is kept rather than acted on, so the last write of a burst is the
    // one the microtask reads and the ones before it cost a comparison each.
    latest = deps();
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      // Cleared before the body runs, not after, so a write the body makes to something `deps`
      // reads queues a fresh run rather than being swallowed by this one.
      queued = false;
      if (alive) run(latest);
    });
  });

  return () => {
    alive = false;
    dispose();
  };
}

/**
 * Takes a sheet off the screen once the thing it was opened to change has gone.
 *
 * The layout, volume and opacity sheets each watch one thing - the video track, the volume target,
 * the selected layer - and each calls `store.closePanel()` when it is no longer there, which is how
 * an undo that removes a layer takes the sheet adjusting it with it. As a plain effect that is a
 * component destroying itself from inside its own effect body, part way through the undo that
 * triggered it. Deferred, the store finishes the undo and the sheet is gone a microtask later.
 *
 * `gone` is read on creation as well, so a sheet mounted for something that is already missing
 * closes instead of sitting there empty, which is what the Angular constructor effects did.
 */
export function closeWhenGone(gone: () => boolean, close: () => void): () => void {
  return deferredEffect(gone, (isGone) => {
    if (isGone) close();
  });
}
