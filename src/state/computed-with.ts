import { computed, type ReadonlySignal } from '@preact/signals-core';

/**
 * A computed value with a comparison of its own, which is Angular's `computed(fn, { equal })`.
 *
 * @preact/signals-core has no equivalent: its `computed` takes `{ watched, unwatched, name }` and
 * compares by reference, so a body that rebuilds an object every time wakes every dependent every
 * time. The editor leans on this hard. `playheadMs` is written thirty times a second during
 * playback and the preview's derived boxes are rebuilt on each of those writes; what keeps the
 * video boxes, the picture boxes and the crop window from being recomputed per frame is that their
 * comparators say the new object means the same thing as the old one.
 *
 * The comparison happens in the body rather than around it, and returning the PREVIOUS object is
 * what stops the notification: a computed only wakes its dependents when its own result changes by
 * reference, so handing the old object back is indistinguishable from not having changed.
 */
export function computedWith<T>(body: () => T, equal: (a: T, b: T) => boolean): ReadonlySignal<T> {
  let last: T;
  let has = false;
  return computed(() => {
    const next = body();
    if (has && equal(last, next)) return last;
    has = true;
    last = next;
    return next;
  });
}
