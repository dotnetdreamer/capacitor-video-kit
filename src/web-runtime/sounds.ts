/**
 * The web's answer to a sound library: audio pulled out of a video, kept across reloads.
 *
 * Two halves that have nothing to do with each other and are here together because neither is worth
 * a file of its own. [extractAudio] turns a video into a WAV blob using the browser's own decoder,
 * and the rest keeps a record of one in IndexedDB beside the bytes `web-runtime/files` already
 * stores, so a sound saved today is still in the list tomorrow.
 *
 * Neutral ground on purpose. Both halves of the package want this - the editor's browser host for
 * its default library, and `VideoComposer`'s web implementation for `extractAudio` - and the editor
 * half may not reach into the plugin half. `web-runtime` is what they already share.
 *
 * WAV, and not the compressed track the video actually carries. A browser has no demuxer a page can
 * reach: `decodeAudioData` is the only door to the audio inside an MP4, and what comes back out of
 * it is samples. So the browser's library costs about 10 MB a minute where a phone's costs under
 * one, and the whole video is read into memory to get there. That is the honest web answer rather
 * than a bad one - a native host does this properly through [VideoComposerPlugin.extractAudio] -
 * and it is why nothing here is used when a real one is supplied.
 */
import { deleteFile, loadableUrl, putFile, resolve } from './files';
import { SOUNDS_STORE, idbDelete, idbGet, idbPut, idbValues } from './idb';

/** Everything kept in this library lives under one folder, so a clear is one call. */
const SOUND_FOLDER = 'sounds';

/** Two is what a post's mix uses; a 6-channel film track is downmixed rather than kept. */
const MAX_CHANNELS = 2;

/**
 * One kept sound, as it is written down.
 *
 * `fileUri` is the durable `videokit-file:` name rather than a `blob:` URL: a URL minted by the
 * document that saved the sound is dead by the time the record is read again, which is the whole
 * reason the two are separate fields in the first place.
 */
export interface StoredSound {
  id: string;
  fileUri: string;
  fileName: string;
  durationMs: number;
  savedAt: number;
  sourceName?: string;
}

/** A record with a URL that can be played right now. */
export interface ReadableSound extends StoredSound {
  uri: string;
}

/**
 * The audio inside `src` as a WAV blob, or null when there is no audio in it at all.
 *
 * `src` is anything [resolve] understands: a `blob:` URL from a picker, a `videokit-file:` name, an
 * `http(s):` URL of this origin's own. Rejects when the bytes cannot be read or the browser cannot
 * decode them, which for a video means it cannot play it either.
 */
export async function extractAudio(src: string): Promise<{ blob: Blob; durationMs: number } | null> {
  const bytes = await (await resolve(src)).arrayBuffer();
  const Context = typeof AudioContext !== 'undefined' ? AudioContext : undefined;
  if (!Context) throw new Error('this browser has no Web Audio');

  const context = new Context();
  let decoded: AudioBuffer;
  try {
    // A copy, because a successful decode DETACHES the buffer it was given and a retry would then
    // be handed zero bytes.
    decoded = await context.decodeAudioData(bytes.slice(0));
  } catch (error) {
    // A video with no audio track decodes to nothing rather than throwing on some browsers and
    // throws on others, so both answers have to mean the same thing here.
    if (isEmptyDecode(error)) return null;
    throw error;
  } finally {
    void context.close().catch(() => undefined);
  }

  if (decoded.length === 0 || decoded.numberOfChannels === 0) return null;
  return {
    blob: wavBlob(decoded),
    durationMs: Math.round(decoded.duration * 1000),
  };
}

/** Writes the bytes, writes the record, and answers with a record that can be played. */
export async function saveSound(
  blob: Blob,
  details: { fileName: string; durationMs: number; sourceName?: string },
): Promise<ReadableSound> {
  const id = newId();
  const { uri, url } = await putFile(SOUND_FOLDER, `${id}.wav`, blob);
  const record: StoredSound = {
    id,
    fileUri: uri,
    fileName: details.fileName,
    durationMs: details.durationMs,
    savedAt: Date.now(),
    ...(details.sourceName ? { sourceName: details.sourceName } : {}),
  };
  await idbPut(SOUNDS_STORE, id, record);
  return { ...record, uri: url };
}

/**
 * Every kept sound, newest first, each with a URL this document can play.
 *
 * A record whose bytes have gone - a browser evicting storage takes the blob and leaves the record,
 * because the two are separate stores - is dropped from the list AND from the store, so the library
 * cannot silently fill up with rows that play nothing.
 */
export async function listSounds(): Promise<ReadableSound[]> {
  const records = await idbValues<StoredSound>(SOUNDS_STORE);
  const readable: ReadableSound[] = [];
  for (const record of records.sort((a, b) => b.savedAt - a.savedAt)) {
    if (!record?.id || !record.fileUri) continue;
    let uri: string;
    try {
      uri = await loadableUrl(record.fileUri);
    } catch {
      await idbDelete(SOUNDS_STORE, record.id);
      continue;
    }
    readable.push({ ...record, uri });
  }
  return readable;
}

/** Takes one sound out of the library, bytes and record. Silent about an id that is already gone. */
export async function deleteSound(id: string): Promise<void> {
  const record = await idbGet<StoredSound>(SOUNDS_STORE, id);
  if (record?.fileUri) await deleteFile(record.fileUri);
  await idbDelete(SOUNDS_STORE, id);
}

/* ------------------------------------------------------------------------------------------- */

/**
 * A decoded buffer as a 16-bit PCM WAV.
 *
 * 16-bit because it is what every browser, every `<audio>` element and both native mixers read
 * without negotiation, and because the float samples this came from are two bytes wider for a
 * difference nobody hears in a phone's speaker. The channels are interleaved on the way out, which
 * is the one thing WAV asks for that an `AudioBuffer` does not already provide.
 */
function wavBlob(buffer: AudioBuffer): Blob {
  const channelCount = Math.min(buffer.numberOfChannels, MAX_CHANNELS);
  const channels = Array.from({ length: channelCount }, (_, i) => buffer.getChannelData(i));
  const frames = buffer.length;
  const bytes = new ArrayBuffer(44 + frames * channelCount * 2);
  const view = new DataView(bytes);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * channelCount * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, frames * channelCount * 2, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      // Clamped before scaling: a mix can carry samples outside -1..1, and a wrapped 16-bit value
      // is a loud click rather than a loud sample.
      const sample = Math.max(-1, Math.min(1, channels[channel]?.[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/**
 * Whether a failed decode means "nothing to decode" rather than "this is broken".
 *
 * There is no code to read: `decodeAudioData` rejects with a bare `EncodingError` for a file it
 * cannot make sense of, and a silent video is one of the things it cannot make sense of. So the
 * caller is told there is no sound rather than that the file is bad, which is the kinder of the two
 * when they are indistinguishable.
 */
function isEmptyDecode(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'EncodingError' || name === 'NotSupportedError';
}

function newId(): string {
  return `snd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
