import { describe, expect, it } from 'vitest';

import { MAX_MUSIC_FADE_MS, MIN_LAYER_MS, defaultClipEdit, emptyManifest, normaliseManifest, totalDurationMs, type EditManifest, type EditMusic } from '../editor/edit-manifest';
import { musicMovedTo, patchMusic } from '../editor/edit-ops';
import { applyEditOps, type EditOp } from './ops';
import { summariseManifest } from './summary';
import { OP_REFERENCE, createTools, type ToolDefinition } from './tools';

/*
 * An agent's sound lands where the editor's own controls would put it, and a sound the editor would
 * not keep is refused with both ends named - never handed back unchanged as though it had been done.
 *
 * The editor refuses a section or a stop under MIN_LAYER_MS by returning the manifest as it was, and
 * every control on the music goes through that one function, so a sound that broke the rule was one
 * nobody could hear or change. These pin the three ways it used to get in or go quiet: `setMusic`
 * taking a stop before the start, `patchMusic` saying nothing when the editor refused it, and a
 * draft that already had such a stop opening locked.
 */

/** Ten seconds of video, and nothing else. */
const post = (): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('v', 10_000)] });

/** A looping four-second section of a thirty-second track, heard from 0 to 6 s. */
function withMusic(over: Partial<EditMusic> = {}): EditManifest {
  return applyEditOps(post(), [{ op: 'setMusic', music: { uri: 'file:///song.m4a', sourceDurationMs: 30_000, outMs: 4000, loop: true, endMs: 6000, ...over } }]);
}

const set = (music: Record<string, unknown>): EditOp[] => [{ op: 'setMusic', music: { uri: 'file:///song.m4a', ...music } }];
const patch = (fields: Record<string, unknown>): EditOp[] => [{ op: 'patchMusic', patch: fields }];

describe('setMusic', () => {
  it('refuses a stop at or before the start, naming both', () => {
    for (const endMs of [1000, 2000, 2000 + MIN_LAYER_MS - 1]) {
      expect(() => applyEditOps(post(), set({ startMs: 2000, endMs, loop: true }))).toThrow(
        new RegExp(
          `op 0 \\(setMusic\\): the sound would stop at "endMs" ${endMs}, and "endMs" must be 0 \\(until the end\\) or at least ${MIN_LAYER_MS}ms after "startMs", which is 2000`,
        ),
      );
    }
  });

  it('takes a stop the shortest length after the start, and 0 for until the end', () => {
    expect(applyEditOps(post(), set({ startMs: 2000, endMs: 2000 + MIN_LAYER_MS })).music?.endMs).toBe(2000 + MIN_LAYER_MS);
    expect(applyEditOps(post(), set({ startMs: 2000, endMs: 0 })).music?.endMs).toBe(0);
  });

  it('refuses a section that ends at or too soon after its start, naming both', () => {
    expect(() => applyEditOps(post(), set({ inMs: 5000, outMs: 5050 }))).toThrow(
      /"outMs" 5050, and "outMs" must be 0 \(to the end of the track\) or at least 100ms after "inMs", which is 5000/,
    );
    expect(() => applyEditOps(post(), set({ inMs: 5000, outMs: 3000 }))).toThrow(/"outMs" 3000/);
    expect(applyEditOps(post(), set({ inMs: 5000, outMs: 0 })).music?.outMs).toBe(0);
  });

  it('takes both fades up to the longest the volume sheet sets, and leaves a fade in of 0 off the sound', () => {
    const music = applyEditOps(post(), set({ fadeInMs: 1500, fadeOutMs: MAX_MUSIC_FADE_MS })).music;
    expect(music).toMatchObject({ fadeInMs: 1500, fadeOutMs: MAX_MUSIC_FADE_MS });
    // As the editor's picker and the manifest's reader both have it: absent is no fade in.
    expect('fadeInMs' in applyEditOps(post(), set({ fadeInMs: 0 })).music!).toBe(false);
    expect('fadeInMs' in applyEditOps(post(), set({})).music!).toBe(false);
  });

  it('refuses a fade that is negative, longer than the volume sheet sets, or not a number', () => {
    expect(() => applyEditOps(post(), set({ fadeOutMs: -1 }))).toThrow(/"music\.fadeOutMs" must be a length in milliseconds from 0 \(no fade\) to 10000/);
    expect(() => applyEditOps(post(), set({ fadeInMs: MAX_MUSIC_FADE_MS + 1 }))).toThrow(/"music\.fadeInMs"/);
    expect(() => applyEditOps(post(), set({ fadeInMs: '2s' }))).toThrow(/"music\.fadeInMs"/);
  });

  it('refuses a volume outside 0..1, a negative time and a field a sound does not have', () => {
    expect(() => applyEditOps(post(), set({ volume: 3 }))).toThrow(/"music\.volume" must be a number from 0 to 1/);
    expect(() => applyEditOps(post(), set({ startMs: -500 }))).toThrow(/"music\.startMs" must be a number of milliseconds, 0 or more/);
    expect(() => applyEditOps(post(), set({ loop: 'yes' }))).toThrow(/"music\.loop" must be true or false/);
    // Misspelt, it used to be dropped without a word and the sound came out with no fade.
    expect(() => applyEditOps(post(), set({ fadeOut: 2000 }))).toThrow(/"music\.fadeOut" is not a music field - the fields are uri, fileName, .*fadeInMs, fadeOutMs/);
    expect(() => applyEditOps(post(), [{ op: 'setMusic', music: { startMs: 0 } }])).toThrow(/"music\.uri" must be a non-empty string/);
  });

  /*
   * Every field a sound has, sent at once, and stored as sent. The compiler already keeps the op's
   * list of fields in step with EditMusic; this is the same promise seen from the agent's side.
   */
  it('takes every field a sound has', () => {
    const music: Required<EditMusic> = {
      uri: 'file:///song.m4a',
      fileName: 'Song',
      sourceDurationMs: 30_000,
      inMs: 1000,
      outMs: 9000,
      startMs: 500,
      endMs: 7500,
      volume: 0.4,
      loop: true,
      phaseMs: 2500,
      fadeInMs: 800,
      fadeOutMs: 1200,
      speed: 1.5,
    };
    expect(applyEditOps(post(), [{ op: 'setMusic', music }]).music).toEqual(music);
    const before = applyEditOps(post(), set({ sourceDurationMs: 60_000 }));
    expect(applyEditOps(before, patch(music)).music).toEqual(music);
  });

  it('reads a null field as its default, as it reads an absent one', () => {
    const music = applyEditOps(post(), set({ endMs: null, fileName: null, fadeInMs: null })).music;
    expect(music).toMatchObject({ endMs: 0, fileName: '' });
    expect('fadeInMs' in music!).toBe(false);
  });

  it('accepts a signed phase and treats zero as the absent default', () => {
    const before = withMusic();
    expect(applyEditOps(before, patch({ phaseMs: 0 }))).toBe(before);
    expect(applyEditOps(before, patch({ phaseMs: -5000 })).music?.phaseMs).toBe(-5000);
  });

  /*
   * A null is a sound's own field left at its default, and nothing more: a key a sound does not have
   * is refused whatever it is sent with. Nulls used to be dropped before the names were read, so
   * `fadeOut: null` - `fadeOutMs` misspelt - was taken without a word while `fadeOut: 2000` was
   * refused, and the agent was told a field went in that no sound has.
   */
  it('refuses a field a sound does not have even when it is sent as null', () => {
    expect(() => applyEditOps(post(), set({ fadeOut: null }))).toThrow(/"music\.fadeOut" is not a music field - the fields are uri, fileName, /);
    expect(() => applyEditOps(post(), set({ endMs: null, zooms: null }))).toThrow(/"music\.zooms" is not a music field/);
  });
});

describe('patchMusic', () => {
  it('moves the sound with a new start, carrying its stop along as the editor’s Move does', () => {
    const before = withMusic();
    const next = applyEditOps(before, patch({ startMs: 2000 }));
    expect(next.music).toMatchObject({ startMs: 2000, endMs: 8000 });
    // The editor's own path: Start here and the timeline drag commit musicMovedTo through patchMusic.
    expect(next).toEqual(patchMusic(before, musicMovedTo(before.music!, 2000, totalDurationMs(before))));
  });

  it('moves a start past the stop, where it used to be refused without a word', () => {
    const next = applyEditOps(withMusic({ startMs: 0, endMs: 8000 }), patch({ startMs: 9000 }));
    // Carried to 17 s, past the end of the post, which is "until the end" again.
    expect(next.music).toMatchObject({ startMs: 9000, endMs: 0 });
  });

  it('puts the stop where it is told when the patch names one', () => {
    expect(applyEditOps(withMusic(), patch({ startMs: 2000, endMs: 5000 })).music).toMatchObject({ startMs: 2000, endMs: 5000 });
    expect(applyEditOps(withMusic(), patch({ startMs: 2000, endMs: 0 })).music).toMatchObject({ startMs: 2000, endMs: 0 });
  });

  it('moves a sound with no stop and leaves it without one', () => {
    expect(applyEditOps(withMusic({ endMs: 0 }), patch({ startMs: 3000 })).music).toMatchObject({ startMs: 3000, endMs: 0 });
  });

  it('refuses a stop the editor would not keep, naming both, rather than reporting success', () => {
    const before = withMusic({ startMs: 5000, endMs: 0 });
    expect(() => applyEditOps(before, patch({ endMs: 3000 }))).toThrow(
      /op 0 \(patchMusic\): the sound would stop at "endMs" 3000, and "endMs" must be 0 \(until the end\) or at least 100ms after "startMs", which is 5000/,
    );
    expect(() => applyEditOps(before, patch({ startMs: 4000, endMs: 4050 }))).toThrow(/"endMs" 4050.*"startMs", which is 4000/);
  });

  it('refuses a section the editor would not keep, naming both', () => {
    expect(() => applyEditOps(withMusic({ inMs: 1000, outMs: 5000 }), patch({ outMs: 1050 }))).toThrow(/"outMs" 1050, .* after "inMs", which is 1000/);
    expect(() => applyEditOps(withMusic({ inMs: 1000, outMs: 5000 }), patch({ inMs: 4950 }))).toThrow(/"outMs" 5000, .* after "inMs", which is 4950/);
  });

  /*
   * The words above are this layer's; the refusal is the editor's. If `patchMusic` ever takes one of
   * these, the op would be refusing an edit the editor allows - so each is checked against it here.
   */
  it('refuses only what the editor itself refuses', () => {
    const cases: [Partial<EditMusic>, Partial<EditMusic>][] = [
      [{ startMs: 5000, endMs: 0 }, { endMs: 3000 }],
      [{ startMs: 5000, endMs: 0 }, { endMs: 5000 + MIN_LAYER_MS - 1 }],
      [{ inMs: 1000, outMs: 5000 }, { outMs: 1000 + MIN_LAYER_MS - 1 }],
    ];
    for (const [music, fields] of cases) {
      const before = withMusic(music);
      expect(patchMusic(before, fields)).toBe(before);
      expect(() => applyEditOps(before, patch(fields as Record<string, unknown>))).toThrow(/must be 0/);
    }
    const before = withMusic({ startMs: 5000, endMs: 0 });
    expect(patchMusic(before, { endMs: 5000 + MIN_LAYER_MS })).not.toBe(before);
    expect(applyEditOps(before, patch({ endMs: 5000 + MIN_LAYER_MS })).music?.endMs).toBe(5000 + MIN_LAYER_MS);
  });

  it('answers a patch that asks for nothing new with the post as it was, and no error', () => {
    const before = withMusic({ volume: 0.5 });
    expect(applyEditOps(before, patch({ volume: 0.5 }))).toBe(before);
    // A start it already has, to the millisecond the editor keeps.
    expect(applyEditOps(before, patch({ startMs: 0.3 }))).toBe(before);
  });

  it('sets and takes away both fades, and refuses one past the longest the volume sheet sets', () => {
    let m = applyEditOps(withMusic(), patch({ fadeInMs: 1500, fadeOutMs: 2500 }));
    expect(m.music).toMatchObject({ fadeInMs: 1500, fadeOutMs: 2500 });
    m = applyEditOps(m, patch({ fadeInMs: 0, fadeOutMs: 0 }));
    expect(m.music).toMatchObject({ fadeInMs: 0, fadeOutMs: 0 });
    expect(() => applyEditOps(m, patch({ fadeOutMs: MAX_MUSIC_FADE_MS + 1 }))).toThrow(/"patch\.fadeOutMs" must be a length in milliseconds from 0 \(no fade\) to 10000/);
    expect(() => applyEditOps(m, patch({ fadeInMs: -100 }))).toThrow(/"patch\.fadeInMs"/);
  });

  it('refuses a field a sound does not have, and a null, rather than storing it', () => {
    expect(() => applyEditOps(withMusic(), patch({ fadeOut: 2000 }))).toThrow(/"patch\.fadeOut" is not a music field/);
    expect(() => applyEditOps(withMusic(), patch({ volume: 0.5, zooms: [] }))).toThrow(/"patch\.zooms" is not a music field/);
    expect(() => applyEditOps(withMusic(), patch({ endMs: null }))).toThrow(/"patch\.endMs" must be a number of milliseconds, 0 or more \(0: until the end\)/);
  });

  it('refuses a patch on a post with no music', () => {
    expect(() => applyEditOps(post(), patch({ volume: 0.5 }))).toThrow(/no music to patch - use setMusic first/);
  });
});

describe('through manifest_edit', () => {
  function tool(tools: ToolDefinition[], name: string): ToolDefinition {
    return tools.find(candidate => candidate.name === name)!;
  }

  it('leaves the stored post as it was when the editor would not keep the stop', () => {
    const tools = createTools();
    const edit = tool(tools, 'manifest_edit');
    const first = edit.run({ manifest: withMusic({ startMs: 5000, endMs: 0 }), ops: patch({ volume: 0.4 }) });
    const id = (first.structuredContent as { manifestId: string }).manifestId;
    expect(() => edit.run({ manifestId: id, ops: patch({ endMs: 3000 }) })).toThrow(/"endMs" 3000.*"startMs", which is 5000/);
    const after = tool(tools, 'manifest_inspect').run({ manifestId: id }).structuredContent as { manifest: EditManifest };
    expect(after.manifest.music).toMatchObject({ startMs: 5000, endMs: 0, volume: 0.4 });
  });
});

describe('what an agent reads about the music', () => {
  it('says where the sound is heard, which is what its fields add up to', () => {
    expect(summariseManifest(withMusic())).toContain('stopping at 6000ms (0:06.0), 100%, looped; heard 0ms..6000ms (0:06.0)');
    // Played once, it ends with its section, whatever the stop says.
    expect(summariseManifest(withMusic({ loop: false, endMs: 9000 }))).toContain('heard 0ms..4000ms (0:04.0)');
    // A stop past the end of the post is the end of the post.
    expect(summariseManifest(withMusic({ endMs: 0 }))).toContain('heard 0ms..10000ms (0:10.0)');
    expect(summariseManifest(withMusic({ startMs: 12_000, endMs: 0 }))).toContain('never heard: it starts at or after the end of the post');
  });

  /*
   * A bare `{uri}`: played once, and no length for it anywhere. The render plays it to the end of
   * the file, which only the engine reads, so a window running to the end of the post would be a
   * guess passed off as the render's answer - a three-second track read as ten seconds of music.
   */
  it('says only how long the sound may be heard when the length of a track played once is not known', () => {
    const summary = summariseManifest(applyEditOps(post(), set({})));
    expect(summary).toContain('from 0ms, at 0ms on the post, 100%; heard from 0ms until the track ends, 10000ms (0:10.0) at most');
    expect(summary).toContain('its length is unknown (send sourceDurationMs or outMs to know)');
    expect(summary).not.toContain('heard 0ms..');
    // Its stop is still the furthest it can go.
    expect(summariseManifest(applyEditOps(post(), set({ startMs: 1000, endMs: 4000 })))).toContain('heard from 1000ms (0:01.0) until the track ends, 4000ms (0:04.0) at most');
    // Either length makes it an answer again.
    expect(summariseManifest(applyEditOps(post(), set({ sourceDurationMs: 3000 })))).toContain('heard 0ms..3000ms (0:03.0)');
    expect(summariseManifest(applyEditOps(post(), set({ inMs: 1000, outMs: 3000 })))).toContain('heard 0ms..2000ms (0:02.0)');
    // Looped, its length does not matter: it repeats until its stop, or the end of the post.
    expect(summariseManifest(applyEditOps(post(), set({ loop: true })))).toContain('looped; heard 0ms..10000ms (0:10.0)');
  });

  it('says both fades', () => {
    const summary = summariseManifest(applyEditOps(withMusic(), patch({ fadeInMs: 1500, fadeOutMs: 2500 })));
    expect(summary).toContain('fades in over 1500ms (0:01.5), fades out over 2500ms (0:02.5)');
  });

  it('is told in the op reference about the stop, the fades and the move', () => {
    expect(OP_REFERENCE['setMusic']).toMatch(/endMs where it stops \(0, the default: until the end\)/);
    expect(OP_REFERENCE['setMusic']).toMatch(new RegExp(`at least ${MIN_LAYER_MS}ms after inMs or startMs`));
    expect(OP_REFERENCE['setMusic']).toMatch(new RegExp(`fadeInMs.*fadeOutMs.*0 \\(none, the default\\) to ${MAX_MUSIC_FADE_MS}ms`));
    expect(OP_REFERENCE['patchMusic']).toMatch(/A startMs without an endMs MOVES the sound/);
    expect(OP_REFERENCE['patchMusic']).toMatch(/refused, not ignored/);
  });

  it('is told in the op reference what each op refuses, and what a null is', () => {
    expect(OP_REFERENCE['setMusic']).toMatch(/Any other field is refused; a field sent as null takes its default\./);
    expect(OP_REFERENCE['patchMusic']).toMatch(/any other field is refused, and so is null - send 0 for no stop/);
    expect(OP_REFERENCE['setMusic']).toMatch(/sourceDurationMs is the track's length/);
  });

  it('finds the fade limits in the catalogue', () => {
    const limits = createTools()
      .find(candidate => candidate.name === 'catalog_list')!
      .run({ section: 'limits' });
    expect((limits.structuredContent as { limits: Record<string, unknown> }).limits['musicFadeMs']).toEqual({ min: 0, max: MAX_MUSIC_FADE_MS });
    expect(limits.content[0]?.text).toContain(`fade in and fade out run 0 (none) to ${MAX_MUSIC_FADE_MS}ms each`);
  });
});

describe('a draft that already has a stop the editor would not keep', () => {
  /*
   * Written by an older build of this server, or by hand. Read as it was, it opened with a sound
   * nobody could hear and no control on the music that did anything; read now, the stop is gone and
   * the sound plays until the end, and every control works on it again.
   */
  it('is opened with the stop cleared, so the music can be heard and changed', () => {
    const draft = JSON.parse(JSON.stringify(withMusic({ endMs: 0 })));
    draft.music.startMs = 2000;
    draft.music.endMs = 1000;
    const tools = createTools();
    const result = tools.find(candidate => candidate.name === 'manifest_validate')!.run({ manifest: draft });
    const manifest = (result.structuredContent as { manifest: EditManifest }).manifest;
    expect(manifest.music).toMatchObject({ startMs: 2000, endMs: 0 });
    expect(result.content[0]?.text).toMatch(/changed on the way in/);
    expect(applyEditOps(manifest, patch({ volume: 0.3 })).music?.volume).toBe(0.3);
    // The same draft read by the editor's own reader, which is what the tools call.
    expect(normaliseManifest(draft).music?.endMs).toBe(0);
  });
});
