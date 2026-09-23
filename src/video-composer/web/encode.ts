import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, WebMOutputFormat, type AudioCodec, type VideoCodec } from 'mediabunny';

import type { ComposeOutput } from '../definitions';

import type { MixedAudio } from './audio';
import type { WebRenderSupport } from './capabilities';

/**
 * Turning finished frames into a file, by whichever of the two routes this browser has.
 *
 * The muxing is Mediabunny's. It was written by hand here first - about seven hundred lines of
 * ISO/IEC 14496-12 boxes - and that was the wrong call: a container is a large, fiddly, well
 * specified thing that someone else already maintains, tests against real players and keeps current
 * as codecs move. Mediabunny is zero-dependency and does the one job, so what is left in this file
 * is the part that is actually ours: which engine to use, how audio is fed in, and the pacing the
 * fallback needs.
 *
 * Both sinks are driven the same way - the render loop draws a frame and says when it belongs - so
 * `render.ts` has no idea which one it has.
 */

/** What the render loop pushes frames into. */
export interface FrameSink {
  /**
   * The canvas AS IT IS NOW, at `timestampUs` on the output timeline. The caller has already drawn
   * it; both sinks read the canvas they were opened with.
   */
  addFrame(timestampUs: number, durationUs: number): Promise<void>;
  /**
   * How big the file has grown so far, in bytes, for the render to hold to `output.maxBytes` while
   * it is still being made. A running count rather than a measurement: neither sink has a file to
   * measure until it is finished, since the MP4 is held in memory until its index can go at the
   * front and the recorder's chunks are only joined at the end. It lags the frames by what the
   * encoder has not handed back yet, and leaves out the container's own boxes, which the finished
   * file's size then includes.
   */
  readonly bytes: number;
  /** The finished file. Called once. */
  finish(): Promise<SinkResult>;
  /** Releases the encoder, on every path including a failed one. */
  close(): Promise<void>;
}

export interface SinkResult {
  blob: Blob;
  hasAudio: boolean;
  mimeType: string;
}

export interface SinkOptions {
  output: ComposeOutput;
  support: WebRenderSupport;
  canvas: HTMLCanvasElement;
  /** Everything audible, already mixed to the plan's exact length, or null for a silent post. */
  mix: MixedAudio | null;
  signal: AbortSignal;
}

/** Opens whichever sink this browser earned in `capabilities.ts`. */
export async function openSink(options: SinkOptions): Promise<FrameSink> {
  if (options.support.engine === 'recorder') return await RecorderSink.open(options);
  return await MediabunnySink.open(options);
}

/** A second of audio per push, so the encoder is fed steadily rather than in one lump. */
const AUDIO_CHUNK_SECONDS = 1;

/* -------------------------------------------------------------------------------------------- */
/* WebCodecs, through Mediabunny                                                                  */
/* -------------------------------------------------------------------------------------------- */

class MediabunnySink implements FrameSink {
  private constructor(
    private readonly output: Output,
    private readonly video: CanvasSource,
    private readonly audio: AudioBufferSource | null,
    private readonly mix: MixedAudio | null,
    private readonly mimeType: string,
    private readonly produced: { bytes: number },
    private finished = false,
  ) {}

  get bytes(): number {
    return this.produced.bytes;
  }

  static async open({ output, support, canvas, mix }: SinkOptions): Promise<MediabunnySink> {
    const mp4 = support.container === 'mp4';
    // Every packet either encoder hands the muxer, which is what the file's media data is made of.
    // Counted here because the muxer itself writes nothing out until `finalize`: fast start keeps
    // the whole file in memory so the index can go in front of it.
    const produced = { bytes: 0 };
    const count = (packet: { byteLength: number }): void => {
      produced.bytes += packet.byteLength;
    };
    const file = new Output({
      // `in-memory` fast start puts the index at the FRONT of the file, so the finished video starts
      // playing before it has finished downloading. The target is memory anyway, so it costs nothing
      // but the arithmetic.
      format: mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target: new BufferTarget(),
    });

    const video = new CanvasSource(canvas, {
      codec: support.videoCodec as VideoCodec,
      // The OBJECT form, and it matters: a bare number is a qualitative 0-to-1 level, so passing the
      // bitrate straight in reads as a quality of six million and resolves to a quantizer of zero,
      // which the encoder then refuses outright. The flow computes this bitrate (D2) and it is a
      // bitrate.
      quality: new Quality({ bitrate: output.videoBitrate }),
      // Two seconds, which is what makes the finished video seekable without bloating it.
      keyFrameInterval: 2,
      onEncodedPacket: count,
    });
    file.addVideoTrack(video);

    let audio: AudioBufferSource | null = null;
    if (mix && support.audioCodec) {
      audio = new AudioBufferSource({
        codec: support.audioCodec as AudioCodec,
        quality: new Quality({ bitrate: output.audioBitrate }),
        onEncodedPacket: count,
      });
      file.addAudioTrack(audio);
    }

    await file.start();
    return new MediabunnySink(file, video, audio, mix, mp4 ? 'video/mp4' : 'video/webm', produced);
  }

  async addFrame(timestampUs: number, durationUs: number): Promise<void> {
    // Awaited, and that is the whole of the backpressure story: the promise resolves when the
    // encoder is ready for more, so a desktop that draws faster than it encodes cannot queue the
    // entire video into memory.
    await this.video.add(timestampUs / 1_000_000, durationUs / 1_000_000);
  }

  async finish(): Promise<SinkResult> {
    const hasAudio = await this.addAudio();
    await this.output.finalize();
    this.finished = true;
    const buffer = (this.output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('the muxer produced no file');
    return { blob: new Blob([buffer], { type: this.mimeType }), hasAudio, mimeType: this.mimeType };
  }

  async close(): Promise<void> {
    if (this.finished) return;
    try {
      await this.output.cancel();
    } catch {
      /* Already finalized, or never started. */
    }
  }

  /**
   * Feeds the mix in, a second at a time.
   *
   * A failure here does NOT fail the render. The picture is the post; losing the sound to a browser
   * whose AAC encoder refused a perfectly ordinary configuration is bad, and losing the whole video
   * to it is worse, so the failure is swallowed and the video is muxed silently. `hasAudio` on the
   * result says which happened.
   */
  private async addAudio(): Promise<boolean> {
    const mix = this.mix;
    const audio = this.audio;
    if (!mix || !audio) return false;
    try {
      const chunk = Math.round(AUDIO_CHUNK_SECONDS * mix.sampleRate);
      for (let at = 0; at < mix.length; at += chunk) {
        const frames = Math.min(chunk, mix.length - at);
        const buffer = new AudioBuffer({
          length: frames,
          numberOfChannels: mix.channels.length,
          sampleRate: mix.sampleRate,
        });
        for (let channel = 0; channel < mix.channels.length; channel++) {
          // `slice`, not `subarray`: `copyToChannel` reads the whole view it is given, and a view
          // over the mix would hand it the rest of the track as well.
          buffer.copyToChannel((mix.channels[channel] ?? EMPTY).slice(at, at + frames), channel);
        }
        await audio.add(buffer);
      }
      return true;
    } catch {
      return false;
    }
  }
}

const EMPTY = new Float32Array(0);

/* -------------------------------------------------------------------------------------------- */
/* MediaRecorder, for a browser with no WebCodecs                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * The fallback, and it is honest about what it costs.
 *
 * `MediaRecorder` timestamps what it records by the WALL CLOCK, so a video can only be recorded at
 * the speed it plays: a thirty-second post takes thirty seconds. There is no way around that - it is
 * what the API is - and it is the reason this is the second choice rather than the first.
 *
 * Frames are pushed rather than sampled where the browser allows it. `captureStream(0)` hands back a
 * track that captures only when asked, so the render draws a frame, waits until that frame's moment
 * has actually arrived, and then asks. A browser without `requestFrame` gets `captureStream(fps)`
 * and samples the canvas on its own; the pacing is the same either way, because the pacing is what
 * makes the timing right.
 */
class RecorderSink implements FrameSink {
  private chunks: Blob[] = [];
  private startedAt = 0;
  /** What the recorder has handed over so far: a chunk a second, from the timeslice below. */
  bytes = 0;

  private constructor(
    private readonly recorder: MediaRecorder,
    private readonly track: CanvasCaptureMediaStreamTrack | null,
    private readonly audio: { context: AudioContext; source: AudioBufferSourceNode } | null,
    private readonly signal: AbortSignal,
    private readonly hasAudio: boolean,
  ) {}

  static async open({ output, support, canvas, mix, signal }: SinkOptions): Promise<RecorderSink> {
    const capture = canvas as HTMLCanvasElement & {
      captureStream(frameRate?: number): MediaStream;
    };
    if (typeof capture.captureStream !== 'function') {
      throw new Error('this browser cannot capture a canvas');
    }

    const manual = supportsRequestFrame(capture);
    const stream = capture.captureStream(manual ? 0 : output.fps);
    const track = manual ? ((stream.getVideoTracks()[0] ?? null) as CanvasCaptureMediaStreamTrack | null) : null;

    const audio = mix ? attachAudio(stream, mix) : null;

    const recorder = new MediaRecorder(stream, {
      mimeType: support.recorderMimeType,
      videoBitsPerSecond: output.videoBitrate,
      audioBitsPerSecond: output.audioBitrate,
    });
    const sink = new RecorderSink(recorder, track, audio, signal, audio !== null);
    recorder.addEventListener('dataavailable', event => {
      if (event.data.size === 0) return;
      sink.chunks.push(event.data);
      sink.bytes += event.data.size;
    });

    // A timeslice, so a render that goes wrong still has most of itself rather than nothing, and so
    // `bytes` grows as the recording does rather than all at once at the end.
    recorder.start(1000);
    if (audio) {
      await audio.context.resume().catch(() => undefined);
      audio.source.start();
    }
    sink.startedAt = performance.now();
    return sink;
  }

  async addFrame(timestampUs: number): Promise<void> {
    // The whole of the fallback's timing: hold the drawn frame on screen until its own moment
    // arrives, then let the recorder have it.
    const dueAt = this.startedAt + timestampUs / 1000;
    const wait = dueAt - performance.now();
    if (wait > 0) await sleep(wait, this.signal);
    this.track?.requestFrame();
  }

  async finish(): Promise<SinkResult> {
    // One frame interval of grace, so the last frame is inside the recording rather than on its edge.
    await sleep(80, this.signal);
    await new Promise<void>(resolve => {
      if (this.recorder.state === 'inactive') {
        resolve();
        return;
      }
      this.recorder.addEventListener('stop', () => resolve(), { once: true });
      try {
        this.recorder.stop();
      } catch {
        resolve();
      }
    });
    this.stopAudio();

    const mimeType = this.recorder.mimeType || 'video/webm';
    const blob = new Blob(this.chunks, { type: mimeType });
    if (blob.size === 0) throw new Error('the recorder captured nothing');
    return { blob, hasAudio: this.hasAudio, mimeType };
  }

  async close(): Promise<void> {
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      /* Already stopped. */
    }
    this.stopAudio();
  }

  private stopAudio(): void {
    if (!this.audio) return;
    try {
      this.audio.source.stop();
    } catch {
      /* Already stopped, or never started. */
    }
    void this.audio.context.close().catch(() => undefined);
  }
}

/**
 * Puts the mix on the recorder's stream.
 *
 * A real `AudioContext` rather than an offline one, because the recorder records in real time and
 * needs a live graph to record from. It may start suspended - every browser requires a gesture for
 * audio - which is why `resume()` is awaited before the source is started; a render always follows
 * a tap, so the gesture is there.
 */
function attachAudio(stream: MediaStream, mix: MixedAudio): { context: AudioContext; source: AudioBufferSourceNode } | null {
  try {
    const context = new AudioContext({ sampleRate: mix.sampleRate });
    const buffer = context.createBuffer(mix.channels.length, mix.length, mix.sampleRate);
    for (let channel = 0; channel < mix.channels.length; channel++) {
      buffer.copyToChannel(mix.channels[channel] ?? EMPTY, channel);
    }
    const destination = context.createMediaStreamDestination();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    return { context, source };
  } catch {
    // A silent video beats no video, and this is the fallback engine already.
    return null;
  }
}

function supportsRequestFrame(canvas: HTMLCanvasElement & { captureStream?: unknown }): boolean {
  const ctor = (globalThis as { CanvasCaptureMediaStreamTrack?: { prototype: object } }).CanvasCaptureMediaStreamTrack;
  return typeof ctor?.prototype === 'object' && 'requestFrame' in ctor.prototype;
}

/** Waits, unless the render is cancelled first - in which case the loop's own check picks it up. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
