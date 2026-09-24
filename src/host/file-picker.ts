/**
 * The messages `@capawesome/capacitor-file-picker` rejects with when the customer backs out, and
 * nothing else it rejects with. Its own constants, the same on every platform and in every version
 * read (8.0.1 and 8.1.0): `errorPickFileCanceled` and `errorPickDirectoryCanceled` in iOS's
 * `FilePickerPlugin.swift`, `ERROR_PICK_FILE_CANCELED` and `ERROR_PICK_DIRECTORY_CANCELED` in
 * Android's `FilePickerPlugin.java`, `ERROR_PICK_FILE_CANCELED` in its `web.js`.
 */
const CANCEL_MESSAGES: ReadonlySet<string> = new Set(['pickFiles canceled.', 'pickDirectory canceled.']);

/**
 * Whether `@capawesome/capacitor-file-picker` rejected because the customer backed out of it, for a
 * picker's `catch`: a cancel is the null every editor picker resolves with, and anything else is a
 * failure it rejects with, or the button looks dead.
 *
 * WHY THE MESSAGE, AND ALL OF IT. The plugin rejects a cancel exactly as it rejects a failure, with
 * no code on any platform, so the message is all there is. It is one message for every pick call -
 * `pickVideos`, `pickImages` and `pickMedia` are `pickFiles canceled.` too - whether the customer
 * tapped Cancel, swiped the sheet away (iOS's `presentationControllerDidDismiss`), finished the photo
 * picker with nothing chosen, or closed the page's file input. Matching less than all of it, `cancel`
 * anywhere in the text say, also silences real failures: on iOS a photo that could not be loaded
 * rejects with the item provider's own `localizedDescription` (`FilePicker.swift`), the system's
 * sentence in the customer's language, which can say anything, cancelling included. The plugin's own
 * messages are never translated.
 *
 * Typed by shape rather than by the plugin, which this package does not depend on: a Capacitor
 * rejection is an `Error` with the message on it, and so is the web implementation's.
 */
export function filePickerCancelled(error: unknown): boolean {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && CANCEL_MESSAGES.has(message);
}
