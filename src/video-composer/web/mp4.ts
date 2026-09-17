/**
 * An MP4 writer, because the browser has an H.264 encoder and no container to put its output in.
 *
 * WebCodecs hands back `EncodedVideoChunk`s and stops there - it is an encoder, not a muxer - so a
 * page with no dependency and no WebAssembly has to write the ISO base media boxes itself. That is
 * what this is: about as much of ISO/IEC 14496-12 and -14 as one progressive MP4 needs, and not one
 * box more. The output is deliberately the same shape both native engines produce - `avc1` video
 * and `mp4a` AAC-LC in an `isom` container - so a post made in a browser and a post made on a phone
 * are the same kind of file to everything downstream.
 *
 * Two decisions worth knowing about:
 *
 * `moov` goes FIRST. A player handed a `moov` at the end of the file has to read to the end before
 * it can show a frame, which over a network is the whole file. Writing it first costs one extra
 * pass - the table of chunk offsets depends on how long `moov` is, so it is built once with zeroed
 * offsets to learn its length and once more for real - and it is what makes the finished video
 * start playing the moment its first bytes arrive.
 *
 * Nothing is concatenated into one buffer. Every encoded chunk is kept as its own `Uint8Array` and
 * the finished file is a `Blob` over the list, so a sixty-second video never needs a contiguous
 * hundred-megabyte allocation on a phone that does not have one.
 */

/**
 * Bytes backed by a plain `ArrayBuffer` rather than by `ArrayBufferLike`.
 *
 * `Uint8Array` on its own also admits a `SharedArrayBuffer`, which a `Blob` will not take, so every
 * byte helper below is explicit about which it produces. Without it the whole file typechecks right
 * up to the one line that builds the finished file.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** One sample as the tables need it: sizes, times and whether a player may start here. */
interface Sample {
  data: Bytes;
  /** Decode time, in the track's own timescale. */
  dts: number;
  /** Presentation time, in the track's own timescale. Differs from `dts` only with B-frames. */
  cts: number;
  durationTicks: number;
  isSync: boolean;
}

interface Track {
  id: number;
  kind: 'video' | 'audio';
  timescale: number;
  samples: Sample[];
  /** The codec-private bytes: `avcC` for video, the AudioSpecificConfig for AAC. */
  description: Bytes;
  width: number;
  height: number;
  channels: number;
  sampleRate: number;
  bitrate: number;
}

/** The movie header's own clock. Milliseconds, so the duration in it reads as milliseconds. */
const MOVIE_TIMESCALE = 1000;

/** 90 kHz, the timescale every MPEG system has used for video since MPEG-2. */
export const VIDEO_TIMESCALE = 90_000;

export class Mp4Writer {
  private readonly tracks: Track[] = [];
  private nextTrackId = 1;

  /**
   * Declares the video track. `description` is the `avcC` box's contents, which the encoder hands
   * over on its first chunk's metadata when it was configured with `avc: { format: 'avc' }`.
   */
  addVideoTrack(options: { width: number; height: number; description: Bytes; bitrate: number }): number {
    const id = this.nextTrackId++;
    this.tracks.push({
      id,
      kind: 'video',
      timescale: VIDEO_TIMESCALE,
      samples: [],
      description: options.description,
      width: options.width,
      height: options.height,
      channels: 0,
      sampleRate: 0,
      bitrate: options.bitrate,
    });
    return id;
  }

  /** Declares the AAC track. `description` is the AudioSpecificConfig, for the `esds` box. */
  addAudioTrack(options: { sampleRate: number; channels: number; description: Bytes; bitrate: number }): number {
    const id = this.nextTrackId++;
    this.tracks.push({
      id,
      kind: 'audio',
      timescale: options.sampleRate,
      samples: [],
      description: options.description,
      width: 0,
      height: 0,
      channels: options.channels,
      sampleRate: options.sampleRate,
      bitrate: options.bitrate,
    });
    return id;
  }

  /**
   * One encoded sample. Times are MICROSECONDS, which is what WebCodecs deals in; they are
   * converted to the track's timescale here so nothing else in the renderer has to know about
   * timescales at all.
   */
  addSample(trackId: number, sample: { data: Bytes; timestampUs: number; durationUs: number; isSync: boolean }): void {
    const track = this.tracks.find(candidate => candidate.id === trackId);
    if (!track) throw new Error(`no track ${trackId}`);
    const ticks = (us: number): number => Math.round((us * track.timescale) / 1_000_000);
    track.samples.push({
      data: sample.data,
      dts: ticks(sample.timestampUs),
      cts: ticks(sample.timestampUs),
      durationTicks: Math.max(1, ticks(sample.durationUs)),
      isSync: sample.isSync,
    });
  }

  /** How many samples a track has taken, for a caller that has to know whether it encoded anything. */
  sampleCount(trackId: number): number {
    return this.tracks.find(track => track.id === trackId)?.samples.length ?? 0;
  }

  /**
   * The finished file.
   *
   * Every track is normalised first - times moved so the media starts at zero, decode times worked
   * out where the encoder reordered frames - and then the tables are built twice, because the chunk
   * offsets they carry depend on the length of the box that holds them.
   */
  finalize(): Blob {
    const tracks = this.tracks.filter(track => track.samples.length > 0);
    if (tracks.length === 0) throw new Error('nothing was encoded');
    for (const track of tracks) normalise(track);

    const durationMs = Math.max(...tracks.map(track => Math.round((mediaDuration(track) * 1000) / track.timescale)));

    const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));

    // Pass one: the same tables with every chunk offset zeroed, purely to measure `moov`. The
    // offsets are values inside boxes whose SIZES are already fixed by the sample count, so the
    // length this produces is the length the real one has.
    const probe = moov(tracks, durationMs, () => 0);
    // 8 bytes of `mdat` header sit between `moov` and the first sample.
    const mdatStart = ftyp.length + probe.length + 8;

    const ordered = interleave(tracks);
    const offsets = new Map<Sample, number>();
    let cursor = mdatStart;
    // Interleaved in presentation order across both tracks, which is what keeps a player's two
    // buffers filling together instead of one starving while the other runs ahead.
    for (const sample of ordered) {
      offsets.set(sample, cursor);
      cursor += sample.data.length;
    }
    const mdatSize = cursor - mdatStart + 8;

    const real = moov(tracks, durationMs, sample => offsets.get(sample) ?? 0);
    if (real.length !== probe.length) {
      // Cannot happen - the tables have the same shape in both passes - and is checked rather than
      // trusted because the failure it would cause is a file that plays as garbage rather than one
      // that fails to open.
      throw new Error('mp4: moov changed size between passes');
    }

    const parts: BlobPart[] = [ftyp, real, mdatHeader(mdatSize)];
    for (const sample of ordered) parts.push(sample.data);
    return new Blob(parts, { type: 'video/mp4' });
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Track normalisation                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * Moves a track's times so the media starts at zero and gives every sample a decode time.
 *
 * WebCodecs reports a PRESENTATION time and nothing else, which is all there is to report when the
 * encoder emits no B-frames - the case for every configuration this package asks for. A stream that
 * does reorder frames arrives out of presentation order, and the fix is the standard one: decode
 * times are the sorted presentation times, and every presentation time is pushed back far enough
 * that no sample is shown before it is decoded, which becomes a composition offset in `ctts`.
 */
function normalise(track: Track): void {
  const samples = track.samples;
  if (samples.length === 0) return;

  const base = Math.min(...samples.map(sample => sample.dts));
  for (const sample of samples) {
    sample.dts -= base;
    sample.cts -= base;
  }

  let reordered = false;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i]?.cts ?? 0) < (samples[i - 1]?.cts ?? 0)) {
      reordered = true;
      break;
    }
  }

  if (reordered) {
    const sorted = samples.map(sample => sample.cts).sort((a, b) => a - b);
    // How far back decode has to run for the latest-arriving frame to still be decoded in time.
    let shift = 0;
    for (let i = 0; i < samples.length; i++) {
      shift = Math.max(shift, (sorted[i] ?? 0) - (samples[i]?.cts ?? 0));
    }
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (!sample) continue;
      sample.dts = sorted[i] ?? 0;
      sample.cts += shift;
    }
  }

  // The gap to the next sample is the truth about how long this one is on screen; the encoder's own
  // `duration` is only a fallback, and only the last sample needs one.
  for (let i = 0; i < samples.length - 1; i++) {
    const sample = samples[i];
    const next = samples[i + 1];
    if (!sample || !next) continue;
    sample.durationTicks = Math.max(1, next.dts - sample.dts);
  }
}

function mediaDuration(track: Track): number {
  const last = track.samples[track.samples.length - 1];
  return last ? last.dts + last.durationTicks : 0;
}

/** Samples of every track in one stream, ordered by presentation time. */
function interleave(tracks: Track[]): Sample[] {
  const all: { sample: Sample; seconds: number }[] = [];
  for (const track of tracks) {
    for (const sample of track.samples) {
      all.push({ sample, seconds: sample.cts / track.timescale });
    }
  }
  all.sort((a, b) => a.seconds - b.seconds);
  return all.map(entry => entry.sample);
}

/* -------------------------------------------------------------------------------------------- */
/* Boxes                                                                                          */
/* -------------------------------------------------------------------------------------------- */

function moov(tracks: Track[], durationMs: number, offsetOf: (sample: Sample) => number): Bytes {
  return box('moov', mvhd(durationMs, Math.max(...tracks.map(track => track.id)) + 1), ...tracks.map(track => trak(track, durationMs, offsetOf)));
}

function mvhd(durationMs: number, nextTrackId: number): Bytes {
  return fullBox(
    'mvhd',
    0,
    0,
    // Creation and modification are deliberately zero: a render is not a document with a history,
    // and a real clock here would make two identical renders two different files.
    u32(0),
    u32(0),
    u32(MOVIE_TIMESCALE),
    u32(durationMs),
    u32(0x0001_0000), // rate 1.0
    u16(0x0100), // volume 1.0
    u16(0),
    u32(0),
    u32(0),
    MATRIX,
    new Uint8Array(24), // pre_defined
    u32(nextTrackId),
  );
}

function trak(track: Track, durationMs: number, offsetOf: (sample: Sample) => number): Bytes {
  return box('trak', tkhd(track, durationMs), mdia(track, offsetOf));
}

function tkhd(track: Track, durationMs: number): Bytes {
  const isVideo = track.kind === 'video';
  return fullBox(
    'tkhd',
    0,
    // enabled | in movie | in preview.
    0x000007,
    u32(0),
    u32(0),
    u32(track.id),
    u32(0),
    u32(durationMs),
    u32(0),
    u32(0),
    u16(0), // layer
    u16(0), // alternate group
    u16(isVideo ? 0 : 0x0100), // volume: audio only
    u16(0),
    MATRIX,
    // 16.16 fixed pixels. Zero for audio, which has no picture to declare.
    u32(isVideo ? track.width * 0x10000 : 0),
    u32(isVideo ? track.height * 0x10000 : 0),
  );
}

function mdia(track: Track, offsetOf: (sample: Sample) => number): Bytes {
  return box(
    'mdia',
    fullBox(
      'mdhd',
      0,
      0,
      u32(0),
      u32(0),
      u32(track.timescale),
      u32(mediaDuration(track)),
      // 'und', packed as three five-bit letters offset from 0x60.
      u16(0x55c4),
      u16(0),
    ),
    fullBox(
      'hdlr',
      0,
      0,
      u32(0),
      ascii(track.kind === 'video' ? 'vide' : 'soun'),
      u32(0),
      u32(0),
      u32(0),
      // A name, null terminated. Some tools show it; nothing depends on it.
      ascii(track.kind === 'video' ? 'VideoHandler\0' : 'SoundHandler\0'),
    ),
    minf(track, offsetOf),
  );
}

function minf(track: Track, offsetOf: (sample: Sample) => number): Bytes {
  const header = track.kind === 'video' ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : fullBox('smhd', 0, 0, u16(0), u16(0));
  return box(
    'minf',
    header,
    // Self-contained: every sample is in this file, so the one data entry is the flag that says so.
    box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
    stbl(track, offsetOf),
  );
}

function stbl(track: Track, offsetOf: (sample: Sample) => number): Bytes {
  const samples = track.samples;
  const parts: Uint8Array[] = [stsd(track), stts(samples)];

  if (track.kind === 'video') {
    const syncs: number[] = [];
    samples.forEach((sample, index) => {
      if (sample.isSync) syncs.push(index + 1);
    });
    // Omitted when every sample is a sync sample, which is what the spec says its absence means.
    if (syncs.length !== samples.length) {
      parts.push(fullBox('stss', 0, 0, u32(syncs.length), ...syncs.map(u32)));
    }
    const ctts = cttsBox(samples);
    if (ctts) parts.push(ctts);
  }

  // One sample per chunk. The tables are a few kilobytes for a minute of video, and grouping
  // samples into chunks would buy nothing: they are written in the same order either way.
  parts.push(fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)));
  parts.push(fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map(s => u32(s.data.length))));

  const offsets = samples.map(offsetOf);
  const needs64 = offsets.some(offset => offset > 0xffff_ffff);
  parts.push(needs64 ? fullBox('co64', 0, 0, u32(offsets.length), ...offsets.map(u64)) : fullBox('stco', 0, 0, u32(offsets.length), ...offsets.map(u32)));

  return box('stbl', ...parts);
}

function stsd(track: Track): Bytes {
  return fullBox('stsd', 0, 0, u32(1), track.kind === 'video' ? avc1(track) : mp4a(track));
}

function avc1(track: Track): Bytes {
  return box(
    'avc1',
    new Uint8Array(6), // reserved
    u16(1), // data_reference_index
    u16(0),
    u16(0),
    new Uint8Array(12), // pre_defined
    u16(track.width),
    u16(track.height),
    u32(0x0048_0000), // 72 dpi, the value every muxer writes
    u32(0x0048_0000),
    u32(0),
    u16(1), // frame_count
    new Uint8Array(32), // compressorname
    u16(0x0018), // depth
    u16(0xffff), // pre_defined
    box('avcC', track.description),
  );
}

function mp4a(track: Track): Bytes {
  return box(
    'mp4a',
    new Uint8Array(6),
    u16(1),
    u16(0), // version
    u16(0), // revision
    u32(0), // vendor
    u16(track.channels),
    u16(16), // sample size
    u16(0),
    u16(0),
    // 16.16 fixed. A rate above 65535 would not fit and no AAC profile this package asks for has
    // one, so the integer part is the rate as it stands.
    u32(track.sampleRate * 0x10000),
    esds(track),
  );
}

/**
 * The MPEG-4 descriptor chain that says "this is AAC, and here is its AudioSpecificConfig".
 *
 * Descriptor lengths use the expandable encoding, always written in its four-byte form. Minimal
 * encoding is legal too and up to three bytes shorter; the padded form is what most muxers emit,
 * every parser accepts it, and it keeps the length arithmetic from having to know its own size.
 */
function esds(track: Track): Bytes {
  const decoderSpecific = descriptor(0x05, track.description);
  const decoderConfig = descriptor(
    0x04,
    concat(
      new Uint8Array([0x40]), // MPEG-4 audio
      new Uint8Array([0x15]), // stream type: audio, not upstream, reserved bit set
      u24(0), // buffer size
      u32(track.bitrate), // max bitrate
      u32(track.bitrate), // average bitrate
      decoderSpecific,
    ),
  );
  const slConfig = descriptor(0x06, new Uint8Array([0x02]));
  const es = descriptor(0x03, concat(u16(track.id), new Uint8Array([0x00]), decoderConfig, slConfig));
  return fullBox('esds', 0, 0, es);
}

function descriptor(tag: number, payload: Uint8Array): Bytes {
  const size = payload.length;
  return concat(new Uint8Array([tag, 0x80 | ((size >> 21) & 0x7f), 0x80 | ((size >> 14) & 0x7f), 0x80 | ((size >> 7) & 0x7f), size & 0x7f]), payload);
}

/** Run-length encoded sample durations. */
function stts(samples: Sample[]): Bytes {
  const runs: { count: number; delta: number }[] = [];
  for (const sample of samples) {
    const last = runs[runs.length - 1];
    if (last && last.delta === sample.durationTicks) last.count++;
    else runs.push({ count: 1, delta: sample.durationTicks });
  }
  return fullBox('stts', 0, 0, u32(runs.length), ...runs.flatMap(run => [u32(run.count), u32(run.delta)]));
}

/** Composition offsets, or null when presentation and decode order agree - which is the usual case. */
function cttsBox(samples: Sample[]): Bytes | null {
  if (samples.every(sample => sample.cts === sample.dts)) return null;
  const runs: { count: number; offset: number }[] = [];
  for (const sample of samples) {
    const offset = sample.cts - sample.dts;
    const last = runs[runs.length - 1];
    if (last && last.offset === offset) last.count++;
    else runs.push({ count: 1, offset });
  }
  return fullBox('ctts', 0, 0, u32(runs.length), ...runs.flatMap(run => [u32(run.count), u32(run.offset)]));
}

function mdatHeader(size: number): Bytes {
  return concat(u32(size), ascii('mdat'));
}

/* -------------------------------------------------------------------------------------------- */
/* Bytes                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export function box(type: string, ...payload: Uint8Array[]): Bytes {
  const body = concat(...payload);
  return concat(u32(body.length + 8), ascii(type), body);
}

export function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Bytes {
  return box(type, new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...payload);
}

export function concat(...parts: Uint8Array[]): Bytes {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function ascii(value: string): Bytes {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
  return out;
}

function u16(value: number): Bytes {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function u24(value: number): Bytes {
  return new Uint8Array([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Bytes {
  // `>>>` throughout: a shift of a value above 2^31 through the signed operators comes back
  // negative, and `& 0xff` on that is the wrong byte.
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u64(value: number): Bytes {
  const high = Math.floor(value / 0x1_0000_0000);
  return concat(u32(high), u32(value >>> 0));
}

/** The identity transformation matrix every file that does not rotate anything carries. */
const MATRIX: Bytes = concat(u32(0x0001_0000), u32(0), u32(0), u32(0), u32(0x0001_0000), u32(0), u32(0), u32(0), u32(0x4000_0000));
