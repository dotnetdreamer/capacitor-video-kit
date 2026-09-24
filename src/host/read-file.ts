import { resolve } from '../web-runtime/files';

import { webViewUrl } from './web-view-url';

/*
 * Reading a file into the page the one way that works on every platform a Capacitor host runs on.
 *
 * The kit read files this way in three places - the finished render (`readRenderFile`), the copy the
 * default audio picker makes on iOS (`pickAudioThroughKit` in `defaults`), a voiceover take
 * (`nativeVoice` in `video-composer/media-host`) - and every host wrote the same few lines again for
 * the files it keeps itself, as a `fetch` that either checked `ok`, which refuses a good file on iOS,
 * or checked nothing, which takes an empty file or an error page for the file. It is here rather than
 * beside the render because none of it imports `@capacitor/core`, so `capacitor-video-kit/ui`
 * exports it to a host of any kind.
 */

/** What both of the composer's recorders write, iOS's `VoiceRecorder` and Android's alike: AAC in an MPEG-4 container. */
const VOICE_TAKE_TYPE = 'audio/mp4';

/**
 * The bytes behind anything a Capacitor host names a file by: a device path, a `file://` or a
 * `content://` URI through Capacitor's local server ([webViewUrl]), and a `blob:`, `data:` or
 * `http(s):` URL as it is.
 *
 * WHY NOT A PLAIN `fetch`. The iOS local server answers a request for a whole file with a plain URL
 * response rather than an HTTP one, which `fetch` reports as status 0 and not `ok`, with every byte
 * behind it: a check of `ok` refuses a good file there, and a check of nothing takes an HTTP error's
 * page for the file. The reading is `resolve`'s, in `web-runtime/files`, which says more. Past that
 * an empty body is refused whatever the status, because nothing anybody picked, recorded or rendered
 * is a file of no bytes, and a caller that took one would fail further in with a worse message: an
 * upload the server refuses after the customer waited for it, a take that plays as silence.
 *
 * The type is as the bytes came, which from the iOS local server is none; a caller that knows what
 * the file is types it itself, as [readVoiceTake] does.
 *
 * Rejects with a plain `Error` naming the URI and the reason - a fetch that failed, an HTTP error, a
 * file of no bytes, no URI at all - so a caller that logs it says which file.
 */
export async function readFileBlob(uri: string): Promise<Blob> {
  // An empty URL is the page's own address to `fetch`, which would answer with the app's HTML.
  if (!uri) throw new Error('there is no file to read');
  const bytes = await resolve(webViewUrl(uri));
  if (!bytes.size) throw new Error(`could not read ${uri}: it is empty`);
  return bytes;
}

/**
 * A voiceover take the composer's recorder wrote, read into the page by [readFileBlob] and typed as
 * the recorder writes it, `audio/mp4`, whatever the local server said: the iOS one says nothing, and
 * a render on a phone names the file it stages after the type (`extensionFor` in `render-inputs`),
 * so a take typed nothing would be staged with no `.m4a`. A draft that keeps the bytes keeps the type
 * with them, and so reopens to a take that renders the same.
 *
 * The composer's media host reads every take the customer places this way (`nativeVoice`), and hands
 * one over as the recorder's file only when it could not: a read that failed or was too slow, or a
 * recording a reloaded page left running. That file is in the recorder's cache folder, which the
 * plugin's next load empties of anything a day old, so a host that keeps a draft past a day reads
 * such a take with this before it files the draft. Rejects as [readFileBlob] does.
 */
export async function readVoiceTake(uri: string): Promise<Blob> {
  const bytes = await readFileBlob(uri);
  return bytes.type === VOICE_TAKE_TYPE ? bytes : new Blob([bytes], { type: VOICE_TAKE_TYPE });
}
