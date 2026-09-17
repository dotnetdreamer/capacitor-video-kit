import type { ComposeOutput } from '../definitions';

import type { MixedAudio } from './audio';
import type { WebRenderSupport } from './capabilities';
import { Mp4Writer } from './mp4';

/**
 * WebCodecs on one side, the MP4 writer on the other.
 *
 * The encoder is asynchronous and unbounded: `encode()` returns immediately and the encoded chunk
 * turns up in a callback whenever the platform gets round to it. Left alone, a render that can draw
 * frames faster than the encoder takes them - which is every render on a desktop - queues the whole
 * video in the encoder's input and runs the tab out of memory around the thirty-second mark. So
 * every frame goes through `awaitRoom`, which is the whole of the backpressure story.
 *
 * Audio is encoded in one pass at the end rather than interleaved with the picture. The mix is
 * already a flat array of samples by then, the AAC encoder is hundreds of times faster than real
 * time, and doing it separately keeps the frame loop - the part that takes minutes - free of a
 * second queue to watch.
 */

/** Frames the encoder may hold before the renderer waits. A handful is enough to keep it busy. */
const MAX_QUEUED_FRAMES = 6;

/** One AAC access unit. The encoder wants 1024 samples per channel and will buffer to get them. */
const AUDIO_CHUNK_FRAMES = 1024;

/** A keyframe every two seconds: what makes the finished video seekable without bloating it. */
const KEYFRAME_SECONDS = 2;

const EMPTY = new Float32Array(0);

export class Encoder {
  private readonly writer = new Mp4Writer();
  private readonly encoder: VideoEncoder;
  private videoTrack = -1;
  private frames = 0;
  private failure: Error | null = null;

  private constructor(
    private readonly output: ComposeOutput,
    private readonly support: WebRenderSupport,
  ) {
    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => this.onVideoChunk(chunk, metadata),
      error: error => {
        // Remembered rather than thrown: this callback is not on any caller's stack, and a throw
        // here would be an unhandled rejection with no job attached to it. The next frame, or
        // `finish`, reports it where someone is listening.
        this.failure ??= error instanceof Error ? error : new Error(String(error));
      },
    });
  }

  static async start(output: ComposeOutput, support: WebRenderSupport): Promise<Encoder> {
    const encoder = new Encoder(output, support);
    encoder.encoder.configure({
      codec: support.videoCodec,
      width: output.width,
      height: output.height,
      bitrate: output.videoBitrate,
      framerate: output.fps,
      avc: { format: 'avc' },
      // Quality over latency: nothing is watching this stream, and the realtime mode trades picture
      // for a deadline that does not exist here.
      latencyMode: 'quality',
      ...(support.preferHardware ? { hardwareAcceleration: 'prefer-hardware' as HardwareAcceleration } : {}),
    });
    return encoder;
  }

  /**
   * One finished frame. `timestampUs` is its place on the OUTPUT timeline.
   *
   * The `VideoFrame` is closed on every path including the throwing one: it holds a GPU buffer, and
   * a handful of unclosed ones is enough for the platform to stop handing out new ones - which
   * shows up as a render that stalls rather than one that fails.
   */
  async addFrame(canvas: CanvasImageSource, timestampUs: number, durationUs: number): Promise<void> {
    this.throwIfFailed();
    await this.awaitRoom();

    const keyFrame = this.frames % Math.max(1, Math.round(this.output.fps * KEYFRAME_SECONDS)) === 0;
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(timestampUs),
      duration: Math.round(durationUs),
    });
    try {
      this.encoder.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }
    this.frames++;
  }

  /**
   * Encodes the mix, flushes the encoder and writes the file.
   *
   * A mix that will not encode does NOT fail the render. The picture is the post; losing the sound
   * to a browser whose AAC encoder refused a perfectly ordinary configuration is bad, and losing
   * the whole video to it is worse, so that failure is swallowed here and the video is muxed
   * silently. The `hasAudio` on the result says which happened.
   */
  async finish(mix: MixedAudio | null): Promise<{ blob: Blob; hasAudio: boolean }> {
    this.throwIfFailed();
    await this.encoder.flush();
    this.throwIfFailed();

    let hasAudio = false;
    if (mix && this.support.audioCodec) {
      try {
        await this.encodeAudio(mix);
        hasAudio = true;
      } catch {
        hasAudio = false;
      }
    }

    if (this.videoTrack < 0 || this.writer.sampleCount(this.videoTrack) === 0) {
      throw new Error('the encoder produced no frames');
    }
    return { blob: this.writer.finalize(), hasAudio };
  }

  close(): void {
    try {
      if (this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      /* Already closed, or never configured. */
    }
  }

  /* ------------------------------------------------------------------------------------------ */

  private onVideoChunk(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void {
    if (this.videoTrack < 0) {
      const description = metadata?.decoderConfig?.description;
      if (!description) {
        // Without `avcC` there is no sample description, and a track without one is a file no
        // player will open. It cannot be synthesised the way an AAC config can - it carries the
        // encoder's own SPS and PPS.
        this.failure ??= new Error('the encoder did not describe its own output');
        return;
      }
      this.videoTrack = this.writer.addVideoTrack({
        width: this.output.width,
        height: this.output.height,
        description: bytesOf(description),
        bitrate: this.output.videoBitrate,
      });
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.writer.addSample(this.videoTrack, {
      data,
      timestampUs: chunk.timestamp,
      durationUs: chunk.duration ?? Math.round(1_000_000 / this.output.fps),
      isSync: chunk.type === 'key',
    });
  }

  private async encodeAudio(mix: MixedAudio): Promise<void> {
    let failure: Error | null = null;
    const pending: { chunk: EncodedAudioChunk; description: Uint8Array<ArrayBuffer> | null }[] = [];

    const encoder = new AudioEncoder({
      output: (chunk, metadata) => {
        const description = metadata?.decoderConfig?.description;
        pending.push({ chunk, description: description ? bytesOf(description) : null });
      },
      error: error => {
        failure ??= error instanceof Error ? error : new Error(String(error));
      },
    });

    const channels = mix.channels.length;
    encoder.configure({
      codec: this.support.audioCodec,
      sampleRate: mix.sampleRate,
      numberOfChannels: channels,
      bitrate: this.output.audioBitrate,
    });

    // `f32-planar` is the one format every implementation accepts, and it is what the mix already
    // is - channel after channel, with no weaving to undo.
    for (let at = 0; at < mix.length; at += AUDIO_CHUNK_FRAMES) {
      if (failure) throw failure;
      const count = Math.min(AUDIO_CHUNK_FRAMES, mix.length - at);
      const planar = new Float32Array(count * channels);
      for (let channel = 0; channel < channels; channel++) {
        planar.set((mix.channels[channel] ?? EMPTY).subarray(at, at + count), channel * count);
      }
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: mix.sampleRate,
        numberOfFrames: count,
        numberOfChannels: channels,
        timestamp: Math.round((at / mix.sampleRate) * 1_000_000),
        data: planar,
      });
      try {
        encoder.encode(data);
      } finally {
        data.close();
      }
      if (encoder.encodeQueueSize > 32) await tick();
    }

    await encoder.flush();
    encoder.close();
    if (failure) throw failure;
    if (pending.length === 0) throw new Error('the AAC encoder produced nothing');

    // The description arrives with the first chunk on every browser that sends one at all; the
    // fallback is what keeps a browser that sends none from costing the post its sound.
    const described = pending.find(entry => entry.description)?.description;
    const track = this.writer.addAudioTrack({
      sampleRate: mix.sampleRate,
      channels,
      description: described ?? audioSpecificConfig(mix.sampleRate, channels),
      bitrate: this.output.audioBitrate,
    });

    for (const entry of pending) {
      const data = new Uint8Array(entry.chunk.byteLength);
      entry.chunk.copyTo(data);
      this.writer.addSample(track, {
        data,
        timestampUs: entry.chunk.timestamp,
        durationUs: entry.chunk.duration ?? Math.round((AUDIO_CHUNK_FRAMES / mix.sampleRate) * 1_000_000),
        isSync: true,
      });
    }
  }

  /** Waits until the encoder has room, so the renderer cannot outrun it into the heap. */
  private async awaitRoom(): Promise<void> {
    while (this.encoder.encodeQueueSize > MAX_QUEUED_FRAMES && !this.failure) {
      await new Promise<void>(resolve => {
        const done = (): void => {
          this.encoder.removeEventListener('dequeue', done);
          clearTimeout(timer);
          resolve();
        };
        // The event is the fast path; the timeout is the one that matters, because a browser that
        // does not fire `dequeue` would otherwise stall the render for good.
        const timer = setTimeout(done, 20);
        this.encoder.addEventListener('dequeue', done);
      });
    }
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }
}

/**
 * The two-byte AudioSpecificConfig for AAC-LC, for a browser whose encoder does not hand one over.
 *
 * Five bits of object type (2, AAC-LC), four of sampling frequency index, four of channel
 * configuration and three of a GASpecificConfig that is all zeroes for this profile. At 48 kHz
 * stereo it comes out as the familiar `11 90`.
 */
export function audioSpecificConfig(sampleRate: number, channels: number): Uint8Array<ArrayBuffer> {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const index = Math.max(0, rates.indexOf(sampleRate));
  const objectType = 2;
  const first = (objectType << 3) | (index >> 1);
  const second = ((index & 1) << 7) | ((channels & 0x0f) << 3);
  return new Uint8Array([first & 0xff, second & 0xff]);
}

/** A copy backed by a plain `ArrayBuffer`, which is the only kind a `Blob` will take. */
function bytesOf(source: AllowSharedBufferSource): Uint8Array<ArrayBuffer> {
  if (ArrayBuffer.isView(source)) {
    const view = source as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
  }
  return new Uint8Array((source as ArrayBuffer).slice(0));
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
