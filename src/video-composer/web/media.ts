import { loadableUrl } from '../../web-runtime/files';
import type { ProbedInput } from './plan';

/**
 * The browser's decoder, which is a `<video>` element.
 *
 * It is worth saying why this is not `VideoDecoder`. WebCodecs decodes ELEMENTARY STREAMS: it wants
 * `EncodedVideoChunk`s, which means demuxing whatever container the customer picked - MP4 from an
 * iPhone, WebM from a screen recorder, MOV, 3GP - before a single frame comes out. A `<video>`
 * element already holds every demuxer and every decoder the platform has, applies rotation
 * metadata, copes with variable frame rates, and works the same on a five-year-old Android as on a
 * desktop. The cost is that it is driven by seeking rather than pulled frame by frame, and that
 * cost is paid here deliberately: a render that is slower and right beats one that is fast for the
 * three formats someone remembered to demux.
 *
 * Seeking is also what makes the renderer DETERMINISTIC. The output timeline is stepped at exactly
 * one frame interval and each step asks for the source time it needs, so a slow phone produces the
 * same video as a fast desktop - just later. Playing the source back in real time and capturing
 * whatever arrived would make the output depend on how busy the machine was.
 */

/** A media element that never fires either event would otherwise hang the caller for good. */
const METADATA_TIMEOUT_MS = 15_000;
const SEEK_TIMEOUT_MS = 8_000;

/** What a `<video>` reports beyond the standard interface, where the browser has it. */
interface AudioAwareVideo extends HTMLVideoElement {
  readonly mozHasAudio?: boolean;
  readonly webkitAudioDecodedByteCount?: number;
  readonly audioTracks?: { length: number };
}

/**
 * Opens one source and hands back an element already at its first frame.
 *
 * `crossOrigin` is set before `src`, which is the only moment it can be set: a cross-origin video
 * loaded without it taints every canvas it is drawn on, and a tainted canvas cannot be read back -
 * so the render would fail at its first frame with a SecurityError rather than here, with a
 * sentence naming the file. A server that answers no CORS header refuses the request outright
 * instead, which is the same failure one step earlier and far easier to act on.
 */
export async function openVideo(uri: string): Promise<HTMLVideoElement> {
  const url = await loadableUrl(uri);
  const video = document.createElement('video');
  if (/^https?:/i.test(url)) video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  // Never attached to the document: a render draws the element, it does not show it, and an element
  // in the tree would be laid out and composited for nothing.
  video.src = url;
  video.load();

  if (!(await waitFor(video, 'loadeddata', METADATA_TIMEOUT_MS))) {
    throw new Error(`the browser could not open ${uri}`);
  }
  return video;
}

/** Gives back the decoder a source was holding. Every caller has to, and on every path. */
export function closeVideo(video: HTMLVideoElement): void {
  try {
    video.pause();
  } catch {
    /* Already stopped, or never started. */
  }
  video.removeAttribute('src');
  video.load();
}

/**
 * What a file is, for `probe()` and for the plan.
 *
 * `hasAudio` defaults to TRUE where the browser will not say. That direction is deliberate: a false
 * positive costs one silent decode in the mixer, which notices and moves on, while a false negative
 * silently drops the customer's sound from their post.
 */
export async function probeMedia(uri: string): Promise<ProbedInput & { rotation: number }> {
  const video = await openVideo(uri);
  try {
    const durationMs = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : 0;
    return {
      durationMs,
      // Already the DISPLAY size: a browser applies the container's rotation before it reports
      // `videoWidth`, which is the same thing both native engines promise.
      width: video.videoWidth,
      height: video.videoHeight,
      hasAudio: hasAudioTrack(video),
      hasVideo: video.videoWidth > 0 && video.videoHeight > 0,
      // A `<video>` exposes no rotation flag, and it has already applied it, so there is nothing
      // honest to report but zero. The field is for the log on the platforms that have one.
      rotation: 0,
    };
  } finally {
    closeVideo(video);
  }
}

/**
 * Whether the file carries sound, as far as this browser is willing to say.
 *
 * Three browsers expose three different things and none of them is standard, so all three are asked
 * before falling back. `webkitAudioDecodedByteCount` is only non-zero once something has been
 * decoded, so a zero from it means "nothing yet" rather than "no audio" - which is why it is read
 * only as a positive signal.
 */
export function hasAudioTrack(video: HTMLVideoElement): boolean {
  const probe = video as AudioAwareVideo;
  if (typeof probe.mozHasAudio === 'boolean') return probe.mozHasAudio;
  if (probe.audioTracks && typeof probe.audioTracks.length === 'number') {
    return probe.audioTracks.length > 0;
  }
  if ((probe.webkitAudioDecodedByteCount ?? 0) > 0) return true;
  return true;
}

/**
 * One source, seeked frame by frame - the renderer's whole relationship with a decoder.
 *
 * The last time it was asked for is remembered, and a request inside half a frame of it draws
 * nothing new. That is not a micro-optimisation: a clip at 0.5x speed asks for the same source
 * frame twice in a row for every output frame, and without this the render would seek, wait and
 * decode twice for one picture. The same holds for a frame held at the join between two clips.
 */
export class FrameReader {
  private lastSeconds = Number.NaN;

  private constructor(readonly video: HTMLVideoElement) {}

  static async open(uri: string): Promise<FrameReader> {
    return new FrameReader(await openVideo(uri));
  }

  get width(): number {
    return this.video.videoWidth;
  }

  get height(): number {
    return this.video.videoHeight;
  }

  /**
   * Puts the element on the frame covering `seconds`. Resolves true when there is a frame to draw -
   * which includes the case where the element was already on it.
   *
   * A seek that never lands resolves FALSE rather than rejecting. The caller then draws the frame
   * already there, which is one repeated frame in the finished video instead of a render that
   * failed twenty seconds in over one awkward keyframe.
   */
  async seek(seconds: number, frameIntervalSeconds: number): Promise<boolean> {
    const duration = this.video.duration;
    const target = Math.max(0, Number.isFinite(duration) && duration > 0 ? Math.min(seconds, duration - 0.001) : seconds);
    if (Number.isFinite(this.lastSeconds) && Math.abs(target - this.lastSeconds) < frameIntervalSeconds / 2) {
      return true;
    }

    const landed = await new Promise<boolean>(resolve => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.video.removeEventListener('seeked', onSeeked);
        this.video.removeEventListener('error', onError);
        resolve(ok);
      };
      const onSeeked = (): void => done(true);
      const onError = (): void => done(false);
      const timer = setTimeout(() => done(false), SEEK_TIMEOUT_MS);
      this.video.addEventListener('seeked', onSeeked);
      this.video.addEventListener('error', onError);
      this.video.currentTime = target;
    });

    if (landed) {
      this.lastSeconds = this.video.currentTime;
      // `seeked` says the element's time has moved; it does not say a frame has been PAINTED, and
      // drawing between the two copies the previous picture. Where the browser offers the callback
      // that does say so, one turn of it is the difference between a correct frame and a stale one.
      await nextPaintedFrame(this.video);
    }
    return landed;
  }

  close(): void {
    closeVideo(this.video);
  }
}

/**
 * Resolves once the element has a new frame on screen, or immediately in a browser without
 * `requestVideoFrameCallback`.
 *
 * The timeout matters: a paused element that has already painted the frame it was seeked to may
 * never call back again, and waiting for a callback that is not coming would stall the render at
 * the first frame of every clip.
 */
function nextPaintedFrame(video: HTMLVideoElement): Promise<void> {
  if (typeof video.requestVideoFrameCallback !== 'function') return Promise.resolve();
  return new Promise<void>(resolve => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 100);
    video.requestVideoFrameCallback(() => done());
  });
}

/** Whether `event` arrived before `timeoutMs`, with `error` counting as a no. */
export function waitFor(element: HTMLMediaElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeEventListener(event, onEvent);
      element.removeEventListener('error', onError);
      resolve(ok);
    };
    const onEvent = (): void => done(true);
    const onError = (): void => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    element.addEventListener(event, onEvent);
    element.addEventListener('error', onError);
  });
}

/** A PNG data URL as something drawable, which is what an overlay is on the way to the frame. */
export async function decodeImage(dataUrl: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function' && typeof fetch === 'function') {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      return await createImageBitmap(blob);
    } catch {
      // Safari has refused `createImageBitmap` on some data URLs; the element path below always
      // works and costs one decode either way.
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('an overlay bitmap could not be decoded'));
    image.src = dataUrl;
  });
}
