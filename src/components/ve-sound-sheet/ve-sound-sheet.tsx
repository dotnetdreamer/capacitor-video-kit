import { signal } from '@preact/signals-core';
import { Component, Host, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { debugWarn } from '../../host/debug';
import type { SavedSound } from '../../host/host.types';

/**
 * How long a bin tap waits to be confirmed before the row goes back to normal. Long enough to move
 * a thumb across the row, short enough that a sheet left open does not keep a live delete on it.
 */
const CONFIRM_DELETE_MS = 4000;

/**
 * The Sound sheet: where a track comes from.
 *
 * Two ways in and a list of what came in before. "Extract from video" is the one this sheet exists
 * for - pick any video, the sound is pulled out of it, kept, and put on the post - and because it is
 * kept, the same sound is one tap away in every edit after this one. "From files" is the picker the
 * Sound menu used to open directly, unchanged.
 *
 * Tapping a saved sound uses it and closes the sheet, which is the same gesture the sticker sheet
 * has: the sound lands on the timeline and the customer's eyes are already going there.
 *
 * The library itself belongs to the host - see [EditorSoundLibrary] - and this sheet only ever asks
 * it three things. A host with no library never opens this sheet at all: `media.openSound()` sends
 * it straight to the file picker instead, because a sheet whose only content is one button is worse
 * than the button.
 *
 * The preview player is this element's own. It is an `<audio>` rather than anything the editor's
 * preview owns, because what is being listened to here is not on the post yet and must not be mixed
 * into it - and the video is paused while it plays, so the two are never heard at once.
 */
@Component({
  tag: 've-sound-sheet',
  styleUrls: ['../sheet-common.css', 've-sound-sheet.css'],
  shadow: true,
})
export class VeSoundSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  /** The sound being listened to, by id, or null when nothing is playing. */
  private readonly previewId = signal<string | null>(null);

  /** The row whose bin has been tapped once and is waiting to be tapped again. */
  private readonly confirmingId = signal<string | null>(null);

  private player: HTMLAudioElement | null = null;
  private confirmTimer = 0;

  connectedCallback() {
    // The sheet is about to be listened to, and a video running under it is in the way.
    this.ctx.store.pause();
    // Every opening, not just the first: an extraction started from a previous opening may have
    // landed since, and this element is built fresh each time the panel opens.
    void this.ctx.media.loadSounds();
  }

  disconnectedCallback() {
    this.stopPreview();
    this.clearConfirm();
    this.watcher.stop();
  }

  /* ========================================================================================= */
  /* Actions                                                                                   */
  /* ========================================================================================= */

  /*
   * One stable function each rather than a fresh arrow per render, or the vdom takes every listener
   * off and puts it back on each repaint - and this sheet repaints on every row that starts playing.
   */
  private readonly close = () => {
    this.ctx.store.closePanel();
  };

  private readonly extract = () => {
    this.clearConfirm();
    this.stopPreview();
    // The picker and the extraction both outlive this element, and `EditorMedia` owns them both.
    void this.closeIfLanded(this.ctx.media.extractSound());
  };

  private readonly fromFiles = () => {
    this.clearConfirm();
    this.stopPreview();
    void this.closeIfLanded(this.ctx.media.pickMusic());
  };

  /**
   * Closes the sheet once a track has actually landed on the post, the way tapping a saved sound
   * does - and leaves it open otherwise.
   *
   * The test is what the post's music IS rather than what the call answered, because every way
   * these two can end without a track looks the same from here: a closed picker, a silent video, a
   * file that would not open. A customer who backed out of the picker meant to stay in this sheet,
   * and closing it under them would make Cancel read as "throw the whole thing away".
   */
  private async closeIfLanded(work: Promise<unknown>): Promise<void> {
    const before = this.ctx.store.manifest.value.music;
    await work;
    // The panel may have been closed meanwhile - the back button takes it - and closing then would
    // take away whatever the customer opened next.
    if (this.ctx.store.panel.value !== 'sound') return;
    if (this.ctx.store.manifest.value.music !== before) this.close();
  }

  private use(sound: SavedSound): void {
    this.stopPreview();
    this.ctx.media.useSound(sound);
    this.close();
  }

  /**
   * The bin, tapped twice. A sound is the one thing in this editor that outlives the edit, so a
   * delete here cannot be undone by the undo stack the way every other delete can - and the sheet
   * has nowhere to put a system alert from inside its own shadow root. So the row asks for itself:
   * the first tap turns the bin into the word, and the word is what deletes.
   *
   * Not called `remove`, which would replace `Element.remove` on the element this class becomes in
   * the custom elements build - the package has a test that fails on exactly that.
   */
  private deleteSound(id: string): void {
    if (this.confirmingId.value !== id) {
      this.clearConfirm();
      this.confirmingId.value = id;
      this.confirmTimer = window.setTimeout(() => this.clearConfirm(), CONFIRM_DELETE_MS);
      this.ctx.store.haptic('selection');
      return;
    }
    this.clearConfirm();
    if (this.previewId.value === id) this.stopPreview();
    void this.ctx.media.removeSound(id);
    this.ctx.store.haptic('light');
  }

  private clearConfirm(): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = 0;
    this.confirmingId.value = null;
  }

  /* ========================================================================================= */
  /* Preview                                                                                   */
  /* ========================================================================================= */

  /**
   * Plays a sound, or stops the one already playing when it is tapped again.
   *
   * One element for the whole sheet rather than one per row: a WebView will happily open a decoder
   * per `<audio>` and never give one back, and there is only ever one thing being listened to.
   */
  private togglePreview(sound: SavedSound): void {
    if (this.previewId.value === sound.id) {
      this.stopPreview();
      return;
    }
    this.ctx.store.pause();
    const player = this.player ?? new Audio();
    this.player = player;
    player.onended = () => {
      this.previewId.value = null;
    };
    player.src = this.ctx.store.host.platform.fileUrl(sound.uri);
    this.previewId.value = sound.id;
    player.play().catch((error: unknown) => {
      // A file the WebView will not play, or a gesture the browser did not count as one. Either
      // way the button has to come back off, or it sits there claiming to be playing.
      debugWarn('[VeSoundSheet] preview failed', sound.id, error);
      this.previewId.value = null;
      this.ctx.store.showToast("That sound can't be played");
    });
  }

  private stopPreview(): void {
    const player = this.player;
    this.previewId.value = null;
    if (!player) return;
    player.pause();
    player.onended = null;
    // Emptied rather than left pointing at the file: a paused `<audio>` holds its decoder and its
    // buffer for as long as it has a source.
    player.removeAttribute('src');
    player.load();
  }

  /* ========================================================================================= */
  /* Render                                                                                    */
  /* ========================================================================================= */

  private renderRow(sound: SavedSound, inUse: boolean) {
    const playing = this.previewId.value === sound.id;
    const confirming = this.confirmingId.value === sound.id;
    return (
      <li class="snd__row" key={sound.id}>
        <button
          type="button"
          class="snd__play"
          aria-label={playing ? `Stop ${sound.fileName}` : `Play ${sound.fileName}`}
          aria-pressed={String(playing)}
          onClick={() => this.togglePreview(sound)}
        >
          <ve-icon name={playing ? 'pause' : 'play'}></ve-icon>
        </button>

        <button type="button" class="snd__pick" onClick={() => this.use(sound)}>
          <span class="snd__name">{sound.fileName}</span>
          <span class="snd__meta">{meta(sound)}</span>
        </button>

        {inUse ? (
          <span class="snd__in-use" key="in-use" aria-label="On this post">
            <ve-icon name="checkmark"></ve-icon>
          </span>
        ) : null}

        {/*
          One button that changes what it is, keyed so the vdom swaps the element rather than
          patching a bin into a word and leaving the icon's `aria-label` on it.
        */}
        {confirming ? (
          <button type="button" class="snd__confirm" key="confirm" onClick={() => this.deleteSound(sound.id)}>
            Delete
          </button>
        ) : (
          <button
            type="button"
            class="snd__bin"
            key="bin"
            aria-label={`Delete ${sound.fileName}`}
            onClick={() => this.deleteSound(sound.id)}
          >
            <ve-icon name="trash-outline"></ve-icon>
          </button>
        )}
      </li>
    );
  }

  render() {
    return this.watcher.run(() => {
      const { store, media } = this.ctx;
      const sounds = media.sounds.value;
      const extracting = media.extracting.value;
      const busy = media.busy.value;
      const loaded = media.soundsLoaded.value;
      const usedUri = store.manifest.value.music?.uri ?? null;

      return (
        <Host>
          <ve-sheet class="snd__frame" heading="Sound" onVeConfirm={this.close}>
            <div class="snd__content">
              <div class="snd__actions">
                <button type="button" class="snd__action" disabled={busy} onClick={this.extract}>
                  {extracting ? (
                    <ve-spinner class="snd__action-icon" key="spinner" label="Taking the sound out"></ve-spinner>
                  ) : (
                    <ve-icon class="snd__action-icon" name="arrow-down-circle-outline" key="icon"></ve-icon>
                  )}
                  <span class="snd__action-text">
                    <span class="snd__action-title">{extracting ? 'Taking the sound out…' : 'Extract from video'}</span>
                    <span class="snd__action-hint">
                      {extracting ? 'This can take a moment on a long video' : 'Pick a video and keep its sound'}
                    </span>
                  </span>
                </button>

                <button type="button" class="snd__action" disabled={busy} onClick={this.fromFiles}>
                  <ve-icon class="snd__action-icon" name="musical-note-outline"></ve-icon>
                  <span class="snd__action-text">
                    <span class="snd__action-title">From files</span>
                    <span class="snd__action-hint">A track already on this phone</span>
                  </span>
                </button>
              </div>

              <p class="snd__heading">Saved sounds</p>

              {/*
                Three states, and each is a different element, so all three are keyed: an unkeyed
                list appearing where a sentence was would be matched against it by position.
              */}
              {sounds.length > 0 ? (
                <ul class="snd__list" key="list">
                  {sounds.map(sound => this.renderRow(sound, !!usedUri && sound.uri === usedUri))}
                </ul>
              ) : loaded ? (
                <div class="snd__empty" key="empty">
                  <ve-icon name="musical-notes-outline"></ve-icon>
                  <p>Sounds you take out of a video are kept here, ready for your next post.</p>
                </div>
              ) : (
                <div class="snd__empty" key="loading">
                  <ve-spinner label="Loading your sounds"></ve-spinner>
                </div>
              )}
            </div>
          </ve-sheet>
        </Host>
      );
    });
  }
}

/* ------------------------------------------------------------------------------------------- */

/** `1:23 · today`, or just the date for a track whose length could not be read. */
function meta(sound: SavedSound): string {
  const when = savedWhen(sound.savedAt);
  return sound.durationMs > 0 ? `${clock(sound.durationMs)} · ${when}` : when;
}

/** `1:23`, minutes and seconds, rounded down the way every other clock in the editor is. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * When it was saved, in the roughest terms that still tell two sounds apart.
 *
 * Days rather than a date, because the list is ordered by this and what the customer is reading it
 * for is "the one I did just now" against "the one from before". A date is shown once the days stop
 * meaning anything, and it is the locale's own so it reads right wherever the app is.
 */
function savedWhen(savedAt: number): string {
  const days = Math.floor((Date.now() - savedAt) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return 'Today';
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  try {
    return new Date(savedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch {
    return 'Earlier';
  }
}
