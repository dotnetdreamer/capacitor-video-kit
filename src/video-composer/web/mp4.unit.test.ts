import { describe, expect, it } from 'vitest';

import { Mp4Writer, VIDEO_TIMESCALE } from './mp4';

/**
 * The container, read back out of its own bytes.
 *
 * A muxer is the one part of this renderer whose output nobody can eyeball: it is right, or the file
 * does not open - and "does not open" is the same symptom for a wrong box order, a wrong chunk
 * offset and a wrong sample size. So the test parses the file the way a player would, walking the
 * box tree and following the offsets to the samples they claim to point at.
 */

/** The smallest walk of an ISO box tree that can answer where things are. */
interface Box {
  type: string;
  start: number;
  size: number;
  /** Where the payload begins, after the size and the type. */
  body: number;
}

function boxes(view: DataView, from: number, to: number): Box[] {
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size = view.getUint32(at);
    if (size < 8 || at + size > to) break;
    found.push({ type: fourcc(view, at + 4), start: at, size, body: at + 8 });
    at += size;
  }
  return found;
}

function fourcc(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

/** Follows a path of box types down the tree. */
function find(view: DataView, path: string[], from: number, to: number): Box | null {
  let scope = { from, to };
  let box: Box | null = null;
  for (const type of path) {
    box = boxes(view, scope.from, scope.to).find(candidate => candidate.type === type) ?? null;
    if (!box) return null;
    scope = { from: box.body, to: box.start + box.size };
  }
  return box;
}

/** A full box's payload starts four bytes later: one of version, three of flags. */
function fullBody(box: Box): number {
  return box.body + 4;
}

const AVCC = [1, 0x42, 0, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0, 0, 0, 1, 0, 0];

async function writeOne(): Promise<DataView> {
  const writer = new Mp4Writer();
  const video = writer.addVideoTrack({
    width: 720,
    height: 1280,
    description: new Uint8Array(AVCC),
    bitrate: 6_000_000,
  });
  for (let i = 0; i < 3; i++) {
    writer.addSample(video, {
      data: new Uint8Array([i + 1, i + 1, i + 1, i + 1]),
      timestampUs: i * 33_333,
      durationUs: 33_333,
      isSync: i === 0,
    });
  }
  return new DataView(await writer.finalize().arrayBuffer());
}

describe('Mp4Writer', () => {
  it('refuses to write a file with nothing in it', () => {
    expect(() => new Mp4Writer().finalize()).toThrow(/nothing was encoded/);
  });

  it('writes ftyp, then moov, then mdat - so a player can start before the file has arrived', async () => {
    const view = await writeOne();
    expect(boxes(view, 0, view.byteLength).map(box => box.type)).toEqual(['ftyp', 'moov', 'mdat']);
  });

  it('declares the track it actually wrote', async () => {
    const view = await writeOne();
    const moov = find(view, ['moov'], 0, view.byteLength);
    expect(moov).not.toBeNull();
    if (!moov) return;
    const end = moov.start + moov.size;

    const mdhd = find(view, ['trak', 'mdia', 'mdhd'], moov.body, end);
    expect(mdhd).not.toBeNull();
    if (!mdhd) return;
    // timescale sits after creation and modification time.
    expect(view.getUint32(fullBody(mdhd) + 8)).toBe(VIDEO_TIMESCALE);

    const stsd = find(view, ['trak', 'mdia', 'minf', 'stbl', 'stsd'], moov.body, end);
    expect(stsd).not.toBeNull();
    if (!stsd) return;
    // stsd is a full box carrying an entry count before the sample entry itself.
    const entry = boxes(view, fullBody(stsd) + 4, stsd.start + stsd.size)[0];
    expect(entry?.type).toBe('avc1');
    if (!entry) return;
    // The width and height sit 24 bytes into a visual sample entry's payload.
    expect(view.getUint16(entry.body + 24)).toBe(720);
    expect(view.getUint16(entry.body + 26)).toBe(1280);
    // ...and the encoder's own description comes after it, in avcC.
    const avcC = boxes(view, entry.body + 78, entry.start + entry.size)[0];
    expect(avcC?.type).toBe('avcC');
  });

  it('run-length encodes the sample durations', async () => {
    const view = await writeOne();
    const moov = find(view, ['moov'], 0, view.byteLength);
    expect(moov).not.toBeNull();
    if (!moov) return;
    const stts = find(view, ['trak', 'mdia', 'minf', 'stbl', 'stts'], moov.body, moov.start + moov.size);
    expect(stts).not.toBeNull();
    if (!stts) return;
    // Three samples, one entry: the whole point of the encoding.
    expect(view.getUint32(fullBody(stts))).toBe(1);
    expect(view.getUint32(fullBody(stts) + 4)).toBe(3);
    // 33333 us at 90 kHz is 3000 ticks.
    expect(view.getUint32(fullBody(stts) + 8)).toBe(3000);
  });

  it('lists only the sync samples, because one of three is a keyframe', async () => {
    const view = await writeOne();
    const moov = find(view, ['moov'], 0, view.byteLength);
    expect(moov).not.toBeNull();
    if (!moov) return;
    const stss = find(view, ['trak', 'mdia', 'minf', 'stbl', 'stss'], moov.body, moov.start + moov.size);
    expect(stss).not.toBeNull();
    if (!stss) return;
    expect(view.getUint32(fullBody(stss))).toBe(1);
    // One-based, so the first sample is 1.
    expect(view.getUint32(fullBody(stss) + 4)).toBe(1);
  });

  it('points every chunk offset at the sample it claims, which is the whole ballgame', async () => {
    const view = await writeOne();
    const moov = find(view, ['moov'], 0, view.byteLength);
    expect(moov).not.toBeNull();
    if (!moov) return;
    const end = moov.start + moov.size;

    const stco = find(view, ['trak', 'mdia', 'minf', 'stbl', 'stco'], moov.body, end);
    const stsz = find(view, ['trak', 'mdia', 'minf', 'stbl', 'stsz'], moov.body, end);
    expect(stco).not.toBeNull();
    expect(stsz).not.toBeNull();
    if (!stco || !stsz) return;

    expect(view.getUint32(fullBody(stco))).toBe(3);
    // stsz: a sample_size of 0 means "read the table", then the count, then the sizes.
    expect(view.getUint32(fullBody(stsz))).toBe(0);
    expect(view.getUint32(fullBody(stsz) + 4)).toBe(3);

    for (let i = 0; i < 3; i++) {
      const offset = view.getUint32(fullBody(stco) + 4 + i * 4);
      const size = view.getUint32(fullBody(stsz) + 8 + i * 4);
      expect(size).toBe(4);
      // The bytes at the offset are the bytes that sample was handed - the one claim the tables
      // make that a player will actually act on.
      expect(view.getUint8(offset)).toBe(i + 1);
      expect(view.getUint8(offset + 3)).toBe(i + 1);
    }
  });

  it('writes an audio track with its AAC config in esds', async () => {
    const writer = new Mp4Writer();
    const video = writer.addVideoTrack({
      width: 64,
      height: 64,
      description: new Uint8Array(AVCC),
      bitrate: 500_000,
    });
    writer.addSample(video, {
      data: new Uint8Array([9, 9, 9, 9]),
      timestampUs: 0,
      durationUs: 33_333,
      isSync: true,
    });
    const audio = writer.addAudioTrack({
      sampleRate: 48_000,
      channels: 2,
      description: new Uint8Array([0x11, 0x90]),
      bitrate: 128_000,
    });
    writer.addSample(audio, {
      data: new Uint8Array([1, 2, 3]),
      timestampUs: 0,
      durationUs: 21_333,
      isSync: true,
    });

    const view = new DataView(await writer.finalize().arrayBuffer());
    const moov = find(view, ['moov'], 0, view.byteLength);
    expect(moov).not.toBeNull();
    if (!moov) return;
    const traks = boxes(view, moov.body, moov.start + moov.size).filter(box => box.type === 'trak');
    expect(traks).toHaveLength(2);

    const soundTrak = traks[1];
    if (!soundTrak) return;
    const stsd = find(view, ['mdia', 'minf', 'stbl', 'stsd'], soundTrak.body, soundTrak.start + soundTrak.size);
    expect(stsd).not.toBeNull();
    if (!stsd) return;
    const entry = boxes(view, fullBody(stsd) + 4, stsd.start + stsd.size)[0];
    expect(entry?.type).toBe('mp4a');
    if (!entry) return;
    expect(view.getUint16(entry.body + 16)).toBe(2);
    // The sample rate is 16.16 fixed point, so the integer part is in the top half.
    expect(view.getUint16(entry.body + 24)).toBe(48_000);
    const esds = boxes(view, entry.body + 28, entry.start + entry.size)[0];
    expect(esds?.type).toBe('esds');
  });
});
