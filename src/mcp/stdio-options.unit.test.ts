import { describe, expect, it } from 'vitest';

import { NO_ZOOM_FLAG, StdioUsageError, ZOOM_ENV, readStdioOptions } from './stdio-options';

/*
 * The stdio process's switch. What matters is the two ways a switch goes wrong: one that is thrown
 * and not taken, and one that is mistyped and taken as nothing at all. The second is why anything
 * unrecognised stops the process rather than being skipped.
 */
describe('readStdioOptions', () => {
  it('leaves Zoom on, and the startup line as it was, when nothing is said', () => {
    expect(readStdioOptions([], {})).toEqual({ editing: { zoom: true }, note: '' });
  });

  it('turns Zoom off for --no-zoom, and says so on the startup line', () => {
    const options = readStdioOptions([NO_ZOOM_FLAG], {});
    expect(options.editing).toEqual({ zoom: false });
    expect(options.note).toContain('Zoom off (--no-zoom)');
    expect(options.note).toContain('no zoom op, and no manifest holding a zoom, is taken');
  });

  it('takes the flag twice as once', () => {
    expect(readStdioOptions([NO_ZOOM_FLAG, NO_ZOOM_FLAG], {}).note).toBe(readStdioOptions([NO_ZOOM_FLAG], {}).note);
  });

  it('turns Zoom off from the environment, for a client that cannot pass arguments', () => {
    for (const value of ['0', 'false', 'OFF', ' no ']) {
      const options = readStdioOptions([], { [ZOOM_ENV]: value });
      expect(options.editing.zoom).toBe(false);
      expect(options.note).toContain(ZOOM_ENV);
    }
  });

  it('leaves Zoom on for an environment that says on, or says nothing', () => {
    for (const value of ['1', 'true', 'on', 'yes', '', '  ', undefined]) {
      expect(readStdioOptions([], { [ZOOM_ENV]: value }).editing.zoom).toBe(true);
    }
  });

  /* On is the default, so the only thing either place can usefully say is off. */
  it('is off when either one says off, whatever the other says', () => {
    expect(readStdioOptions([NO_ZOOM_FLAG], { [ZOOM_ENV]: '1' }).editing.zoom).toBe(false);
    const both = readStdioOptions([NO_ZOOM_FLAG], { [ZOOM_ENV]: '0' });
    expect(both.editing.zoom).toBe(false);
    expect(both.note).toContain(NO_ZOOM_FLAG);
    expect(both.note).toContain(`${ZOOM_ENV}=0`);
  });

  /*
   * Each of these, skipped, would start the server with Zoom ON for a host that asked for it off,
   * and nothing would say so until an agent put a zoom in a post.
   */
  it('refuses to start on an argument it does not know, naming it and the one it does', () => {
    for (const arg of ['--no-zooms', '--nozoom', '--zoom=false', '-z', 'no-zoom', '--help']) {
      expect(() => readStdioOptions([arg], {})).toThrow(StdioUsageError);
      expect(() => readStdioOptions([arg], {})).toThrow(new RegExp(`"${arg}".*${NO_ZOOM_FLAG}`));
    }
    expect(() => readStdioOptions([NO_ZOOM_FLAG, '--verbose'], {})).toThrow(/"--verbose"/);
  });

  it('refuses a value in the environment that is neither on nor off', () => {
    expect(() => readStdioOptions([], { [ZOOM_ENV]: 'disabled' })).toThrow(StdioUsageError);
    expect(() => readStdioOptions([], { [ZOOM_ENV]: 'disabled' })).toThrow(/"disabled" is neither off/);
  });
});
