import { describe, expect, it } from 'vitest';

import { filePickerCancelled } from './file-picker';

/** A rejection as Capacitor's bridge delivers one: an `Error` with the plugin's message and, here, no code. */
function rejected(message: string): Error {
  return Object.assign(new Error(message), { code: undefined });
}

describe('filePickerCancelled', () => {
  it('is true for the cancel every pick call rejects with, on every platform', () => {
    // iOS and Android through the bridge, for pickFiles, pickVideos, pickImages and pickMedia alike.
    expect(filePickerCancelled(rejected('pickFiles canceled.'))).toBe(true);
    // The web implementation's own `throw new Error(...)`.
    expect(filePickerCancelled(new Error('pickFiles canceled.'))).toBe(true);
    // And a plain object with the message on it, as a test's stand-in or another bridge might send.
    expect(filePickerCancelled({ message: 'pickFiles canceled.' })).toBe(true);
  });

  it('is true for the directory picker\'s cancel', () => {
    expect(filePickerCancelled(rejected('pickDirectory canceled.'))).toBe(true);
  });

  /* A cancel that swallowed these would make a failed pick look like a button that does nothing. */
  it('is false for every failure, the ones that say "cancel" included', () => {
    expect(filePickerCancelled(rejected('pickFiles failed.'))).toBe(false);
    expect(filePickerCancelled(rejected('An unknown error occurred while creating a temporary copy of the file.'))).toBe(false);
    // What the iOS photo picker passes through from an item provider: the system's own sentence.
    expect(filePickerCancelled(rejected('The operation was cancelled.'))).toBe(false);
    expect(filePickerCancelled(rejected('Canceled'))).toBe(false);
    expect(filePickerCancelled(rejected('pickFiles canceled'))).toBe(false);
  });

  it('is false for anything that is not a rejection with a message', () => {
    expect(filePickerCancelled(undefined)).toBe(false);
    expect(filePickerCancelled(null)).toBe(false);
    expect(filePickerCancelled('pickFiles canceled.')).toBe(false);
    expect(filePickerCancelled({ message: 42 })).toBe(false);
  });
});
