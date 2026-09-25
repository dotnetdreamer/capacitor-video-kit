/**
 * Ahead of Ionic's own overlay handler, which sits at 100. While the editor is up its sheets are the
 * overlays a back press is about; at or under 100, the press meant to close a sheet dismisses the
 * modal the editor is in, as `backdrop`, and takes the edit with it.
 */
const EDITOR_BACK_PRIORITY = 101;

/**
 * A back button whose handlers run by priority, the highest first, each able to pass the press on to
 * the next: the shape of Ionic's `Platform`, written out rather than imported, so the package needs
 * no Ionic and a host with the same shape of its own can use it too.
 *
 * Ionic's own `subscribeWithPriority` takes a handler that may answer a promise, and answers an rxjs
 * `Subscription`. Its `Platform` fits all the same: the handler passed here answers nothing, which
 * Ionic takes, and a subscription is something with an `unsubscribe`.
 */
export interface PrioritisedBackButton {
  backButton: {
    subscribeWithPriority(priority: number, handler: (processNextHandler: () => void) => void): { unsubscribe(): void };
  };
}

/**
 * [EditorPlatformHost.registerBackHandler] over a prioritised back button - Ionic's `Platform` - which
 * every Ionic host was writing out for itself in the same eight lines.
 *
 * The editor's handler is subscribed at 101, ahead of Ionic's overlay handler (see
 * [EDITOR_BACK_PRIORITY]), and a press it answers false for, which is a press it had nothing to
 * close for, is passed on to the next handler down: that is what closes the modal the editor is in,
 * or the app, from an editor with nothing open. Without a registered handler at all Android's back
 * button does nothing inside the editor, and a tall sheet - stickers, text, sound - that hides the
 * stage's own Back leaves its tick as the only way out.
 */
export function registerBackHandlerWith(platform: PrioritisedBackButton): (handler: () => boolean) => () => void {
  return (handler) => {
    const subscription = platform.backButton.subscribeWithPriority(EDITOR_BACK_PRIORITY, (processNextHandler) => {
      if (!handler()) processNextHandler();
    });
    return () => subscription.unsubscribe();
  };
}
