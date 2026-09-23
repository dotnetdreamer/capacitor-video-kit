import {
  DEFAULT_OUTPUT,
  OUTPUT_FPS,
  OUTPUT_QUALITIES,
  aspectOf,
  normaliseOutput,
  outputFor,
  qualityOf,
} from '../editor';

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
      return {
        key: `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        fileName: file.name,
        playbackUrl,
      };
    },

    /** One file input offering both, and the file's own type says which it turned out to be. */
    async pickMedia(): Promise<EditorSource | null> {
      const file = await pickFile('video/*,image/*');
      if (!file) return null;
      const playbackUrl = URL.createObjectURL(file);
      minted.add(playbackUrl);
      return {
        key: `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        fileName: file.name,
        playbackUrl,
        kind: file.type.startsWith('image/') ? 'image' : 'video',
      };
    },

    async pickImage(): Promise<PickedImage | null> {
      const file = await pickFile('image/*');
      if (!file) return null;
      const uri = URL.createObjectURL(file);
      const aspect = await imageAspect(uri);
      if (aspect === null) throw new Error(`The browser could not decode ${file.name}`);
      return { uri, fileName: file.name, aspect };
    },

    async pickAudio(): Promise<PickedAudio | null> {
      const file = await pickFile('audio/*');
      if (!file) return null;
      const uri = URL.createObjectURL(file);
      const durationMs = await mediaDuration('audio', uri, AUDIO_METADATA_TIMEOUT_MS);
      if (durationMs === null) throw new Error(`The browser could not open ${file.name}`);
      return { uri, fileName: file.name, sourceDurationMs: durationMs };
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
 * One file from the customer, or null when they closed the picker without choosing.
 *
 * The `cancel` event is what tells the two apart, and every browser the editor supports has fired
 * it since 2023. A browser that does not simply leaves the promise pending, which reads as a
 * picker still being open - the same thing the customer sees.
 */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    const done = (file: File | null): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
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
