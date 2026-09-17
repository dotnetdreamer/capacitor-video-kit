import { describe, expect, it } from 'vitest';

import { MIN_LAYER_MS, type EditMusic } from '../../editor';
import { musicEndTrim, musicStartTrim } from './timeline-drags';

/** A thirty second track, used whole, laid at the start of the video. */
function track(over: Partial<EditMusic> = {}): EditMusic {
  return {
    uri: 'file:///song.m4a',
    fileName: 'song.m4a',
    sourceDurationMs: 30_000,
    inMs: 0,
    outMs: 0,
    startMs: 0,
    volume: 1,
    loop: false,
    fadeOutMs: 0,
    ...over,
  };
}

describe('musicStartTrim', () => {
  it('moves the in point and the placement together', () => {
    // The sound that was under the handle has to stay where it was on the video, so both values
    // move by the same amount rather than the bar sliding over a fixed section.
    const music = track({ startMs: 5000, inMs: 2000 });
    expect(musicStartTrim(music, 7000, 20_000)).toEqual({ startMs: 7000, inMs: 4000 });
  });

  it('stops at the start of the track even with video to spare', () => {
    const music = track({ startMs: 5000, inMs: 2000 });
    expect(musicStartTrim(music, 1000, 20_000)).toEqual({ startMs: 3000, inMs: 0 });
  });

  it('stops at the start of the video even with track to spare', () => {
    const music = track({ startMs: 1000, inMs: 5000 });
    expect(musicStartTrim(music, -3000, 20_000)).toEqual({ startMs: 0, inMs: 4000 });
  });

  it('leaves a section against the end of the video', () => {
    const music = track({ startMs: 0, inMs: 0 });
    const moved = musicStartTrim(music, 12_000, 10_000);
    expect(moved).toEqual({ startMs: 9900, inMs: 9900 });
    expect(10_000 - (moved.startMs ?? 0)).toBe(MIN_LAYER_MS);
  });

  it('leaves a section against the end of the track', () => {
    // The section ends at 4000, so the in point can come no closer than MIN_LAYER_MS to it however
    // much video is left to lay the bar on.
    const music = track({ startMs: 0, inMs: 0, outMs: 4000 });
    const moved = musicStartTrim(music, 10_000, 60_000);
    expect(moved).toEqual({ startMs: 3900, inMs: 3900 });
    expect(4000 - (moved.inMs ?? 0)).toBe(MIN_LAYER_MS);
  });

  it('is held only by the video when the track length could not be read', () => {
    const music = track({ sourceDurationMs: 0 });
    expect(musicStartTrim(music, 3000, 10_000)).toEqual({ startMs: 3000, inMs: 3000 });
  });

  it('holds still rather than jumping when the bar already starts past the end of the video', () => {
    // A video shortened under a track that was laid on the old length. There is no move that both
    // keeps the in point on the track and leaves a section, so the answer is not to move.
    const music = track({ startMs: 9000, inMs: 0 });
    expect(musicStartTrim(music, 4000, 5000)).toEqual({ startMs: 9000, inMs: 0 });
  });

  it('answers in whole milliseconds', () => {
    expect(musicStartTrim(track(), 2000.6, 20_000)).toEqual({ startMs: 2001, inMs: 2001 });
  });
});

describe('musicEndTrim', () => {
  it('sets how long the section runs, from where the bar starts', () => {
    const music = track({ startMs: 1000, inMs: 2000 });
    expect(musicEndTrim(music, 6000, 20_000)).toEqual({ outMs: 7000 });
  });

  it('never runs the bar past the video', () => {
    const music = track({ startMs: 1000, inMs: 2000 });
    expect(musicEndTrim(music, 25_000, 20_000)).toEqual({ outMs: 21_000 });
  });

  it('never runs the section past the end of the track', () => {
    const music = track({ startMs: 0, inMs: 25_000 });
    expect(musicEndTrim(music, 50_000, 60_000)).toEqual({ outMs: 30_000 });
  });

  it('keeps a section of at least MIN_LAYER_MS when the handle is dragged onto the start', () => {
    const music = track({ startMs: 5000 });
    expect(musicEndTrim(music, 5000, 20_000)).toEqual({ outMs: MIN_LAYER_MS });
  });

  it('is held only by the video when the track length could not be read', () => {
    const music = track({ sourceDurationMs: 0 });
    expect(musicEndTrim(music, 50_000, 8000)).toEqual({ outMs: 8000 });
  });

  it('answers in whole milliseconds', () => {
    expect(musicEndTrim(track(), 4000.6, 20_000)).toEqual({ outMs: 4001 });
  });
});
