import { effect } from '@preact/signals-core';
import { describe, expect, it, vi } from 'vitest';

import type { ConfirmRequest } from '../../host/host.types';
import { DISCARD_EDITS, EditorConfirm, renderFailed } from './editor-confirm';

/** The shell's own question, shortened, so a test reads as one thing being asked. */
const ASK: ConfirmRequest = {
  header: 'Discard edits?',
  message: 'Your clips stay.',
  buttons: [
    { text: 'Keep editing', role: 'cancel' },
    { text: 'Discard', role: 'destructive' },
  ],
};

describe('EditorConfirm, with no host dialog', () => {
  it('puts the request on the screen and answers with what the alert sends back', async () => {
    const confirm = new EditorConfirm({ confirm: null });

    const asked = confirm.ask(ASK);
    expect(confirm.showing).toBe(ASK);
    expect(confirm.pending).toBe(true);

    confirm.settle('destructive');

    await expect(asked).resolves.toBe('destructive');
    expect(confirm.showing).toBe(null);
    expect(confirm.pending).toBe(false);
  });

  it('is a signal, so the shell repaints the alert into place without being told to', () => {
    const confirm = new EditorConfirm({ confirm: null });
    const seen: (string | null)[] = [];
    const stop = effect(() => {
      seen.push(confirm.showing?.header ?? null);
    });

    void confirm.ask(ASK);
    confirm.settle(null);
    stop();

    expect(seen).toEqual([null, 'Discard edits?', null]);
  });

  it('carries a dismissal through as null, which is how the back button and the backdrop answer', async () => {
    const confirm = new EditorConfirm({ confirm: null });

    const asked = confirm.ask(ASK);
    confirm.settle(null);

    await expect(asked).resolves.toBe(null);
  });
});

describe('EditorConfirm, with a host dialog', () => {
  it('asks the host and never puts an alert of its own on the screen', async () => {
    const native = vi.fn(async () => 'destructive');
    const confirm = new EditorConfirm({ confirm: native });

    const asked = confirm.ask(ASK);
    expect(confirm.showing).toBe(null);
    // The one thing the back handler reads: something is being asked, and it is not ours to close.
    expect(confirm.pending).toBe(true);

    await expect(asked).resolves.toBe('destructive');
    expect(native).toHaveBeenCalledWith(ASK);
    expect(confirm.pending).toBe(false);
  });

  it('takes a rejected host dialog as a dismissal, or the customer could never leave the editor', async () => {
    const confirm = new EditorConfirm({ confirm: async () => Promise.reject(new Error('no controller')) });

    await expect(confirm.ask(ASK)).resolves.toBe(null);
    expect(confirm.pending).toBe(false);
  });

  it('takes one that throws where it stands the same way', async () => {
    const confirm = new EditorConfirm({
      confirm: () => {
        throw new Error('no controller');
      },
    });

    await expect(confirm.ask(ASK)).resolves.toBe(null);
    expect(confirm.pending).toBe(false);
  });
});

describe('EditorConfirm, while one question is open', () => {
  it('answers a second question null rather than replacing the first, which nothing could settle', async () => {
    const confirm = new EditorConfirm({ confirm: null });

    const first = confirm.ask(ASK);
    const second = confirm.ask(renderFailed('no_space'));

    await expect(second).resolves.toBe(null);
    expect(confirm.showing).toBe(ASK);

    confirm.settle('cancel');
    await expect(first).resolves.toBe('cancel');
  });

  it('answers whoever is waiting when the editor goes', async () => {
    const confirm = new EditorConfirm({ confirm: null });

    const asked = confirm.ask(ASK);
    confirm.dispose();

    await expect(asked).resolves.toBe(null);
    expect(confirm.showing).toBe(null);
  });

  it('settles at most once, so a late answer cannot contradict the one already acted on', async () => {
    const confirm = new EditorConfirm({ confirm: null });

    const asked = confirm.ask(ASK);
    confirm.settle('destructive');
    confirm.settle('cancel');

    await expect(asked).resolves.toBe('destructive');
  });
});

describe('the two questions the editor asks', () => {
  it('keeps the clips out of what Discard threatens', () => {
    expect(DISCARD_EDITS.message).toContain('Your clips stay');
    expect(DISCARD_EDITS.buttons.map(button => button.role)).toEqual(['cancel', 'destructive']);
  });

  it('says something different for each way a render can fail', () => {
    expect(renderFailed('no_space').message).toContain('not enough space');
    expect(renderFailed('unreadable_input').message).toContain('could not be read');
    expect(renderFailed('unknown').message).toContain('could not be built');

    for (const code of ['no_space', 'unreadable_input', 'unknown'] as const) {
      expect(renderFailed(code).message).toContain('You can try again, or post your clips without the edits.');
      expect(renderFailed(code).buttons.map(button => button.role)).toEqual(['plain', 'retry']);
    }
  });

  it('keeps the curly apostrophe the header is written with', () => {
    expect(renderFailed('unknown').header).toBe('Couldn’t build your video');
  });
});
