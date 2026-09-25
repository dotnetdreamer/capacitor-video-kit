import { Capacitor } from '@capacitor/core';

import type { ComposeClip, ComposeFailureCode, ComposeSpec } from './definitions';
import { VideoComposer } from './index';

/**
 * How many bytes of a blob go into one `stageRenderInput` call: a message of about 1.4 MB once it is
 * base64, so neither the page nor the bridge ever holds a whole extracted WAV as one string, and a
 * minute of that WAV, about ten megabytes, is still only ten calls.
 */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Renders `spec` with every `blob:` URL in it written out as a file the native engine can open,
 * and deletes those files once the render is over.
 *
 * WHY. A native engine opens files, and a page holds some of a post as `blob:` URLs in the WebView's
 * own memory: a sound from the browser's sound library, a track the editor's default picker read in
 * on iOS, a clip a host kept as bytes. Neither engine can reach one, so without this every post that
 * used one failed at the last step as `unreadable_input`. Each distinct blob is fetched and handed to
 * `stageRenderInput` a mebibyte at a time, the spec is copied with the staged `file://` names in
 * place of the blobs, and `render` is given the copy. The caller's spec is not touched: the editor
 * keeps its playable URLs for Edit again.
 *
 * Every place a spec names media is covered, because a blob left in any of them fails the render:
 * the base clips, every track's clips, each clip's `transitionIn.from`, the music and every
 * voiceover. One URL named several times - a split clip, a transition's outgoing side, the same
 * sound as music and as a take - is staged once.
 *
 * An input that cannot be staged rejects with a [RenderInputError] in the composer's own terms, and
 * `render` is never started: a blob that will not read - revoked, or empty - is `unreadable_input`,
 * naming the clip whose URL it was, and a chunk the phone would not write is `no_space` for a full
 * disk and `unknown` for anything else.
 *
 * The staged files are released in `finally`, after `render` has settled, whatever it settled with -
 * a video, a failure or a cancel - so `render` must not settle before the engine has let go of its
 * inputs: it awaits the job's terminal event, not `compose`'s answer, which comes back the moment the
 * job is registered. A release that fails is left to the launch sweep, which deletes a staged file
 * once it is a day old, rather than turning a finished video into an error.
 *
 * `signal` stops the staging: it is checked before each input and each chunk and given to each
 * `fetch`, and an abort before `render` starts rejects with the signal's reason, releasing whatever
 * was staged, without starting the render at all. Once `render` has started, cancelling it is the
 * caller's own business, as it is today.
 *
 * Off a phone this is `render(spec)` and nothing else. The web engine reads a `blob:` URL as it is,
 * and a browser has no native file to write one into.
 */
export async function withNativeRenderInputs<T>(
  spec: ComposeSpec,
  render: (spec: ComposeSpec) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!Capacitor.isNativePlatform()) return render(spec);

  const staged: string[] = [];
  const stagedByBlob = new Map<string, string>();

  // `clipKey` is the wire key of the clip that names `uri`, for a failure to blame, and is absent for
  // the music and a voiceover take.
  const nativeUri = async (uri: string, clipKey?: string): Promise<string> => {
    signal?.throwIfAborted();
    if (!uri.startsWith('blob:')) return uri;
    const known = stagedByBlob.get(uri);
    if (known) return known;

    const blob = await readInput(uri, clipKey, signal);
    const extension = extensionFor(blob.type);

    /*
     * One chunk encoded ahead. The page would otherwise sit idle through every bridge call while the
     * phone decodes and appends, and only then start encoding the next mebibyte; encoding chunk i+1
     * while chunk i is being written overlaps the two. The calls themselves still go out one at a
     * time and in order - the first still answers the file's name before any append names it - so
     * the staged file is the same bytes. At most two chunks of base64, about 2.8 MB, are alive at
     * once. An encode started ahead and never awaited, because the signal stopped the staging or a
     * write failed, is caught here so its rejection is not reported as unhandled.
     */
    const encode = (at: number): Promise<string> => {
      const encoding = base64(blob.slice(at, at + CHUNK_BYTES));
      encoding.catch(() => undefined);
      return encoding;
    };
    let file = '';
    let pending = encode(0);
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      signal?.throwIfAborted();
      const data = await pending;
      signal?.throwIfAborted();
      if (offset + CHUNK_BYTES < blob.size) pending = encode(offset + CHUNK_BYTES);
      try {
        if (!file) {
          file = (await VideoComposer.stageRenderInput({ data, ...(extension ? { extension } : {}) })).uri;
          // Remembered before the next chunk, so a file whose append fails is still released.
          staged.push(file);
        } else {
          await VideoComposer.stageRenderInput({ data, uri: file });
        }
      } catch (error) {
        throw writeFailure(error);
      }
    }
    stagedByBlob.set(uri, file);
    return file;
  };

  const stageClip = async (clip: ComposeClip): Promise<void> => {
    clip.uri = await nativeUri(clip.uri, clip.key);
    const from = clip.transitionIn?.from;
    if (from) from.uri = await nativeUri(from.uri, from.key);
  };

  try {
    const prepared = structuredClone(spec);
    for (const clip of prepared.clips) await stageClip(clip);
    for (const track of prepared.tracks ?? []) {
      for (const clip of track.clips) await stageClip(clip);
    }
    const music = prepared.audio.music;
    if (music) music.uri = await nativeUri(music.uri);
    for (const take of prepared.audio.voiceover) take.uri = await nativeUri(take.uri);
    signal?.throwIfAborted();
    return await render(prepared);
  } finally {
    if (staged.length > 0) {
      await VideoComposer.releaseRenderInputs({ uris: staged }).catch(() => undefined);
    }
  }
}

/**
 * Why [withNativeRenderInputs] could not write an input out as a file, in the terms of a job's own
 * `failed` event ([ComposeError]), so that whoever reads one reads the other the same way.
 *
 * It exists because a staging failure used to arrive as a bare `Error` - "Could not read a render
 * input: HTTP 404" - that named neither a code nor a clip, and a render host could only call it
 * `unknown`. The customer was then told their video could not be built and to try again, and every
 * retry read the same revoked blob and failed the same way, where the composer's own
 * `unreadable_input` for a clip it could not open tells them a clip could not be read and tells the
 * host which. `composerRenderHost` maps this exactly as it maps a `failed` event: the code onto the
 * editor's union, and `clipKey` back to the host's source.
 */
export class RenderInputError extends Error {
  constructor(
    /**
     * `unreadable_input` for a blob the page could not read back - revoked, refused or empty;
     * `no_space` for a chunk a full disk would not take; `unknown` for any other failed write.
     */
    readonly code: Extract<ComposeFailureCode, 'unreadable_input' | 'no_space' | 'unknown'>,
    message: string,
    /**
     * The wire key of the clip whose URL would not read, which is a segment id as a `failed`
     * event's is, on `unreadable_input` alone; absent for the music and a voiceover take, which
     * name no clip, and for a failed write, which is the disk's fault and not the clip's.
     */
    readonly clipKey?: string,
  ) {
    super(message);
    this.name = 'RenderInputError';
  }
}

/**
 * The bytes behind a `blob:` URL, or an `unreadable_input` [RenderInputError] naming `clipKey`.
 *
 * An abort is not a clip that could not be read: `fetch` rejects with the signal's reason when the
 * signal is what stopped it, and that reason is what comes out, so the caller can tell the customer
 * backing out from a broken input.
 */
async function readInput(uri: string, clipKey: string | undefined, signal: AbortSignal | undefined): Promise<Blob> {
  const unreadable = (why: string) => new RenderInputError('unreadable_input', why, clipKey);
  const reading = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      signal?.throwIfAborted();
      throw unreadable(`Could not read a render input: ${String(error)}`);
    }
  };

  const response = await reading(() => fetch(uri, { signal }));
  if (!response.ok) throw unreadable(`Could not read a render input: HTTP ${response.status}`);
  const blob = await reading(() => response.blob());
  if (!blob.size) throw unreadable('A render input is empty');
  return blob;
}

/**
 * A `stageRenderInput` rejection as a [RenderInputError]. Both platforms reject a write a full disk
 * refused with the code `no_space` (iOS `rejectWrite`, Android's `hasNoSpaceCause`), which the
 * editor has a sentence of its own for; `invalid_spec` is this file's own mistake, and it and
 * everything else is `unknown`.
 */
function writeFailure(error: unknown): RenderInputError {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return new RenderInputError(
    code === 'no_space' ? 'no_space' : 'unknown',
    `Could not write a render input: ${typeof message === 'string' ? message : String(error)}`,
  );
}

/**
 * The extension a staged input is named with, WITHOUT its dot, from the type its blob says it is,
 * or `''` for a type this does not know.
 *
 * A better default name rather than a requirement. AVFoundation chooses its reader by a file's
 * extension and refuses one with none, which is how an extensionless WAV from the browser's sound
 * library failed every post with music on iOS; the kit's iOS `RenderInputs` answers that by reading
 * the first bytes and opening a file under a name that says what they are, and Android's Media3
 * sniffs the content. A file already named for what it holds skips that step. A type this does not
 * know gets no extension rather than a guess, which `RenderInputs` would only have to undo.
 */
export function extensionFor(mimeType: string): string {
  const type = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  const picture = /^image\/([a-z0-9]+)$/.exec(type);
  return EXTENSIONS.get(type) ?? picture?.[1] ?? '';
}

/**
 * The sound and video types a blob input arrives as: the browser sound library's WAV, and whatever
 * a browser or Apple's type table calls a file picked in From files (`PickAudioFileResult.mimeType`).
 * A picture's own subtype is its extension, and needs no row.
 */
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['audio/wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/vnd.wave', 'wav'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['audio/aac', 'aac'],
  ['audio/aiff', 'aiff'],
  ['audio/x-aiff', 'aiff'],
  ['audio/x-caf', 'caf'],
  ['audio/flac', 'flac'],
  ['audio/x-flac', 'flac'],
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
]);

/**
 * A chunk of bytes as base64, the form a bridge message carries them in.
 *
 * Through `arrayBuffer` and `btoa` rather than a `FileReader` data URL, which is the same work with
 * a prefix to cut off and an API a test runner's DOM does not always have.
 *
 * The engine's own `Uint8Array.prototype.toBase64` where there is one (Safari 18.2, Chrome 140 and
 * up): with no options it is the standard alphabet with padding, the very string `btoa` gives, at a
 * fraction of the main-thread time. Older WebViews have none, and neither does the test runner, so
 * it is asked for rather than assumed, and the loop below is kept for them. The loop turns the bytes
 * into a string a slice at a time because `String.fromCharCode` takes its characters as arguments,
 * and a whole mebibyte of arguments is past what an engine will put on the stack; through `apply`
 * rather than a spread, which JavaScriptCore walks through the iterator protocol a byte at a time.
 */
async function base64(chunk: Blob): Promise<string> {
  const bytes = new Uint8Array(await chunk.arrayBuffer());
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000) as unknown as number[]);
  }
  return btoa(binary);
}
