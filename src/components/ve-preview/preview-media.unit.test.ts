import { afterEach, describe, expect, it } from 'vitest';

import type { EditClip, EditMusic } from '../../editor';
import {
  AUDIO_END_GUARD_MS,
  applyPitch,
  applySoundRate,
  atFileEnd,
  audioEndGuardMs,
  musicSpan,
  passFollows,
  playedOut,
  soundOffsetMs,
  soundPutMs,
  takeSpan,
  wrapAimMs,
  type SoundSpan,
} from './preview-media';

/**
 * Pitch correction on a preview element: on only where the clip's own sound is heard. On iOS it is
 * what makes every change of rate on a playing element flush the player back to a keyframe, so a
 * clip nobody can hear must not have it - and one that can be heard must, or a slowed clip's sound
 * drops in pitch where the render keeps it.
 */

function clip(extra: Partial<EditClip> = {}): EditClip {
  return { id: 'a', clipKey: 'one', inMs: 0, outMs: 1000, speed: 0.5, volume: 1, muted: false, ...extra };
}

/** An element that counts its writes, as the media process would see them. */
function element(preservesPitch: boolean | undefined = true) {
  let value: boolean | undefined = preservesPitch;
  let writes = 0;
  return {
    get preservesPitch() {
      return value;
    },
    set preservesPitch(keep: boolean | undefined) {
      writes += 1;
      value = keep;
    },
    get writes() {
      return writes;
    },
  };
}

describe('applySoundRate', () => {
  /** A sound's element as [applySoundRate] writes to it: its two rates, and a pitch correction that counts its writes. */
  function audio(preservesPitch: boolean | undefined = true) {
    return Object.assign(element(preservesPitch), { defaultPlaybackRate: 1, playbackRate: 1 });
  }
  const apply = (el: ReturnType<typeof audio>, rate: number) => applySoundRate(el as unknown as HTMLMediaElement, rate);

  it('plays a sound at its speed at its own pitch, writing nothing it does not change', () => {
    const el = audio();
    apply(el, 0.8);
    expect(el).toMatchObject({ playbackRate: 0.8, defaultPlaybackRate: 0.8, preservesPitch: true, writes: 0 });
  });

  it('puts back a pitch correction something took off', () => {
    const el = audio(false);
    apply(el, 1.5);
    expect(el.preservesPitch).toBe(true);
  });

  it('leaves the correction alone at 1x, where it does nothing', () => {
    const el = audio(false);
    apply(el, 1);
    apply(el, 1);
    expect(el).toMatchObject({ playbackRate: 1, preservesPitch: false, writes: 0 });
  });
});

describe('applyPitch', () => {
  it('keeps the pitch of a clip whose sound is heard', () => {
    const video = element(false);
    applyPitch(video, clip(), false);
    expect(video.preservesPitch).toBe(true);
  });

  it('turns it off for a clip that is muted, turned right down, or silenced with the rest of the post', () => {
    for (const [edit, silenced] of [
      [clip({ muted: true }), false],
      [clip({ volume: 0 }), false],
      [clip(), true],
    ] as const) {
      const video = element(true);
      applyPitch(video, edit, silenced);
      expect(video.preservesPitch).toBe(false);
    }
  });

  it('writes only when it has to, and puts back what a WebView reset with a new source', () => {
    const video = element(false);
    applyPitch(video, clip({ muted: true }), false);
    applyPitch(video, clip({ muted: true }), false);
    expect(video.writes).toBe(0);
    // A new source: this WebView turned it back on by itself.
    video.preservesPitch = true;
    applyPitch(video, clip({ muted: true }), false);
    expect(video.preservesPitch).toBe(false);
    expect(video.writes).toBe(2);
  });
});

/*
 * Where the music and a voiceover take are put, as positions in their files. The seams of a repeating
 * section are the case all of this is for: at a seam the playhead and the element are on different
 * passes for a moment, and reading that as a whole section of drift pulled the element back across
 * the seam it had just been sent over.
 */

/** A 12 s track looped whole under the post, with `leftMs` of the post still to come. */
function whole(leftMs: number): SoundSpan {
  return { inMs: 0, outMs: 12_000, loop: true, leftMs, rate: 1 };
}

/** Seconds 2 to 5 of the track, looped. */
function section(leftMs: number): SoundSpan {
  return { inMs: 2000, outMs: 5000, loop: true, leftMs, rate: 1 };
}

describe('the spans the music and a take are played on', () => {
  const music: EditMusic = {
    uri: 'track.m4a',
    fileName: 'track.m4a',
    sourceDurationMs: 11_975,
    inMs: 0,
    outMs: 0,
    startMs: 0,
    endMs: 0,
    volume: 1,
    loop: true,
    fadeOutMs: 0,
  };

  it('is the section of the track, to the end of the file when the section has no out point', () => {
    expect(musicSpan(music, 5000)).toEqual({ inMs: 0, outMs: 11_975, loop: true, leftMs: 5000, rate: 1 });
    expect(musicSpan({ ...music, inMs: 2000, outMs: 5000 }, 5000)).toEqual({ inMs: 2000, outMs: 5000, loop: true, leftMs: 5000, rate: 1 });
  });

  it('knows no out point, and does not repeat, for a track whose length is not known', () => {
    expect(musicSpan({ ...music, sourceDurationMs: 0 }, 5000)).toEqual({ inMs: 0, outMs: Infinity, loop: false, leftMs: 5000, rate: 1 });
  });

  it('is played at the sound’s speed, with what is left of it counted in the file', () => {
    // Five seconds of the post at 2x is ten seconds of the track still to play.
    expect(musicSpan({ ...music, speed: 2 }, 5000)).toEqual({ inMs: 0, outMs: 11_975, loop: true, leftMs: 10_000, rate: 2 });
    expect(musicSpan({ ...music, speed: 0.5 }, 5000)).toMatchObject({ leftMs: 2500, rate: 0.5 });
  });

  it('is a take from its first moment to its last', () => {
    expect(takeSpan({ id: 't', uri: 'take.m4a', startMs: 3000, durationMs: 1000, volume: 1 }, 3400)).toEqual({ inMs: 0, outMs: 1000, loop: false, leftMs: 600, rate: 1 });
  });
});

describe('soundOffsetMs', () => {
  it('is how far ahead the element is, and behind is negative', () => {
    expect(soundOffsetMs(5080, 5000, whole(10_000))).toBe(80);
    expect(soundOffsetMs(4920, 5000, whole(10_000))).toBe(-80);
  });

  it('is measured round the loop at a seam, whichever of the two has gone round first', () => {
    // The playhead has gone round; the element is 50 ms behind it, finishing the last pass.
    expect(soundOffsetMs(11_980, 30, whole(10_000))).toBe(-50);
    // The element has been sent round; the playhead is 60 ms short of the seam.
    expect(soundOffsetMs(40, 11_940, whole(10_000))).toBe(100);
    // Seconds 2 to 5: the element back at 2.05 s while the playhead is at 4.97 s.
    expect(soundOffsetMs(2050, 4970, section(10_000))).toBe(80);
  });

  it('is taken straight for a sound that does not repeat, and for an element off the section', () => {
    expect(soundOffsetMs(40, 11_940, { ...whole(10_000), loop: false })).toBe(-11_900);
    // Played on past the out point of seconds 2 to 5: that is not the start of the next pass.
    expect(soundOffsetMs(5100, 2020, section(10_000))).toBe(3080);
  });
});

describe('passFollows', () => {
  it('is whether the sound goes on past the end of the pass the element is on', () => {
    expect(passFollows(11_900, 11_900, whole(1000))).toBe(true);
    // The post, or the music's own stop, ends exactly at this seam: nothing to go round to.
    expect(passFollows(11_900, 11_900, whole(100))).toBe(false);
    expect(passFollows(11_900, 11_900, { ...whole(1000), loop: false })).toBe(false);
  });

  it("counts from the element's pass when the playhead has already gone round", () => {
    // The playhead is 30 ms into what is the LAST pass, and the element is still finishing the pass
    // before it: that pass is followed - by the one the playhead is on.
    expect(passFollows(11_950, 30, whole(500))).toBe(true);
  });
});

describe('soundPutMs', () => {
  it('puts a paused element its start stall ahead of where the playhead is', () => {
    expect(soundPutMs(5000, 150, whole(10_000))).toBe(5150);
  });

  it('starts sound that is not due yet at the start of the file', () => {
    expect(soundPutMs(-100, 60, whole(10_000))).toBe(0);
  });

  it('goes round to the next pass when the stall carries it over the seam', () => {
    expect(soundPutMs(11_900, 150, whole(10_000))).toBe(50);
    expect(soundPutMs(4950, 150, section(10_000))).toBe(2100);
  });

  it('goes round already where the file ends before the section does', () => {
    // WebKit reads the 12 s track as 11.975 s.
    expect(soundPutMs(11_850, 150, whole(10_000), 11_975, AUDIO_END_GUARD_MS)).toBe(0);
    expect(soundPutMs(11_700, 150, whole(10_000), 11_975, AUDIO_END_GUARD_MS)).toBe(11_850);
  });

  it('waits for the seam where the put would land inside the end guard, rather than start the next pass early', () => {
    // The track as WebKit reads it, looped whole.
    const track: SoundSpan = { inMs: 0, outMs: 11_975, loop: true, leftMs: 10_000, rate: 1 };
    // 45 ms short of the end: inside WebKit's guard, where it is not put. Round onto the next pass it
    // would have to go 45 ms before the in point, so it is not put at all yet - and goes round exactly
    // a check later, once the stall carries it past the end.
    expect(soundPutMs(11_780, 150, track, 11_975, AUDIO_END_GUARD_MS)).toBeNull();
    expect(soundPutMs(11_830, 150, track, 11_975, AUDIO_END_GUARD_MS)).toBe(5);
    // Without a guard it is put there like anywhere else.
    expect(soundPutMs(11_780, 150, track, 11_975, 0)).toBe(11_930);
  });

  it('waits for the end of the section where the file ends 25 ms before it, rather than start the next pass early', () => {
    // The 12.000 s section iOS's composer reads the track as, over the 11.975 s WebKit's element has,
    // with the 100 ms zone a playing element is sent round in. 20 ms past the end of the file and 5 ms
    // short of the out point, there is nothing to put it on in this pass, and sent round it would start
    // the next one 5 ms early. It waits for the playhead instead.
    expect(soundPutMs(11_880, 100, whole(10_000), 11_975, AUDIO_END_GUARD_MS, 100)).toBeNull();
    // Once the stall carries it past the out point it goes round, onto where the playhead will be.
    expect(soundPutMs(11_910, 100, whole(10_000), 11_975, AUDIO_END_GUARD_MS, 100)).toBe(10);
    // A file that ends much further short of the out point is a length that is wrong, not a file read a
    // little short: it goes round at the end of the file at once, where the render loops it too.
    expect(soundPutMs(9950, 100, whole(10_000), 10_000, AUDIO_END_GUARD_MS, 100)).toBe(0);
  });

  it('never puts an element within a seek of the end of its file, where the seek would not be made', () => {
    // 5 ms short of the end, with no guard: an element that has ended sits at the end, a put that
    // close to it is skipped, and play() would take it back to the start of the file.
    expect(soundPutMs(11_820, 150, { ...whole(10_000), loop: false }, 11_975, 0)).toBeNull();
    expect(soundPutMs(11_815, 150, { ...whole(10_000), loop: false }, 11_975, 0)).toBe(11_965);
  });

  it('waits for the seam where the put would land where a playing element is sent round', () => {
    // The last 100 ms of seconds 2 to 5 are where a playing element is sent round: put at 4.95 s, it
    // would come out of this stall and go straight into the next one.
    expect(soundPutMs(4800, 150, section(10_000), Infinity, 0, 100)).toBeNull();
    expect(soundPutMs(4740, 150, section(10_000), Infinity, 0, 100)).toBe(4890);
    // Once the stall carries it past the seam it goes round, exactly.
    expect(soundPutMs(4860, 150, section(10_000), Infinity, 0, 100)).toBe(2010);
    // With nothing after this pass, the tail is what is left to play, and it is put there.
    expect(soundPutMs(4800, 150, section(200), Infinity, 0, 100)).toBe(4950);
  });

  it('puts nothing at all when there is less left of the sound than the stall and no pass after it', () => {
    expect(soundPutMs(11_900, 150, whole(100))).toBeNull();
    expect(soundPutMs(900, 150, takeSpan({ id: 't', uri: 'take.m4a', startMs: 0, durationMs: 1000, volume: 1 }, 900))).toBeNull();
  });
});

describe('wrapAimMs', () => {
  it('aims the element at where the playhead will be on the next pass once the seek stall is over', () => {
    // 100 ms to the seam and a 100 ms stall: the next pass's first moment.
    expect(wrapAimMs(11_900, 11_900, 100, whole(10_000))).toBe(0);
    // 80 ms to the seam and a 130 ms stall: 50 ms into the next pass.
    expect(wrapAimMs(11_910, 11_920, 130, whole(10_000))).toBe(50);
    // The playhead has already gone round and the element, behind it, has not.
    expect(wrapAimMs(11_950, 20, 100, whole(10_000))).toBe(120);
    expect(wrapAimMs(4950, 4960, 100, section(10_000))).toBe(2060);
  });

  it('comes out before the in point when the element is sent round further ahead of the seam than its stall', () => {
    expect(wrapAimMs(11_940, 11_860, 30, whole(10_000))).toBe(-110);
  });

  it('counts an element just past a short out point as at the end of its pass', () => {
    // Seconds 2 to 5, the element 40 ms past the out point. The playhead has gone round already:
    // where it will be once the stall is over, not a whole pass before that.
    expect(wrapAimMs(5040, 2020, 100, section(10_000))).toBe(2120);
    // The playhead is still short of the seam: the next pass's start, as for any element there.
    expect(wrapAimMs(5040, 4950, 100, section(10_000))).toBe(2050);
  });
});

describe('passFollows, for an element past the out point', () => {
  it("counts from the end of the element's pass, whichever pass the playhead is on", () => {
    // The playhead is 20 ms into the LAST pass of seconds 2 to 5 and the element 40 ms past the out
    // point of the pass before it: that pass is followed, by the playhead's.
    expect(passFollows(5040, 2020, section(2980))).toBe(true);
    // The element has played past the out point of the last pass: nothing follows it.
    expect(passFollows(5040, 4990, section(10))).toBe(false);
  });
});

describe('playedOut', () => {
  /** Seconds 2 to 5 of the track, heard once. */
  const once: SoundSpan = { inMs: 2000, outMs: 5000, loop: false, leftMs: 100, rate: 1 };

  it('is an element stopped at the out point of the last of the sound, a little ahead of the playhead', () => {
    expect(playedOut(5000, 4890, once, 11_975, 0, 600)).toBe(true);
    expect(playedOut(5020, 4890, once, 11_975, 0, 600)).toBe(true);
  });

  it('is an element stopped at the end of its file, where that comes before the out point', () => {
    // Chromium stops it right at the end; WebKit's is left no nearer than its guard.
    expect(playedOut(11_975, 11_900, { ...once, inMs: 0, outMs: Infinity }, 11_975, 0, 600)).toBe(true);
    expect(playedOut(11_940, 11_900, { ...once, inMs: 0, outMs: Infinity }, 11_975, AUDIO_END_GUARD_MS, 600)).toBe(true);
  });

  it('is not an element with more of the sound to play, or one the playhead is well short of or past', () => {
    // Short of the out point: there is more to play.
    expect(playedOut(4900, 4890, once, 11_975, 0, 600)).toBe(false);
    // A pass follows: it goes round, not stops.
    expect(playedOut(5000, 4890, section(10_000), 11_975, 0, 600)).toBe(false);
    // The playhead is further back than it can have run ahead: moved there, and heard again.
    expect(playedOut(5000, 4000, once, 11_975, 0, 600)).toBe(false);
    // The playhead is past it: not ahead at all.
    expect(playedOut(5000, 5010, once, 11_975, 0, 600)).toBe(false);
  });
});

describe('the end of an audio file', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'vendor');
  });

  it("is guarded on Apple's WebKit only", () => {
    Object.defineProperty(navigator, 'vendor', { value: 'Apple Computer, Inc.', configurable: true });
    expect(audioEndGuardMs()).toBe(AUDIO_END_GUARD_MS);
    Object.defineProperty(navigator, 'vendor', { value: 'Google Inc.', configurable: true });
    expect(audioEndGuardMs()).toBe(0);
  });

  it('is reached once the element has ended, or is inside the guard', () => {
    expect(atFileEnd({ ended: false, duration: 11.975, currentTime: 11.93 }, AUDIO_END_GUARD_MS)).toBe(true);
    expect(atFileEnd({ ended: false, duration: 11.975, currentTime: 11.92 }, AUDIO_END_GUARD_MS)).toBe(false);
    expect(atFileEnd({ ended: false, duration: 11.975, currentTime: 11.97 }, 0)).toBe(false);
    expect(atFileEnd({ ended: true, duration: 11.975, currentTime: 11.975 }, 0)).toBe(true);
    // A file whose length is not known yet has no end to be near.
    expect(atFileEnd({ ended: false, duration: Number.NaN, currentTime: 3 }, AUDIO_END_GUARD_MS)).toBe(false);
  });
});
