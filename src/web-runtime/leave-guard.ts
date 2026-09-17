/**
 * Asks before the customer closes the tab on work that cannot survive it.
 *
 * This is the web's answer to the foreground service and to WorkManager, and it is a smaller answer
 * than either - which is exactly why it is here. A phone keeps encoding with the app swiped away and
 * keeps uploading with the process dead; a browser stops the moment the document goes. So the one
 * thing a page CAN do is notice that it is about to go and say so, and that is `beforeunload`.
 *
 * Ref-counted, because a render and an upload overlap in the normal case: the composer holds the
 * page while it encodes, the publisher holds it while it uploads, and the listener stays attached
 * for as long as either does. A hold released twice releases once.
 *
 * Two browser rules worth knowing, because both look like bugs otherwise:
 *
 * - The message is NOT ours. Every browser since 2017 shows its own generic wording and ignores
 *   whatever string a page returns, so `reason` is for this package's own logs and for a host that
 *   wants to ask the question itself. Setting `returnValue` is still what triggers the prompt.
 * - Nothing is shown at all unless the customer has interacted with the page. That is the sticky
 *   activation rule, and it is deliberate on the browser's part: a page the customer never touched
 *   does not get to hold their tab hostage. In practice a render always follows a tap on Next, so
 *   the activation is there.
 */

interface Hold {
  id: number;
  reason: string;
}

const holds = new Map<number, Hold>();
let nextId = 1;
let listening = false;

/**
 * Holds the page open until the returned function is called. Call it in a `finally`: a hold left
 * behind asks the customer to confirm closing a tab with nothing running in it, which is worse than
 * not asking at all.
 */
export function holdPageOpen(reason: string): () => void {
  const id = nextId++;
  holds.set(id, { id, reason });
  attach();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds.delete(id);
    detach();
  };
}

/** What is being held right now, for a host that wants to word the question itself. */
export function pageHolds(): string[] {
  return [...holds.values()].map(hold => hold.reason);
}

/** Drops every hold. For the tests, and for a host tearing the editor down. */
export function releaseAllHolds(): void {
  holds.clear();
  detach();
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (holds.size === 0) return;
  // Both halves are needed: `preventDefault` is what the current specification asks for, and
  // `returnValue` is what older browsers act on. Neither shows text of ours.
  event.preventDefault();
  event.returnValue = '';
}

function attach(): void {
  if (listening || holds.size === 0) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeunload', onBeforeUnload);
  listening = true;
}

function detach(): void {
  if (!listening || holds.size > 0) return;
  if (typeof window === 'undefined') return;
  window.removeEventListener('beforeunload', onBeforeUnload);
  listening = false;
}
