import { Capacitor } from '@capacitor/core';

import { debugWarn } from '../host/debug';
import { browserMediaHost, mediaDuration, withoutExtension } from '../host/defaults';
import type {
  EditorMediaHost,
  EditorSoundLibrary,
  EditorSource,
  EditorVoiceHost,
  ReleaseRequest,
  SavedSound,
  ThumbnailRequest,
} from '../host/host.types';
import { readVoiceTake } from '../host/read-file';
import { webViewUrl } from '../host/web-view-url';

import { VideoComposer } from './index';

/*
 * The editor's media host over the package's own composer, which every Capacitor host was writing
 * for itself around the same calls: the probe, the filmstrip, the microphone and the sound library,
 * each a few lines over `VideoComposer` and each written again in every app, with small differences
 * that were mistakes - a probe and an extract that read `sourcePath!` of a source with none, a probe
 * that called a file the composer had opened unreadable because a `<video>` could not open it too, a
 * voiceover take kept by a name its folder forgets within a day (see [nativeVoice]).
 *
 * It is here, at the package root, rather than beside `browserMediaHost` in `capacitor-video-kit/ui`,
 * because it calls the plugin and that entry must never reach `@capacitor/core`; `composerRenderHost`
 * is here for the same reason. The browser host it starts from has nothing of Stencil in it, so this
 * half carries a copy of it the way it carries a copy of `RenderFailedError`.
 *
 * What stays the host's is what differs between apps: the pickers, since a pick is a source in the
 * app's own terms (a `File` to upload, a path a draft keeps: `retainPickedFile` and `gallerySource`
 * are the kit's parts for writing one), and `release`, since only the app knows what one of its
 * sources cost and which two share a file. For those pickers, [probeMediaDuration] is the same probe
 * for a file that is not a source yet.
 */

/** The pickers a host brings to [composerMediaHost]: any of the four, each the editor's own contract. */
export type ComposerMediaPickers = Partial<Pick<EditorMediaHost, 'pickVideo' | 'pickMedia' | 'pickImage' | 'pickAudio'>>;

export interface ComposerMediaHostOptions {
  /**
   * The host's own pickers, used on every platform, each resolving null on a cancel. Each one left out
   * is the browser host's: a file input, and for `pickAudio` the kit's own document picker on iOS in
   * a Capacitor app, which is why a native host leaves that one out.
   *
   * A host that brings `pickVideo` and no `pickMedia` has no `pickMedia` at all, so that with pictures
   * on its clip pickers fall back to its own `pickVideo`, as [EditorMediaHost.pickMedia] says they do,
   * rather than to a file input that hands a phone a clip with no path behind it.
   *
   * Each is called as a method of this object, so a service that passes itself keeps its `this`.
   *
   * A picker that mints object URLs of its own - `pickMediaFiles` is one - in a page has them held
   * until the host's own `release` revokes them, because the browser host's revokes only what its own
   * pickers minted. A host whose pickers are for a phone alone passes them only there, and keeps the
   * browser's in a page.
   */
  pickers?: ComposerMediaPickers;

  /**
   * What the host gives back once the edit has settled which sources it dropped: see
   * [EditorMediaHost.release]. It runs after the browser host's own, which revokes only the object
   * URLs its own pickers minted, so a host that keeps any browser picker has those given back too
   * and never sees one revoked that it minted itself. Left out, the browser host's alone.
   */
  release?: (request: ReleaseRequest) => void;

  /**
   * Where the customer's kept sounds live. Defaults to `'browser'`.
   *
   * - `'browser'`: the library the page keeps in IndexedDB (`browserSoundLibrary`). A sound is a
   *   `blob:` URL, so a host whose drafts keep bytes keeps it with the draft, and a render on a phone
   *   writes it out as a file first (`withNativeRenderInputs`). The cost is the page's: the audio is
   *   decoded to WAV, about ten megabytes a minute.
   * - `'native'`: the composer's own library, `listSounds`, `extractAudio` and `deleteSound`: a file
   *   per sound in the app's storage with a record beside it, the compressed track remuxed where the
   *   platform can manage it rather than decoded. A sound is a `file://` URI, which the preview
   *   plays through `platform.fileUrl` and the engine reads where it is; a draft that keeps paths
   *   keeps it for as long as the sound is in the library. On the web this is the browser library,
   *   because the web composer keeps its sounds in that same IndexedDB store: it is one library
   *   either way, and asking the page's copy spares loading the web composer to reach it.
   * - An [EditorSoundLibrary] of the host's own, on every platform.
   */
  sounds?: 'browser' | 'native' | EditorSoundLibrary;

  /**
   * The voiceover recorder. Left out, the composer's own on a phone (see [nativeVoice]), and none in a
   * page, as the browser defaults have none: the web composer's recorder answers a `videokit-file:`
   * name, the durable one its jobs write down, and that is nothing the editor's preview can play.
   * `false` is none anywhere, and the voiceover sheet does not offer itself. An [EditorVoiceHost] of
   * the host's own is used on every platform.
   *
   * The composer's recorder asks for the microphone on the first take, so an iOS host declares
   * `NSMicrophoneUsageDescription` in its `Info.plist` or passes `false`: iOS terminates an app that
   * asks without one. Android's `RECORD_AUDIO` comes with the kit's own manifest.
   */
  voice?: false | EditorVoiceHost;
}

/**
 * The editor's media host for a Capacitor app: `host.media` in one line, the browser host with the
 * composer behind every member a phone has a better answer for.
 *
 * On a phone:
 * - `probeDuration` asks the composer for the container's own length on `sourcePath`, which needs no
 *   decoder, and falls back on the browser probe (see [probeNatively]);
 * - `thumbnails` has the composer cut the frames from `sourcePath` and answers them as URLs the
 *   WebView may load ([webViewUrl]), and is the browser's canvas for a source with no path;
 * - `voice` is the composer's recorder unless [ComposerMediaHostOptions.voice] says otherwise;
 * - `sounds` is the composer's library when [ComposerMediaHostOptions.sounds] asks for it.
 *
 * In a page it is the browser host, with whatever the host brought. The pickers and `release` are
 * the host's on every platform, and the browser host's where it brought none.
 *
 * The platform is read once, here: it cannot change under a page, and whether `voice` is there at
 * all is what decides whether the editor offers the voiceover sheet.
 */
export function composerMediaHost(options: ComposerMediaHostOptions = {}): EditorMediaHost {
  const browser = browserMediaHost();
  const native = Capacitor.isNativePlatform();
  const voice = options.voice ?? (native ? nativeVoice() : false);
  const { pickMedia, ...browserMembers } = browser;

  return {
    ...browserMembers,
    // Kept only where the host did not bring a video picker of its own: see [ComposerMediaHostOptions.pickers].
    ...(options.pickers?.pickVideo && !options.pickers.pickMedia ? {} : { pickMedia }),
    ...hostPickers(options.pickers),
    ...(native
      ? {
          probeDuration: (source: EditorSource) => probeNatively(source, browser),
          thumbnails: (request: ThumbnailRequest) => nativeThumbnails(request, browser),
        }
      : {}),
    sounds: soundLibrary(options.sounds, browser, native),
    release: releaseWith(browser, options.release),
    ...(voice ? { voice } : {}),
  };
}

/** The pickers the host brought, each bound to the object it came on. */
function hostPickers(pickers: ComposerMediaPickers | undefined): ComposerMediaPickers {
  const bound: ComposerMediaPickers = {};
  if (pickers?.pickVideo) bound.pickVideo = pickers.pickVideo.bind(pickers);
  if (pickers?.pickMedia) bound.pickMedia = pickers.pickMedia.bind(pickers);
  if (pickers?.pickImage) bound.pickImage = pickers.pickImage.bind(pickers);
  if (pickers?.pickAudio) bound.pickAudio = pickers.pickAudio.bind(pickers);
  return bound;
}

/**
 * [EditorMediaHost.probeDuration] on a phone: the composer's answer on `sourcePath`, rounded, when it
 * has a length to give.
 *
 * The browser probe is the fallback, reading the source as the preview plays it: for a source with no
 * path, a composer that could not read the file, and a file it opened with no finite length, where a
 * `<video>` element sometimes knows better. A file the composer opened is never called unreadable
 * because the element could not open it too - that is 0, the contract's answer for a file that opens
 * with no length, rather than a rejection, which the editor shows as a clip that has gone.
 */
async function probeNatively(source: EditorSource, browser: EditorMediaHost): Promise<number> {
  if (!source.sourcePath) return await browser.probeDuration(source);
  const composer = await composerDuration(source.sourcePath, source.key);
  if (composer) return composer;
  try {
    return await browser.probeDuration(source);
  } catch (error) {
    if (composer === 0) return 0;
    throw error;
  }
}

/**
 * What the composer makes of a file's length: milliseconds, rounded, when it read one; 0 when it
 * opened the file and found no finite length; null when it could not read the file at all. The
 * difference between the last two is what lets [probeNatively] and [probeMediaDuration] call a file
 * the composer opened 0 long, rather than unreadable, when a media element cannot open it either.
 */
async function composerDuration(uri: string, label: string): Promise<number | null> {
  try {
    const { durationMs } = await VideoComposer.probe({ uri });
    return durationMs > 0 ? Math.round(durationMs) : 0;
  } catch (error) {
    debugWarn('[composer probe] could not read', label, error);
    return null;
  }
}

/** What Capacitor's `convertFileSrc` rewrites: a file on the device, rather than a URL the page loads. */
const DEVICE_FILE = /^(\/|file:\/\/|content:\/\/)/i;

/**
 * How long a video or a sound runs, for a host measuring a file outside the editor: a track its own
 * audio picker chose, a clip before it becomes a source. Milliseconds; 0 for a file that opens with
 * no length to give; null for one that neither the composer nor the page can open, which a host
 * refuses at the pick rather than letting a render fail on it later.
 *
 * On a phone a device file - a bare path, a `file://` or a `content://` URI - is asked of the
 * composer first, which reads the container's own length and needs no decoder. The page's own media
 * element is the fallback, through [webViewUrl], for a file the composer could not read or found no
 * length in, and the only probe for a `blob:`, `data:` or `http(s):` URL and for anything in a page.
 * It is [probeNatively]'s rule for a URI rather than a source, and the element is the browser host's
 * (`mediaDuration` in `host/defaults`), a `<video>` or an `<audio>` as `kind` says, with that kind's
 * timeout.
 *
 * Here, at the package root, because it calls the plugin. The platform is read at each call, since
 * nothing here is built once.
 */
export async function probeMediaDuration(uri: string, kind: 'video' | 'audio' = 'video'): Promise<number | null> {
  const composer = Capacitor.isNativePlatform() && DEVICE_FILE.test(uri) ? await composerDuration(uri, uri) : null;
  if (composer) return composer;
  return (await mediaDuration(kind, webViewUrl(uri))) ?? composer;
}

/**
 * [EditorMediaHost.thumbnails] on a phone. The composer writes JPEGs into a cache folder, and the
 * WebView may load them only through Capacitor's local server, so each goes through [webViewUrl]. A
 * source with no path is one the composer cannot open, and gets the browser's canvas instead. A
 * failure rejects as the composer's own: the editor falls back on the poster frame for it.
 */
async function nativeThumbnails(request: ThumbnailRequest, browser: EditorMediaHost): Promise<string[]> {
  const { source, timesMs, maxHeight, precise } = request;
  if (!source.sourcePath) return await browser.thumbnails(request);
  const { uris } = await VideoComposer.thumbnails({ uri: source.sourcePath, timesMs: [...timesMs], maxHeight, precise });
  return uris.map(webViewUrl);
}

/** [ComposerMediaHostOptions.sounds], as the library the editor is handed. */
function soundLibrary(
  choice: ComposerMediaHostOptions['sounds'],
  browser: EditorMediaHost,
  native: boolean,
): EditorSoundLibrary | undefined {
  if (typeof choice === 'object') return choice;
  return choice === 'native' && native ? nativeSoundLibrary() : browser.sounds;
}

/** [ComposerMediaHostOptions.release], after the browser host's own. */
function releaseWith(
  browser: EditorMediaHost,
  release: ComposerMediaHostOptions['release'],
): ((request: ReleaseRequest) => void) | undefined {
  if (!release) return browser.release;
  return (request) => {
    browser.release?.(request);
    release(request);
  };
}

/**
 * The composer's sound library, as the editor's. The composer's folder IS the list - a file and a
 * small record beside it per sound - so nothing is kept in the page, and a list here and files there
 * cannot come apart the first time one of them is cleared without the other.
 *
 * `extract` reads `sourcePath`, the file itself, and a source's `playbackUrl` only when it has no
 * path. A `blob:` URL is one no native call can open, so the composer refuses a source that has
 * nothing else, and the editor reports that as the failure it is. The sound is named after the
 * video without its extension, as the browser library names one; a source with no name is left to
 * the composer, which names the sound after the file it read (`SoundLibrary.extract` on iOS and on
 * Android) rather than calling it `Sound`. A video with no audio track is null, which the composer
 * reports rather than rejecting, and a result missing its id or its URI is a native side answering
 * something this does not understand, and is taken the same way.
 */
function nativeSoundLibrary(): EditorSoundLibrary {
  return {
    async list(): Promise<readonly SavedSound[]> {
      const { sounds } = await VideoComposer.listSounds();
      return sounds.map((sound) => ({
        id: sound.id,
        uri: sound.uri,
        fileName: sound.fileName || 'Sound',
        durationMs: sound.durationMs,
        savedAt: sound.savedAt,
        ...(sound.sourceName ? { sourceName: sound.sourceName } : {}),
      }));
    },

    async extract(source: EditorSource): Promise<SavedSound | null> {
      const uri = source.sourcePath ?? source.playbackUrl;
      if (!uri) throw new Error(`there is no file behind ${source.fileName}`);
      const name = withoutExtension(source.fileName);
      const result = await VideoComposer.extractAudio({ uri, ...(name ? { fileName: name } : {}) });
      if (!result.hasAudio || !result.id || !result.uri) return null;
      return {
        id: result.id,
        uri: result.uri,
        fileName: result.fileName || 'Sound',
        durationMs: result.durationMs ?? 0,
        savedAt: result.savedAt ?? Date.now(),
        ...(source.fileName ? { sourceName: source.fileName } : {}),
      };
    },

    async remove(id: string): Promise<void> {
      await VideoComposer.deleteSound({ id });
    },
  };
}

/**
 * How long reading a finished take into the page may take before it is handed over as its file. The
 * editor gives the whole of `stop` 8 seconds (`STOP_TIMEOUT_MS` in `ve-voiceover-sheet`), the
 * recorder's own stop included, and tells the customer the take could not be saved when that runs
 * out. A local file of under a megabyte a minute reads in milliseconds, so running into this is an
 * overloaded phone, and the rest of the editor's budget is left to the recorder.
 */
const TAKE_READ_TIMEOUT_MS = 3000;

/**
 * The composer's microphone, as the editor's. `start` and a failed `stop` go through as the composer
 * answers them, because the editor reads their codes: `already_recording` is a recorder a reloaded
 * page left open, which it stops and starts again, and `permission_denied` is its sentence about
 * Settings.
 *
 * WHY A TAKE COMES BACK AS AN OBJECT URL. The recorder writes the take into its cache folder
 * (`video-composer/voice` under the app's caches), which the plugin's next load empties of anything a
 * day old, and which the system may empty sooner. The editor's preview and the render would read that
 * file well enough, but a draft is kept past a day, and a host that keeps a draft's files by name - a
 * path beats a copy, for a clip that is already in the customer's library - would reopen it to a
 * voiceover with nothing behind it. So the take is read into the page (`takeInPage`) and handed over
 * exactly as a browser's sound is: the preview plays it, a draft keeps its bytes, and a render on a
 * phone writes it out as a file of its own again (`withNativeRenderInputs`). A take is small - AAC at
 * 96 kbps in one channel, under a megabyte a minute.
 *
 * What the copy costs is memory for as long as the page lives: no take's URL is ever revoked.
 * `release` names sources and never a take, and a take the editor kept is read again after the editor
 * has gone - by a draft, by a render, by an edit opened again on the same manifest - so nothing here
 * can tell when its last reader is done. The editor also stops takes nobody will place, and a stop
 * cannot say who is waiting on it, so those are read and held all the same: the sheet turning the
 * microphone straight back off when it closed, or lost its room, while the permission prompt was up
 * (`beginTake` in `ve-voiceover-sheet`), and the editor taken away mid take (`disconnectedCallback`
 * in `ve-editor`). Those are a moment long, or one take. The one that can run for minutes - a
 * recorder a reloaded page left running, which `openMicrophone` stops after a start refused as
 * `already_recording` - is handed back as its file, unread.
 */
function nativeVoice(): EditorVoiceHost {
  // Set by a start refused as `already_recording`, and spent by the next stop, whatever it answers.
  let leftRunning = false;
  return {
    async start(): Promise<void> {
      try {
        await VideoComposer.startVoiceRecording();
        leftRunning = false;
      } catch (error) {
        leftRunning = (error as { code?: unknown } | null)?.code === 'already_recording';
        throw error;
      }
    },
    async stop(): Promise<{ uri: string; durationMs: number }> {
      const unread = leftRunning;
      leftRunning = false;
      const take = await VideoComposer.stopVoiceRecording();
      return { uri: unread ? take.uri : await takeInPage(take.uri), durationMs: take.durationMs };
    },
  };
}

/**
 * The recorder's file as an object URL over its bytes, read and typed as the recorder writes it by
 * [readVoiceTake], because a render names the file it stages after the type (`extensionFor` in
 * `render-inputs`) and Capacitor's iOS local server answers a whole file with none.
 *
 * A take that cannot be read into the page, an empty one included, or not within
 * [TAKE_READ_TIMEOUT_MS], is handed over by its file instead, which the preview and the render
 * still read today: a take the customer just recorded must not be lost over the step that was only
 * ever about a draft reopened tomorrow. A read
 * that finishes after the timeout mints nothing, since nobody is waiting on it. The file is not
 * deleted either way, because the page cannot delete one, and the first load of the plugin once the
 * take is a day old sweeps it.
 */
async function takeInPage(uri: string): Promise<string> {
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async (): Promise<string> => {
    const bytes = await readVoiceTake(uri);
    return late ? uri : URL.createObjectURL(bytes);
  })();
  const slow = new Promise<string>((settle) => {
    timer = setTimeout(() => {
      late = true;
      debugWarn('[composerMediaHost] the take was too slow to read into the page, and is kept as its file', uri);
      settle(uri);
    }, TAKE_READ_TIMEOUT_MS);
  });
  try {
    // A read that rejects after the timeout won is still handled: `race` listens to both.
    return await Promise.race([read, slow]);
  } catch (error) {
    debugWarn('[composerMediaHost] could not read the take into the page, and kept it as its file', uri, error);
    return uri;
  } finally {
    clearTimeout(timer);
  }
}
