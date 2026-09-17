import type { CapabilitiesResult } from '../definitions';

/**
 * What this browser can actually do, asked rather than assumed.
 *
 * `capabilities()` is the one call in the composer's contract that answers instead of throwing, and
 * on the web it is the call that earns its keep: a host uses it to decide whether to offer editing
 * at all, and the honest answer differs between a Chrome on Android from this year and a WebView on
 * a tablet from four years ago. Everything here is a real probe - `VideoEncoder.isConfigSupported`
 * negotiates with the platform's encoder rather than reading a user agent string.
 *
 * The answers are cached because they cannot change while the page is open and because the probe
 * itself allocates an encoder on some platforms.
 */

/** What the render actually runs on once a browser has been asked. */
export interface WebRenderSupport {
  supported: boolean;
  /** Why not, in a sentence a developer can act on. Empty when `supported`. */
  reason: string;
  /** The AVC codec string the encoder agreed to, e.g. `avc1.42002a`. */
  videoCodec: string;
  /** `mp4a.40.2` when AAC encoding is available, empty when the output has to be silent. */
  audioCodec: string;
  /** Whether the encoder wants hardware. Left off the config entirely when false. */
  preferHardware: boolean;
}

/**
 * The AVC profiles to offer, best first.
 *
 * High profile first because it is what every phone decoder made this decade prefers and what gives
 * the most picture for a bitrate; baseline last because it is the one thing that is certain to be
 * there. Level 4.0 and above throughout: 720x1280 is 3600 macroblocks, which is exactly level 3.1's
 * ceiling, and asking for the level right on the boundary is how an encoder comes to refuse a
 * config that would have worked one step up.
 */
const AVC_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42002a', 'avc1.42001f'];

const AAC_CODEC = 'mp4a.40.2';

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
  result.container = 'mp4';
  return result;
}

/**
 * Whether a voiceover can be taken here. Both halves are needed and neither implies the other: a
 * page served over plain http has `MediaRecorder` and no `getUserMedia`, and a browser can expose
 * the microphone and still refuse to encode what comes out of it.
 */
export function canRecordVoice(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/* -------------------------------------------------------------------------------------------- */

async function probe(width: number, height: number, fps: number): Promise<WebRenderSupport> {
  const none = (reason: string): WebRenderSupport => ({
    supported: false,
    reason,
    videoCodec: '',
    audioCodec: '',
    preferHardware: false,
  });

  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    // The honest sentence, and the one a host can act on: there is no second renderer hiding behind
    // this, and a browser without WebCodecs cannot encode a video however the page is written.
    return none('This browser has no WebCodecs video encoder.');
  }
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') {
    return none('This page has no canvas to draw frames on.');
  }

  const video = await firstSupportedVideo(width, height, fps);
  if (!video) {
    return none(`No H.264 encoder here would take ${width}x${height} at ${fps} fps.`);
  }

  return {
    supported: true,
    reason: '',
    videoCodec: video.codec,
    audioCodec: await aacCodec(),
    preferHardware: video.preferHardware,
  };
}

/**
 * The first profile the encoder agrees to, hardware asked for first.
 *
 * Hardware first because a phone encoding 1280-tall frames in software takes several times as long
 * and warms up enough to be throttled; no preference second because a desktop browser without a
 * hardware encoder answers `false` to `prefer-hardware` outright rather than falling back on its
 * own.
 */
async function firstSupportedVideo(width: number, height: number, fps: number): Promise<{ codec: string; preferHardware: boolean } | null> {
  for (const preferHardware of [true, false]) {
    for (const codec of AVC_CODECS) {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        framerate: fps,
        // `avc` format, not `annexb`: it is the length-prefixed form an MP4 sample track holds, and
        // it is what makes the encoder hand back the `avcC` box the muxer needs as its description.
        avc: { format: 'avc' },
        ...(preferHardware ? { hardwareAcceleration: 'prefer-hardware' as HardwareAcceleration } : {}),
      };
      try {
        const answer = await VideoEncoder.isConfigSupported(config);
        if (answer.supported) return { codec, preferHardware };
      } catch {
        // A browser that rejects rather than answering `{supported: false}` - which older Safari
        // does for a codec string it cannot parse - is a no for this codec and says nothing about
        // the next one.
      }
    }
  }
  return null;
}

/** `mp4a.40.2` when AAC encoding is available, or an empty string for a browser without it. */
async function aacCodec(): Promise<string> {
  if (typeof AudioEncoder === 'undefined') return '';
  try {
    const answer = await AudioEncoder.isConfigSupported({
      codec: AAC_CODEC,
      sampleRate: 48_000,
      numberOfChannels: 2,
      bitrate: 128_000,
    });
    return answer.supported ? AAC_CODEC : '';
  } catch {
    return '';
  }
}
