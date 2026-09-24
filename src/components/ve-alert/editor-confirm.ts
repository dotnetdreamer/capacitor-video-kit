import { signal } from '@preact/signals-core';

import type { ConfirmRequest, RenderFailureCode, ResolvedPlatformHost } from '../../host/host.types';

/**
 * The editor's one way of asking the customer something, and the piece that decides which dialog
 * asks it.
 *
 * A host that has a `confirm` gets the question: a native app already has an alert that looks like
 * the rest of it, and one drawn by this package would look pasted on. A host that has none gets
 * `<ve-alert>`, which is why the request is kept in a signal rather than handed anywhere - the
 * shell renders the element while `showing` is set, and nothing else in the editor knows which of
 * the two dialogs is on the screen.
 *
 * The shell holds one of these and uses four lines of it:
 *
 * ```tsx
 * const role = await this.confirm.ask(DISCARD_EDITS);        // wherever the question comes up
 * const asking = this.confirm.showing;                       // inside the render
 * {asking && <ve-alert header={asking.header} message={asking.message} buttons={asking.buttons}
 *            onVeDismiss={(e) => this.confirm.settle(e.detail)} />}
 * ```
 *
 * and, in the back handler, `showing` is also the answer to whose dialog is up. The editor's back
 * press consumes an alert of its own by settling it with null; it must NOT consume one belonging to
 * the host, which has its own overlay handler for that and is registered ahead of the editor's.
 * `pending` with no `showing` is exactly that case.
 */
export class EditorConfirm {
  private readonly request = signal<ConfirmRequest | null>(null);
  private answer: ((role: string | null) => void) | null = null;

  constructor(private readonly platform: Pick<ResolvedPlatformHost, 'confirm'>) {}

  /** What `<ve-alert>` should be rendering, and null whenever it should not be in the DOM at all. */
  get showing(): ConfirmRequest | null {
    return this.request.value;
  }

  /** True from the question to the answer, whichever of the two dialogs is presenting it. */
  get pending(): boolean {
    return this.answer !== null;
  }

  /**
   * Asks, and resolves with the `role` of the button pressed or null for a dismissal.
   *
   * A second question while one is still open is answered null on the spot rather than replacing
   * what is on the screen, which would leave the first caller waiting for an answer that can no
   * longer arrive. Null is the harmless answer everywhere the editor asks: stay where you are.
   */
  ask(request: ConfirmRequest): Promise<string | null> {
    if (this.answer) return Promise.resolve(null);

    return new Promise<string | null>(resolve => {
      this.answer = resolve;
      const native = this.platform.confirm;
      if (!native) {
        this.request.value = request;
        return;
      }
      // A host dialog that throws or rejects is taken as a dismissal. There is no other way out of
      // this promise, and the one place it matters is Discard edits: a customer who cannot get an
      // answer back is a customer who cannot leave the editor.
      try {
        void native(request).then(
          role => this.settle(role),
          () => this.settle(null),
        );
      } catch {
        this.settle(null);
      }
    });
  }

  /** The answer, from `ve-alert`'s `veDismiss` or from the host's own dialog. */
  settle(role: string | null): void {
    const answer = this.answer;
    // Cleared before the caller hears anything, so a caller that asks its next question from inside
    // its own `then` finds nothing still open.
    this.request.value = null;
    this.answer = null;
    answer?.(role);
  }

  /**
   * Called from the shell's `disconnectedCallback`. Anyone still waiting is answered null rather
   * than left holding a promise that nothing can settle now that the editor has gone.
   */
  dispose(): void {
    this.settle(null);
  }
}

/**
 * Leaving with changes asks first, because the clips stay either way and the edits would not.
 *
 * The message says what is kept before it says what is lost: the fear at this button is losing the
 * videos themselves, and they are never at risk.
 */
export const DISCARD_EDITS: ConfirmRequest = {
  header: 'Discard edits?',
  message: 'Your clips stay, but the changes you made here will be lost.',
  buttons: [
    { text: 'Keep editing', role: 'cancel' },
    { text: 'Discard', role: 'destructive' },
  ],
};

/**
 * A post that HAS to be built, on a host that cannot build one.
 *
 * Not a failure - nothing was attempted - so there is nothing to try again, and that is the only
 * way this differs from [renderFailed]. What it exists to prevent is the silence it replaces: the
 * editor used to finish on the spot when its host answered `isSupported()` with false, handing back
 * a manifest and no video, and a host that took the first clip as the post then published one raw
 * clip as though it were the edit. Two videos side by side went out as the left-hand one.
 *
 * "Post without edits" is still offered, because for a single clip somebody only trimmed it is a
 * reasonable thing to want and it is what [renderFailed] already offers. It is offered as a CHOICE,
 * with the consequence in front of them, which is the whole of the fix.
 */
export const RENDER_UNAVAILABLE: ConfirmRequest = {
  header: 'Can’t build your video here',
  message: 'This device can’t build an edited video. You can post your clips as they were, without the edits, or keep editing.',
  buttons: [
    { text: 'Post without edits', role: 'plain' },
    { text: 'Keep editing', role: 'cancel' },
  ],
};

/**
 * A render that produced no file, with a different first sentence for each way it can fail, because
 * most of them are things the customer can do something about.
 *
 * Both answers move forward: try the encode again, or post the clips as they are without the edits.
 * Dismissing it does neither and leaves the editor exactly as it was, which is the third answer and
 * the reason the dialog has no cancel button of its own.
 *
 * Except for a video too big to post (`too_large`, past the host's `EditorOutputOptions.maxBytes`),
 * where trying again builds the same file and fails the same way. There the way forward IS the
 * editor - a lower rung on the quality sheet, or a shorter post - so staying is offered as a button
 * in place of the retry, and the sentence says which two changes make a video smaller.
 */
export function renderFailed(code: RenderFailureCode): ConfirmRequest {
  if (code === 'too_large') {
    return {
      header: 'Couldn’t build your video',
      message: 'This video is too big to post. You can choose a lower quality or make it shorter, or post your clips without the edits.',
      buttons: [
        { text: 'Post without edits', role: 'plain' },
        { text: 'Keep editing', role: 'cancel' },
      ],
    };
  }

  const cause =
    code === 'no_space'
      ? 'There is not enough space on your phone to build this video.'
      : code === 'unreadable_input'
        ? 'One of your clips could not be read.'
        : 'Your edited video could not be built.';

  return {
    header: 'Couldn’t build your video',
    message: `${cause} You can try again, or post your clips without the edits.`,
    buttons: [
      { text: 'Post without edits', role: 'plain' },
      { text: 'Try again', role: 'retry' },
    ],
  };
}
