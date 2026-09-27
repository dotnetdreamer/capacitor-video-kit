import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LabelMediaOptions, LabelMediaResult } from './definitions';

const kit = vi.hoisted(() => ({
  composer: { labelMedia: vi.fn<(options: LabelMediaOptions) => Promise<LabelMediaResult>>() },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => kit.composer,
  WebPlugin: class {},
}));

import { describeMedia } from './media-scenes';

/** A rejection as the bridge makes one: a message and a `code`. */
function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => {
  kit.composer.labelMedia.mockReset();
});

describe('describeMedia', () => {
  it('asks the phone about the file with the options it was given, and reads the answer into scenes', async () => {
    kit.composer.labelMedia.mockResolvedValue({
      engine: 'vision',
      revision: 2,
      kind: 'video',
      frames: [
        { timeMs: 1000, labels: [{ label: 'food', confidence: 0.8 }, { label: 'plate', confidence: 0.6 }] },
        { timeMs: 3000, labels: [{ label: 'beach', confidence: 0.6 }] },
      ],
    });

    const description = await describeMedia('file:///clip.mp4', { kind: 'video', frames: 2 });

    expect(kit.composer.labelMedia).toHaveBeenCalledWith({ kind: 'video', frames: 2, uri: 'file:///clip.mp4' });
    expect(description).toEqual({
      engine: 'vision',
      kind: 'video',
      scenes: [
        { scene: 'food', score: 0.4 },
        { scene: 'beach', score: 0.3 },
      ],
      /* Each label's mean over the two frames, a frame without it counting as 0. */
      labels: [
        { label: 'food', confidence: 0.4 },
        { label: 'beach', confidence: 0.3 },
        { label: 'plate', confidence: 0.3 },
      ],
      frames: 2,
    });
  });

  it('reads ML Kit labels with the ML Kit table', async () => {
    kit.composer.labelMedia.mockResolvedValue({
      engine: 'mlkit',
      kind: 'image',
      frames: [{ timeMs: 0, labels: [{ label: 'Pet', confidence: 0.97 }, { label: 'Dog', confidence: 0.99 }] }],
    });
    const description = await describeMedia('content://media/external/images/media/7');
    expect(description?.scenes[0]).toEqual({ scene: 'pet', score: 0.97 });
    expect(description?.kind).toBe('image');
  });

  it('answers null where there is no recogniser: a browser, or a native build older than the call', async () => {
    kit.composer.labelMedia.mockRejectedValueOnce(coded('unsupported'));
    await expect(describeMedia('blob:https://example.test/a')).resolves.toBeNull();
    kit.composer.labelMedia.mockRejectedValueOnce(coded('UNIMPLEMENTED'));
    await expect(describeMedia('file:///clip.mp4')).resolves.toBeNull();
  });

  it('rejects for a file that cannot be read, which is something to say about the file', async () => {
    kit.composer.labelMedia.mockRejectedValueOnce(coded('unreadable_input'));
    await expect(describeMedia('file:///gone.mp4')).rejects.toMatchObject({ code: 'unreadable_input' });
    kit.composer.labelMedia.mockRejectedValueOnce(new Error('bridge went away'));
    await expect(describeMedia('file:///clip.mp4')).rejects.toThrow('bridge went away');
  });

  it('answers an empty description for an answer with no frames in it', async () => {
    kit.composer.labelMedia.mockResolvedValue({ engine: 'vision', kind: 'video', frames: [] });
    await expect(describeMedia('file:///clip.mp4')).resolves.toEqual({
      engine: 'vision',
      kind: 'video',
      scenes: [],
      labels: [],
      frames: 0,
    });
  });
});
