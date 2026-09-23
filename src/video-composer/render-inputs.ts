import { Capacitor } from '@capacitor/core';

import type { ComposeClip, ComposeSpec } from './definitions';
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

  const nativeUri = async (uri: string): Promise<string> => {
    signal?.throwIfAborted();
    if (!uri.startsWith('blob:')) return uri;
    const known = stagedByBlob.get(uri);
    if (known) return known;

    const response = await fetch(uri, { signal });
    if (!response.ok) throw new Error(`Could not read a render input: HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('A render input is empty');
    const extension = extensionFor(blob.type);

    let file = '';
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      signal?.throwIfAborted();
      const data = await base64(blob.slice(offset, offset + CHUNK_BYTES));
      signal?.throwIfAborted();
      if (!file) {
        file = (await VideoComposer.stageRenderInput({ data, ...(extension ? { extension } : {}) })).uri;
        // Remembered before the next chunk, so a file whose append fails is still released.
        staged.push(file);
      } else {
        await VideoComposer.stageRenderInput({ data, uri: file });
      }
    }
    stagedByBlob.set(uri, file);
    return file;
  };

  const stageClip = async (clip: ComposeClip): Promise<void> => {
    clip.uri = await nativeUri(clip.uri);
    if (clip.transitionIn) clip.transitionIn.from.uri = await nativeUri(clip.transitionIn.from.uri);
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
 * a prefix to cut off and an API a test runner's DOM does not always have. The bytes are turned into
 * a string a slice at a time because `String.fromCharCode` takes its characters as arguments, and a
 * whole mebibyte of arguments is past what an engine will put on the stack.
 */
async function base64(chunk: Blob): Promise<string> {
  const bytes = new Uint8Array(await chunk.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}
