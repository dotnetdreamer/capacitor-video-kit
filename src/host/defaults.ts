import {
  DEFAULT_OUTPUT,
  OUTPUT_FPS,
  OUTPUT_QUALITIES,
  aspectOf,
  normaliseOutput,
  outputFor,
  qualityOf,
} from '../editor';

import type { PickAudioFileResult } from '../video-composer/definitions';
import { resolve } from '../web-runtime/files';
import { deleteSound, extractAudio, listSounds, saveSound } from '../web-runtime/sounds';

import { setEditorDebug } from './debug';
import type {
  EditorInsets,
  EditorOutputOptions,
  EditorKeyboardHost,
  EditorMediaHost,
  EditorSoundLibrary,
  EditorSource,
  PickedAudio,
  PickedImage,
  PickedMediaFile,
  ReleaseRequest,
  ResolvedEditorHost,
  ResolvedOutputOptions,
  SavedSound,
  ThumbnailRequest,
  VideoEditorHost,
} from './host.types';

/**
 * What the editor falls back on for everything a host did not supply.
 *
 * All of it is plain web: a file input for the pickers, a `<video>` element for the durations, a
 * canvas for the filmstrip, `visualViewport` for the keyboard. None of it is a stub - an editor
 * built on these defaults opens a real file, plays it, cuts a real filmstrip and hands back a real
 * manifest, which is what makes the package droppable into a plain page with no host at all.
 *
 * One member reaches past the page, and only where the page cannot be trusted: on iOS in a
 * Capacitor app built with the kit's native side the audio picker is the kit's own document picker,
 * reached through the bridge the app already has (see [pickAudioThroughKit]). A host that spreads
 * these defaults into its own media host gets that with the rest.
 *
 * The one thing with no web answer is the render, so it stays null. The editor greys nothing for
 * it: the edit is still an edit, and the manifest still comes back at the end.
 */

/** A media element that never fires either event would otherwise hang the caller for good. */
const VIDEO_METADATA_TIMEOUT_MS = 10_000;
const AUDIO_METADATA_TIMEOUT_MS = 5000;
const IMAGE_DECODE_TIMEOUT_MS = 8000;
/** A seek that never lands leaves the whole filmstrip waiting on it, so each tile has its own. */
const FRAME_SEEK_TIMEOUT_MS = 4000;

/**
 * The sound formats the default audio picker names one by one, each as its extensions and its MIME
 * types, several of which have two spellings in the wild.
 *
 * `audio/*` alone is enough everywhere but WebKit on iOS. A WKWebView turns every entry of `accept`
 * into a Uniform Type Identifier for the Files picker, and has none for a wildcard of this kind: it
 * makes up a type that no file has, so the picker opens with every song in it greyed out, and the
 * only other things its menu offers are the photo library and the camera. A MIME type or an
 * extension that WebKit can map to a real identifier adds that type, and one it cannot map adds
 * nothing, so naming each format both ways costs nothing and covers whichever of the two a WebKit
 * resolves. A format missing here is a line to add, and nothing else has to change with it.
 *
 * A Capacitor app on iOS built with the kit's native side never opens this input for a sound at all,
 * because WebKit's input fails there in a worse way than this one (see [pickAudioThroughKit]). The
 * list is still what Safari and any other iOS page without that native side get, and it costs every
 * other engine nothing.
 */
const AUDIO_FORMATS: readonly (readonly string[])[] = [
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4', 'audio/x-m4a'],
  ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav', 'audio/x-wav'],
  ['.aif', '.aiff', 'audio/aiff', 'audio/x-aiff'],
  ['.caf', 'audio/x-caf'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
];

/**
 * `audio/*` FIRST, and then the list. First is what every engine but WebKit goes by: a desktop
 * browser filters by the whole set, of which the wildcard is the widest, and an Android WebView opens
 * its documents browser for the first type and hands the rest to it as extra types, so both offer
 * exactly what they offered before the list existed.
 */
const AUDIO_ACCEPT = ['audio/*', ...AUDIO_FORMATS.flat()].join(',');

/**
 * Fills in everything the host left out. Called once, by whoever owns the editor element, and the
 * result is what every other file in the package is written against.
 */
export function resolveEditorHost(host?: VideoEditorHost): ResolvedEditorHost {
  const platform = host?.platform;
  setEditorDebug(platform?.debug ?? false);
  return {
    media: host?.media ?? browserMediaHost(),
    render: host?.render ?? null,
    platform: {
      fileUrl: platform?.fileUrl ?? identityFileUrl,
      haptic: platform?.haptic ?? noHaptic,
      keyboard: platform?.keyboard ?? visualViewportKeyboard(),
      registerBackHandler: platform?.registerBackHandler ?? noBackHandler,
      confirm: platform?.confirm?.bind(platform) ?? null,
      // Bound, because a host that implements these as methods of a class or an Angular service
      // loses `this` the moment the editor holds the function on its own.
      measureInsets: platform?.measureInsets?.bind(platform) ?? null,
      debug: platform?.debug ?? false,
    },
    output: resolveOutputOptions(host?.output),
    editing: {
      replaceKeepsLength: host?.editing?.replaceKeepsLength ?? true,
      // Off unless the host says so: an app that has never heard of pictures on the timeline keeps
      // pickers that offer what they always offered.
      pictures: host?.editing?.pictures === true,
    },
  };
}

/**
 * What the editor may offer for the finished post, with every absence filled in.
 *
 * An absent list means ALL of them, which is what every host meant before it could say otherwise.
 * A list that names nothing this package has is treated as absent too rather than leaving the
 * quality sheet with an empty row: a typo in an app's configuration should cost it the setting, not
 * the feature.
 */
function resolveOutputOptions(options?: EditorOutputOptions): ResolvedOutputOptions {
  const qualities = keep(
    OUTPUT_QUALITIES.map((one) => one.id),
    options?.qualities,
  );
  const fps = keep([...OUTPUT_FPS], options?.fps);
  const aspects = keep(['9:16', '16:9'] as const, options?.aspects);
  // The host's own starting frame, or the smallest thing it allows - never a frame its own editor
  // would not offer, which would open the quality sheet with nothing lit.
  const wanted = options?.initial ? normaliseOutput(options.initial) : DEFAULT_OUTPUT;
  const allowed =
    qualities.includes(qualityOf(wanted).id) && fps.includes(wanted.fps) && aspects.includes(aspectOf(wanted));
  return {
    qualities,
    fps,
    aspects,
    initial: allowed ? wanted : outputFor(aspects[0], qualities[0], fps[0]),
  };
}

/** The package's own list, narrowed to what the host asked for, in the package's order. */
function keep<T>(all: readonly T[], wanted: readonly T[] | undefined): T[] {
  if (!wanted?.length) return [...all];
  const kept = all.filter((one) => wanted.includes(one));
  return kept.length > 0 ? kept : [...all];
}

/** A browser picker already hands back a blob URL, which is loadable as it stands. */
function identityFileUrl(uri: string): string {
  return uri;
}

function noHaptic(): void {
  /* A browser, and a phone without a motor, both do nothing here. */
}

function noBackHandler(): () => void {
  return () => undefined;
}

/**
 * The keyboard's height from `visualViewport`, which is the only measurement a browser offers.
 *
 * The viewport shrinks from the bottom when the keyboard opens, so what is left over between it
 * and the window is the keyboard. A browser with no `visualViewport` reports 0 forever, which is
 * the same thing a desktop keyboard does.
 */
export function visualViewportKeyboard(): EditorKeyboardHost {
  return {
    subscribe(listener: (heightPx: number) => void): () => void {
      const viewport = typeof window === 'undefined' ? null : window.visualViewport;
      if (!viewport) {
        listener(0);
        return () => undefined;
      }
      const report = (): void => {
        listener(Math.max(0, Math.round(window.innerHeight - (viewport.height + viewport.offsetTop))));
      };
      viewport.addEventListener('resize', report);
      viewport.addEventListener('scroll', report);
      report();
      return () => {
        viewport.removeEventListener('resize', report);
        viewport.removeEventListener('scroll', report);
      };
    },
  };
}

/**
 * The safe area as the page itself reports it, read back out of `env(safe-area-inset-*)` through a
 * probe element, because CSS will apply those values but offers no way to ask for them.
 *
 * This is not what `resolveEditorHost` leaves behind for a host that supplied no `measureInsets`,
 * and [ResolvedPlatformHost.measureInsets] says why: the editor's own padding already falls back to
 * `env()`, so handing the same numbers back through JavaScript would only overwrite a host that set
 * `--ve-safe-top` itself. It is here for the host that needs the measurement path anyway - one
 * rendering the editor inside its own chrome, or one that has to pair the insets with a bar of its
 * own - and as the shape a native implementation answers in:
 *
 * ```ts
 * resolveEditorHost({ platform: { measureInsets: envSafeAreaInsets } });
 * ```
 */
export async function envSafeAreaInsets(): Promise<EditorInsets> {
  const parent = typeof document === 'undefined' ? null : (document.body ?? document.documentElement);
  if (!parent) return { top: 0, bottom: 0 };

  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  parent.appendChild(probe);
  try {
    const padding = getComputedStyle(probe);
    return { top: cssPixels(padding.paddingTop), bottom: cssPixels(padding.paddingBottom) };
  } finally {
    probe.remove();
  }
}

/** A length a browser resolved to nothing reads back as '' or 'auto', and an inset is never below 0. */
function cssPixels(value: string): number {
  const px = Number.parseFloat(value);
  return Number.isFinite(px) && px > 0 ? px : 0;
}

/**
 * Pickers, probes and filmstrip frames done entirely in the page.
 *
 * Sources it hands back carry a blob URL and no `sourcePath`, because in a browser there is no
 * path: the file exists only for as long as the tab does. Nothing here revokes such a URL while the
 * edit is running - the manifest can still be pointing at it, and undo can bring back a segment
 * that was removed ten steps ago - which is exactly what `release` is the one safe moment for.
 */
export function browserMediaHost(): EditorMediaHost {
  /*
   * The object URLs this host minted, so `release` gives back what it took and nothing else. A
   * source the application handed to the editor may be pointing at a blob URL the application still
   * holds a reference to, and revoking that one empties whatever is playing it with no error.
   */
  const minted = new Set<string>();

  return {
    async pickVideo(): Promise<EditorSource | null> {
      const file = await pickFile('video/*');
      if (!file) return null;
      const playbackUrl = URL.createObjectURL(file);
      minted.add(playbackUrl);
      return { key: pickedKey(), fileName: file.name, playbackUrl };
    },

    /** One file input offering both, and the file's own type says which it turned out to be. */
    async pickMedia(): Promise<EditorSource | null> {
      const file = await pickFile('video/*,image/*');
      if (!file) return null;
      const playbackUrl = URL.createObjectURL(file);
      minted.add(playbackUrl);
      return { key: pickedKey(), fileName: file.name, playbackUrl, kind: isPicture(file) ? 'image' : 'video' };
    },

    async pickImage(): Promise<PickedImage | null> {
      const file = await pickFile('image/*');
      if (!file) return null;
      const uri = URL.createObjectURL(file);
      const aspect = await imageAspect(uri);
      if (aspect === null) throw new Error(`The browser could not decode ${file.name}`);
      return { uri, fileName: file.name, aspect };
    },

    /**
     * A sound from the customer's files: through the kit's own document picker on iOS in a
     * Capacitor app built with it, where WebKit's file input cannot be trusted with one (see
     * [pickAudioThroughKit]), and through the file input, naming its formats, everywhere else -
     * an iOS build without the picker included, for the reason [bridgeWithAudioPicker] gives. Both
     * answer the same way, with an object URL over the bytes.
     */
    async pickAudio(): Promise<PickedAudio | null> {
      const bridge = bridgeWithAudioPicker();
      if (bridge) return await pickAudioThroughKit(bridge);
      const file = await pickFile(AUDIO_ACCEPT);
      if (!file) return null;
      return await pickedAudio(file, file.name);
    },

    async probeDuration(source: EditorSource): Promise<number> {
      const src = source.playbackUrl ?? source.sourcePath ?? '';
      const durationMs = await mediaDuration('video', src, VIDEO_METADATA_TIMEOUT_MS);
      if (durationMs === null) throw new Error(`The browser could not open ${source.fileName}`);
      return durationMs;
    },

    thumbnails(request: ThumbnailRequest): Promise<string[]> {
      return canvasThumbnails(request);
    },

    sounds: browserSoundLibrary(),

    /**
     * Gives back the files behind the clips the edit dropped, which in a browser means revoking
     * their object URLs: one of those holds a whole picked video in the tab for as long as the page
     * lives, and nothing else ever hands that memory back.
     *
     * A URL a kept source still names is left alone. Two sources sharing one URL is the host's own
     * doing rather than this host's, but it is the case both lists are here for and it costs a set.
     */
    release({ kept, dropped }: ReleaseRequest): void {
      const held = new Set<string>();
      for (const source of kept) {
        if (source.playbackUrl) held.add(source.playbackUrl);
      }
      for (const source of dropped) {
        const url = source.playbackUrl;
        // `delete` answers whether this host minted it and retires it in the same breath, so a
        // second release, or a source listed twice, revokes nothing twice.
        if (!url || held.has(url) || !minted.delete(url)) continue;
        URL.revokeObjectURL(url);
      }
    },
  };
}

/**
 * Up to `limit` clips from the customer's files at once, each with how long it runs, for the step
 * BEFORE the editor: a new project, a template's slots. The editor's own pickers take one file at a
 * time, and this is the same file input asked for several, in the order the browser lists them.
 *
 * An empty array is a cancel, which is an ordinary answer and not a failure: somebody opened the
 * picker, changed their mind and backed out. `limit` caps what is kept when more were chosen, since
 * a file input can only be told one or many; 0 keeps them all.
 *
 * `pictures` offers stills beside the videos, for a host that lets them onto the timeline (see
 * [EditorEditingOptions.pictures]). A picture comes back with `kind: 'image'` and a length of 0,
 * because a still has none - the editor gives it its own - and without being opened, because
 * opening one as a video would only wait out the timeout. A video's length is asked of the element
 * that will play it, because a `File` has none; one that never answers within ten seconds, or
 * cannot be opened at all, is 0, which is what the platform probes answer for a length they cannot
 * read.
 *
 * Every source carries a `blob:` URL and no `sourcePath`, like every pick in a page, and the URLs
 * are the CALLER's: the browser host's `release` revokes only what its own pickers minted, so a host
 * done with one of these revokes it itself.
 */
export async function pickMediaFiles({ limit, pictures }: { limit: number; pictures?: boolean }): Promise<PickedMediaFile[]> {
  const files = await pickFiles(pictures ? 'video/*,image/*' : 'video/*', limit !== 1);
  const chosen = limit > 0 ? files.slice(0, limit) : files;
  return Promise.all(
    chosen.map(async (file): Promise<PickedMediaFile> => {
      const playbackUrl = URL.createObjectURL(file);
      if (isPicture(file)) {
        return { source: { key: pickedKey(), fileName: file.name, playbackUrl, kind: 'image' }, durationMs: 0 };
      }
      const durationMs = await mediaDuration('video', playbackUrl, VIDEO_METADATA_TIMEOUT_MS);
      return { source: { key: pickedKey(), fileName: file.name, playbackUrl, kind: 'video' }, durationMs: durationMs ?? 0 };
    }),
  );
}

/**
 * A sound library kept in the page: the audio decoded out of a video, written to IndexedDB, and
 * still there after a reload.
 *
 * It is a real library rather than a stub - the sounds outlive the tab, and a page with no host at
 * all can extract one, keep it and use it in a later edit - which is the same promise the pickers
 * and the filmstrip above make. What it cannot do is do it cheaply: `web-runtime/sounds` says why a
 * browser's only door to the audio inside an MP4 costs a WAV.
 *
 * Exported, because a host that supplies its own `media` loses every default in this file along with
 * the ones it meant to replace, and a web application with a real render but no filesystem still
 * wants this one:
 *
 * ```ts
 * media: { ...myMediaHost, sounds: browserSoundLibrary() }
 * ```
 */
export function browserSoundLibrary(): EditorSoundLibrary {
  return {
    async list(): Promise<readonly SavedSound[]> {
      return await listSounds();
    },

    async extract(source: EditorSource): Promise<SavedSound | null> {
      const src = source.playbackUrl ?? source.sourcePath ?? '';
      if (!src) throw new Error(`there is no file behind ${source.fileName}`);
      const audio = await extractAudio(src);
      if (!audio) return null;
      return await saveSound(audio.blob, {
        fileName: withoutExtension(source.fileName) || 'Sound',
        durationMs: audio.durationMs,
        sourceName: source.fileName,
      });
    },

    async remove(id: string): Promise<void> {
      await deleteSound(id);
    },
  };
}

/** `holiday.mp4` as `holiday`: the library lists sounds, and `.mp4` on a sound reads as a mistake. */
function withoutExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * The four things the default host reads off a Capacitor app's native bridge, without importing
 * `@capacitor/core`: the editor half never does (`src/tsconfig.json`), and a web host has none.
 *
 * A Capacitor app's native side puts `window.Capacitor` into the page before any script runs, and
 * these four are on it from the start: the platform, the local server's URL for a file,
 * `nativePromise`, the call every plugin proxy `registerPlugin` makes is built on, and
 * `PluginHeaders`, the native plugins the app was built with and the methods each one has, which is
 * what that proxy asks before it calls one. So nothing has to be imported or registered first, and
 * the default works whether or not the host has imported the plugin yet.
 */
interface NativeBridge {
  getPlatform(): string;
  convertFileSrc(filePath: string): string;
  nativePromise<R>(pluginName: string, methodName: string, options?: object): Promise<R>;
  PluginHeaders?: readonly { readonly name: string; readonly methods: readonly { readonly name: string }[] }[];
}

/**
 * The bridge, when the page is a Capacitor app on iOS whose native side has `pickAudioFile`; null in
 * a browser, on every other platform, and on an iOS build without the call.
 *
 * WHY THE HEADERS ARE ASKED. iOS's bridge answers NOTHING for a method the native side lacks:
 * `CapacitorBridge.handleJSCall` logs it and returns, so a promise made straight through
 * `nativePromise` never settles. `registerPlugin`'s proxy guards against exactly that, by looking the
 * method up in `PluginHeaders` first and rejecting `UNIMPLEMENTED` when it is missing, and calling
 * the bridge directly skips the proxy. A build without the call is not far-fetched - a pod or package
 * checkout older than the JS, a JS update shipped over the air to an older binary, a native project
 * that leaves the plugin out - and there a pick that never answers holds the editor busy for good,
 * with every picker and Next greyed and nothing said. So such a build gets the file input it had
 * before, which works for every pick but the one `pickAudioThroughKit` is for.
 */
function bridgeWithAudioPicker(): NativeBridge | null {
  const bridge = (globalThis as { Capacitor?: Partial<NativeBridge> }).Capacitor;
  if (typeof bridge?.getPlatform !== 'function' || bridge.getPlatform() !== 'ios') return null;
  if (typeof bridge.nativePromise !== 'function' || typeof bridge.convertFileSrc !== 'function') return null;
  const plugin = bridge.PluginHeaders?.find((header) => header.name === 'VideoComposer');
  return plugin?.methods.some((method) => method.name === 'pickAudioFile') ? (bridge as NativeBridge) : null;
}

/**
 * [EditorMediaHost.pickAudio] on iOS in a Capacitor app: the kit's `pickAudioFile`, then the answer
 * the file input gives everywhere else. Null on a cancel.
 *
 * WHY NOT THE FILE INPUT. WKWebView copies what an input picks into a folder of its own before the
 * page is told, and that copy comes out EMPTY when the same song is picked again about a minute after
 * the first time - which is Replace on a track somebody has just set up - so a good song reads as
 * one the app cannot use. It was measured on an iOS 26.5 simulator, and `pickAudioFile` in
 * `video-composer/plugin.ts` has the whole of it. The kit's document picker makes its own copy.
 *
 * The kit's copy is read through Capacitor's local server, which answers a whole sound with no HTTP
 * status (`resolve` in `web-runtime/files` says why that is not a failure), into a `Blob` typed with
 * the MIME type the picker answered, because the server's answer carries none and a render names
 * its staged copy after it (`withNativeRenderInputs`). An empty file is refused, as a song with no
 * bytes cannot be one anybody picked. What comes back is an object URL over the bytes, exactly as
 * from the input: the preview plays it, a render stages it, a draft keeps the bytes, and nothing
 * after this learns the track came in another way.
 *
 * The copy is not deleted from here, because a page cannot delete a file and a native call to do it
 * would buy back the space of one song until the next launch. It lives in the kit's
 * `tmp/videokit-audio/`, which iOS may empty while the app is not running and the kit's launch sweep
 * clears of anything a day old, and nothing reads it again after this.
 */
async function pickAudioThroughKit(bridge: NativeBridge): Promise<PickedAudio | null> {
  const picked = await bridge.nativePromise<PickAudioFileResult>('VideoComposer', 'pickAudioFile', {});
  if (picked.cancelled || !picked.uri) return null;
  const fileName = picked.fileName || 'Sound';
  const bytes = await resolve(bridge.convertFileSrc(picked.uri));
  if (!bytes.size) throw new Error(`${fileName} is empty`);
  return await pickedAudio(picked.mimeType ? new Blob([bytes], { type: picked.mimeType }) : bytes, fileName);
}

/**
 * A picked sound as the editor takes one: an object URL over its bytes and how long it runs, asked of
 * an element that can play it. A sound that element cannot open is refused, and its URL given back
 * first, because nothing else will ever revoke it.
 */
async function pickedAudio(bytes: Blob, fileName: string): Promise<PickedAudio> {
  const uri = URL.createObjectURL(bytes);
  const durationMs = await mediaDuration('audio', uri, AUDIO_METADATA_TIMEOUT_MS);
  if (durationMs === null) {
    URL.revokeObjectURL(uri);
    throw new Error(`The browser could not open ${fileName}`);
  }
  return { uri, fileName, sourceDurationMs: durationMs };
}

/** One file from the customer, or null when they closed the picker without choosing. */
async function pickFile(accept: string): Promise<File | null> {
  const [file] = await pickFiles(accept, false);
  return file ?? null;
}

/**
 * The files the customer chose, or none when they closed the picker without choosing.
 *
 * The `cancel` event is what tells the two apart, and every browser the editor supports has fired
 * it since 2023. A `change` with nothing in it is a cancel as well, for an engine that reports one
 * that way. A browser that does neither simply leaves the promise pending, which reads as a picker
 * still being open - the same thing the customer sees. The first of the two to arrive settles it,
 * and the input goes with it.
 */
function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    const done = (files: File[]): void => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** The file's own type, which is what says whether a pick from a mixed input was a still. */
function isPicture(file: File): boolean {
  return file.type.startsWith('image/');
}

/**
 * The key a picked file is known by for the life of the edit. Made fresh for every pick rather than
 * from the file, because the same video chosen twice is two clips, and a manifest that gave them
 * one key could not tell them apart.
 */
function pickedKey(): string {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Reads a duration from a throwaway media element. Milliseconds, 0 when the element loaded but
 * reports no finite length (a stream without a header), null on an error or when nothing happened
 * within `timeoutMs`.
 */
function mediaDuration(kind: 'video' | 'audio', src: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const probe = document.createElement(kind);
    probe.preload = 'metadata';
    probe.muted = true;
    let settled = false;
    const done = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.onloadedmetadata = null;
      probe.onerror = null;
      probe.removeAttribute('src');
      probe.load();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    probe.onloadedmetadata = () =>
      done(Number.isFinite(probe.duration) && probe.duration > 0 ? Math.round(probe.duration * 1000) : 0);
    probe.onerror = () => done(null);
    probe.src = src;
  });
}

/**
 * Width over height of a picked photo as it will be DRAWN, or null when the browser cannot decode
 * it at all. A photo the browser cannot decode cannot be drawn as a layer either, so that is a
 * refusal rather than a fallback.
 */
function imageAspect(uri: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const done = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
      resolve(value);
    };
    const timer = setTimeout(() => done(null), IMAGE_DECODE_TIMEOUT_MS);
    img.onload = () => done(img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : null);
    img.onerror = () => done(null);
    img.src = uri;
  });
}

/**
 * Filmstrip frames drawn out of one `<video>` element, seeked to each time in turn.
 *
 * One element and one canvas for the whole strip rather than one each: a WebView holds a small
 * number of hardware decoders and the preview wants one of them, so a strip that opened a decoder
 * per tile would take the picture off the screen while it cut. `precise` is ignored because a
 * browser seek always lands on the frame asked for; it is the native thumbnailers that choose
 * between a keyframe and an exact frame.
 */
async function canvasThumbnails({ source, timesMs, maxHeight }: ThumbnailRequest): Promise<string[]> {
  const src = source.playbackUrl ?? source.sourcePath ?? '';
  if (!src) return [];

  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = src;

  try {
    const opened = await mediaEvent(video, 'loadeddata', VIDEO_METADATA_TIMEOUT_MS);
    if (!opened || !video.videoWidth) return [];

    const height = Math.min(maxHeight, video.videoHeight);
    const width = Math.max(1, Math.round((video.videoWidth / video.videoHeight) * height));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return [];

    const urls: string[] = [];
    for (const timeMs of timesMs) {
      video.currentTime = Math.min(timeMs / 1000, Math.max(0, video.duration - 0.05));
      // A strip that stops short is drawn short, which is better than one tile's bad seek costing
      // the whole strip.
      if (!(await mediaEvent(video, 'seeked', FRAME_SEEK_TIMEOUT_MS))) break;
      context.drawImage(video, 0, 0, width, height);
      urls.push(canvas.toDataURL('image/jpeg', 0.7));
    }
    return urls;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/** Whether `event` arrived before `timeoutMs`, with `error` counting as a no. */
function mediaEvent(video: HTMLVideoElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
      resolve(ok);
    };
    const onEvent = (): void => done(true);
    const onError = (): void => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    video.addEventListener(event, onEvent);
    video.addEventListener('error', onError);
  });
}
