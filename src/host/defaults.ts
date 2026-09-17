import { setEditorDebug } from './debug';
import type {
  EditorKeyboardHost,
  EditorMediaHost,
  EditorSource,
  PickedAudio,
  PickedImage,
  ResolvedEditorHost,
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
      debug: platform?.debug ?? false,
    },
  };
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
 * Pickers, probes and filmstrip frames done entirely in the page.
 *
 * Sources it hands back carry a blob URL and no `sourcePath`, because in a browser there is no
 * path: the file exists only for as long as the tab does. That is also why nothing here revokes a
 * URL it created - the manifest can still be pointing at it, and undo can bring back a segment
 * that was removed ten steps ago.
 */
export function browserMediaHost(): EditorMediaHost {
  return {
    async pickVideo(): Promise<EditorSource | null> {
      const file = await pickFile('video/*');
      if (!file) return null;
      return {
        key: `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        fileName: file.name,
        playbackUrl: URL.createObjectURL(file),
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
  };
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
