import { getFirstEncodableAudioCodec, getFirstEncodableVideoCodec, Quality } from 'mediabunny';

import type { CapabilitiesResult } from '../definitions';

/**
 * What this browser can actually do, asked rather than assumed.
 *
 * `capabilities()` is the one call in the composer's contract that answers instead of throwing, and
 * on the web it is the call that earns its keep: a host uses it to decide whether to offer editing
 * at all, and the honest answer differs between a Chrome on Android from this year and a WebView on
 * a tablet from four years ago. Everything here is a real probe - Mediabunny's codec checks
 * negotiate with the platform's own encoder rather than reading a user agent string.
 *
 * There are TWO engines, and which one a page gets is decided here:
 *
 * - `webcodecs` is the real one. Mediabunny drives `VideoEncoder` and writes the container, so the
 *   output is an MP4 with H.264 and AAC - the same kind of file both native engines produce.
 * - `recorder` is the fallback for a browser with no WebCodecs at all. `MediaRecorder` over a canvas
 *   stream still produces a video, at the cost of running in real time and of landing in whatever
 *   container that browser records in, usually WebM. It is a worse answer than the first one and a
 *   much better answer than "not here".
 *
 * Only a browser with neither gets `supported: false`, and then `compose()` fails with `unsupported`
 * rather than pretending.
 *
 * The answers are cached because they cannot change while the page is open and because the probe
 * itself allocates an encoder on some platforms.
 */

export type RenderEngine = 'webcodecs' | 'recorder' | 'none';

/** What the render actually runs on once a browser has been asked. */
export interface WebRenderSupport {
  supported: boolean;
  engine: RenderEngine;
  /** Why not, in a sentence a developer can act on. Empty when `supported`. */
  reason: string;
  /** Mediabunny's codec name - `avc`, `vp9`, `vp8`, `av1` - or the recorder's, from its mime type. */
  videoCodec: string;
  /** `aac` or `opus`, or empty when the output has to be silent. */
  audioCodec: string;
  /** `mp4` or `webm`: what the finished file will be. */
  container: 'mp4' | 'webm';
  /** The exact type `MediaRecorder` was asked for. Empty on the WebCodecs engine. */
  recorderMimeType: string;
}

/**
 * The codecs to offer, best first.
 *
 * AVC first, always: it is what both native engines produce, what every phone decodes in hardware
 * and what the upload endpoint has been fed since before this package existed. The rest are there so
 * a browser that can encode something - Firefox before it shipped an H.264 encoder, say - still gets
 * a video rather than a refusal, and the container follows the codec because VP9 in MP4 is a
 * combination too much of the world still refuses to play.
 */
const VIDEO_CODECS = ['avc', 'vp9', 'vp8', 'av1'] as const;
const AUDIO_CODECS = ['aac', 'opus'] as const;

/**
 * Containers to ask `MediaRecorder` for, best first. MP4 leads for the same reason AVC does; a
 * browser with `MediaRecorder` and no WebCodecs answers to one of the WebM entries in practice.
 */
const RECORDER_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

let cached: Promise<WebRenderSupport> | null = null;

/** The negotiated render support, probed once per page. */
export function renderSupport(width = 720, height = 1280, fps = 30): Promise<WebRenderSupport> {
  if (cached) return cached;
  cached = probe(width, height, fps);
  return cached;
}

/** For the tests, and for a host that changed the output size between two renders. */
export function resetRenderSupport(): void {
  cached = null;
}

/** The composer's own `capabilities()` answer, built from the same probe. */
export async function webCapabilities(): Promise<CapabilitiesResult> {
  const support = await renderSupport();
  const result: CapabilitiesResult = {
    supported: support.supported,
    voiceRecording: canRecordVoice(),
  };
  if (!support.supported) {
    result.reason = support.reason;
    return result;
  }
  result.videoCodec = support.videoCodec;
  result.audioCodec = support.audioCodec || 'none';
  result.container = support.container;
  // A host that only renders does not need to know which engine ran, but one deciding whether to let
  // someone edit a two-minute post very much does: the recorder takes the video's own length in
  // wall-clock time, and nothing can make it faster.
  if (support.engine === 'recorder') {
    result.reason = 'Rendering through MediaRecorder, which runs in real time.';
  }
  return result;
}

/**
 * Whether this browser can encode a frame of exactly this size and rate.
 *
 * A probe per size, cached per size, because that is the question: `renderSupport` negotiates the
 * codec at the DEFAULT frame and its answer says nothing about 4K, where the same browser may have
 * no encoder at all. Mediabunny asks the platform rather than reading a user agent, so this is the
 * real answer for this device.
 *
 * The recorder engine is the fallback and has no size negotiation of its own: `MediaRecorder` takes
 * whatever the canvas is, and a canvas that big is the limit rather than the encoder. It is capped
 * at 1080p here for a reason a customer would agree with - the recorder runs in REAL TIME, and
 * four times the pixels on a browser already reduced to this is a wait nobody wants - and the
 * reason is said rather than left as a grey chip.
 */
export async function encodableAt(width: number, height: number, fps: number): Promise<{ supported: boolean; reason?: string }> {
  const key = `${width}x${height}@${fps}`;
  const known = perSize.get(key);
  if (known) return known;
  const answer = probeSize(width, height, fps);
  perSize.set(key, answer);
  return answer;
}

const perSize = new Map<string, Promise<{ supported: boolean; reason?: string }>>();

async function probeSize(width: number, height: number, fps: number): Promise<{ supported: boolean; reason?: string }> {
  const support = await renderSupport();
  if (!support.supported) return { supported: false, reason: support.reason };

  if (support.engine === 'recorder') {
    if (Math.min(width, height) > 1080) {
      return { supported: false, reason: 'This browser records in real time and cannot manage more than 1080P.' };
    }
    return { supported: true };
  }

  const at = await probeWebCodecs(width, height, fps);
  if (at) return { supported: true };
  return { supported: false, reason: `This browser has no encoder for ${Math.min(width, height)}P.` };
}

/**
 * Whether a voiceover can be taken here. Both halves are needed and neither implies the other: a
 * page served over plain http has `MediaRecorder` and no `getUserMedia`, and a browser can expose
 * the microphone and still refuse to encode what comes out of it.
 */
export function canRecordVoice(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/** The first type this browser's `MediaRecorder` will record, or empty for one that has none. */
export function recorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return RECORDER_TYPES.find(type => MediaRecorder.isTypeSupported(type)) ?? '';
}

/* -------------------------------------------------------------------------------------------- */

async function probe(width: number, height: number, fps: number): Promise<WebRenderSupport> {
  if (typeof document === 'undefined') {
    return none('This page has no canvas to draw frames on.');
  }

  const webcodecs = await probeWebCodecs(width, height, fps);
  if (webcodecs) return webcodecs;

  const mimeType = recorderMimeType();
  if (mimeType) {
    return {
      supported: true,
      engine: 'recorder',
      reason: '',
      videoCodec: codecsOf(mimeType) || 'unknown',
      audioCodec: mimeType.includes('mp4a') ? 'aac' : 'opus',
      container: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm',
      recorderMimeType: mimeType,
    };
  }

  return none('This browser has neither a WebCodecs encoder nor a usable MediaRecorder.');
}

async function probeWebCodecs(width: number, height: number, fps: number): Promise<WebRenderSupport | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  // The frame rate is not part of what makes a codec usable - the encoder is configured with it
  // later, and no browser refuses a codec over it - so it is taken and not passed on.
  void fps;
  try {
    const video = await getFirstEncodableVideoCodec([...VIDEO_CODECS], {
      width,
      height,
      // The probe is about whether the codec works at all, not about the bitrate the flow computed;
      // a quality level keeps this from failing over a number the caller has not chosen yet.
      quality: new Quality('high'),
    });
    if (!video) return null;
    const audio = await getFirstEncodableAudioCodec([...AUDIO_CODECS], {
      numberOfChannels: 2,
      sampleRate: 48_000,
    });
    return {
      supported: true,
      engine: 'webcodecs',
      reason: '',
      videoCodec: video,
      audioCodec: audio ?? '',
      // AVC belongs in MP4 and the others belong in WebM. VP9 in an MP4 is legal and is still the
      // wrong file to hand an upload endpoint that has only ever seen H.264.
      container: video === 'avc' ? 'mp4' : 'webm',
      recorderMimeType: '',
    };
  } catch {
    // A browser that throws out of the probe rather than answering has said the same thing an answer
    // of `null` would have, and the recorder fallback is what happens next either way.
    return null;
  }
}

function none(reason: string): WebRenderSupport {
  return {
    supported: false,
    engine: 'none',
    reason,
    videoCodec: '',
    audioCodec: '',
    container: 'mp4',
    recorderMimeType: '',
  };
}

/** `avc1.42E01E,mp4a.40.2` out of `video/mp4;codecs=avc1.42E01E,mp4a.40.2`. */
function codecsOf(mimeType: string): string {
  const match = /codecs=([^;]+)/.exec(mimeType);
  return match?.[1]?.replace(/"/g, '') ?? '';
}
