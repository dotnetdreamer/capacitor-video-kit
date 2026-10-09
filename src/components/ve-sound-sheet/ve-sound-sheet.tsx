import { signal } from '@preact/signals-core';
import { Component, Host, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { debugWarn } from '../../host/debug';
import type { CatalogueSound, SavedSound, SoundCategory } from '../../host/host.types';
import type { SheetTab } from '../sheet.types';

/**
 * How long a bin tap waits to be confirmed before the row goes back to normal. Long enough to move
 * a thumb across the row, short enough that a sheet left open does not keep a live delete on it.
 */
const CONFIRM_DELETE_MS = 4000;

/** The tab of the customer's own sounds. */
const SAVED_TAB = 'saved';
/**
 * A category's tab id is its id behind this, so a host whose catalogue has a category called
 * "saved" cannot collide with the tab of the customer's own sounds.
 */
const CATEGORY_TAB = 'category:';

/**
 * The Sound sheet: where a track comes from.
 *
 * Two ways in and a list of what came in before. "Extract from video" is the one this sheet exists
 * for - pick any video, the sound is pulled out of it, kept, and put on the post - and because it is
 * kept, the same sound is one tap away in every edit after this one. "From files" is the picker the
 * Sound menu used to open directly, unchanged.
 *
 * A host with a music library ([EditorSoundCatalogue]) adds a tab per category beside them, the
 * customer's own sounds first as Saved. A catalogue row is a track on the host's server, so choosing
 * one waits for the host to fetch it, with a spinner on its row; listening to one before choosing
 * plays the host's `previewUrl` and fetches nothing.
 *
 * Tapping a saved sound or a track uses it and closes the sheet, which is the same gesture the
 * sticker sheet has: the sound lands on the timeline and the customer's eyes are already going
 * there. A host whose library can hand a sound to the person ([EditorSoundLibrary.download]) gets a
 * download button on every saved row as well, which leaves the post and the sheet as they were.
 *
 * It is the one sheet with a grabber. It opens at the height every tall sheet has, and dragging its
 * head up pulls it to most of the screen, for a long list of tracks; dragging it down closes it. The
 * shell owns the heights (`SheetDragger`); this sheet only turns the grabber on.
 *
 * The library and the catalogue belong to the host, and this sheet only ever asks them for what it
 * shows. A host with neither never opens this sheet at all: `media.openSound()` sends it straight to
 * the file picker instead, because a sheet whose only content is one button is worse than the button.
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

  /**
   * What is being listened to, or null when nothing is playing: a saved sound's id behind `s:` or a
   * track's behind `t:`, so the two kinds of id can never answer for each other.
   */
  private readonly previewId = signal<string | null>(null);

  /** The row whose bin has been tapped once and is waiting to be tapped again. */
  private readonly confirmingId = signal<string | null>(null);

  private player: HTMLAudioElement | null = null;
  private confirmTimer = 0;

  connectedCallback() {
    // The sheet is about to be listened to, and a video running under it is in the way.
    this.ctx.store.pause();
    // Every opening, not just the first: an extraction started from a previous opening may have
    // landed since, and this element is built fresh each time the panel opens. The host keeps its
    // catalogue, so asking again costs it nothing.
    void this.ctx.media.loadSounds();
    void this.ctx.media.loadCatalogue();
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

  /** A tab, remembered for the rest of the edit so the sheet reopens where the customer left it. */
  private readonly onTab = (event: CustomEvent<string>) => {
    this.clearConfirm();
    this.stopPreview();
    this.ctx.media.soundTab.value = event.detail;
  };

  /**
   * Closes the sheet once a track has actually landed on the post, the way tapping a saved sound
   * does - and leaves it open otherwise.
   *
   * The test is what the post's sounds ARE rather than what the call answered, because every way
   * these can end without a track looks the same from here: a closed picker, a silent video, a
   * file that would not open, a track that would not download. A customer who backed out of the
   * picker meant to stay in this sheet, and closing it under them would make Cancel read as "throw
   * the whole thing away". Every way a track lands writes one of the two fields anew - a sound
   * added, one replaced, or an older edit's sound carried onto the lanes - and every way of ending
   * without one writes neither.
   */
  private async closeIfLanded(work: Promise<unknown>): Promise<void> {
    const before = this.ctx.store.manifest.value;
    await work;
    // The panel may have been closed meanwhile - the back button takes it - and closing then would
    // take away whatever the customer opened next.
    if (this.ctx.store.panel.value !== 'sound') return;
    const after = this.ctx.store.manifest.value;
    if (after.audioTracks !== before.audioTracks || after.music !== before.music) this.close();
  }

  private use(sound: SavedSound): void {
    this.stopPreview();
    this.ctx.media.useSound(sound);
    this.close();
  }

  /** A catalogue track: fetched by the host, then on the post, and the sheet closes once it is. */
  private useTrack(sound: CatalogueSound): void {
    this.clearConfirm();
    this.stopPreview();
    void this.closeIfLanded(this.ctx.media.useCatalogueSound(sound));
  }

  /**
   * Hands a copy of the sound to the person, through the host's library. The sheet stays open: the
   * post is not what changed, and the next thing may be another download.
   */
  private download(sound: SavedSound): void {
    this.clearConfirm();
    this.stopPreview();
    void this.ctx.media.downloadSound(sound);
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
    if (this.previewId.value === `s:${id}`) this.stopPreview();
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
   * Plays a sound or a track, or stops the one already playing when it is tapped again.
   *
   * One element for the whole sheet rather than one per row: a WebView will happily open a decoder
   * per `<audio>` and never give one back, and there is only ever one thing being listened to.
   */
  private togglePreview(key: string, uri: string, name: string): void {
    if (this.previewId.value === key) {
      this.stopPreview();
      return;
    }
    this.ctx.store.pause();
    const player = this.player ?? new Audio();
    this.player = player;
    player.onended = () => {
      this.previewId.value = null;
    };
    player.src = this.ctx.store.host.platform.fileUrl(uri);
    this.previewId.value = key;
    player.play().catch((error: unknown) => {
      // A file the WebView will not play, a track the network did not deliver, or a gesture the
      // browser did not count as one. Either way the button has to come back off, or it sits there
      // claiming to be playing.
      debugWarn('[VeSoundSheet] preview failed', name, error);
      if (this.previewId.value === key) this.previewId.value = null;
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

  private renderRow(sound: SavedSound, inUse: boolean, download: boolean, downloading: string | null) {
    const key = `s:${sound.id}`;
    const playing = this.previewId.value === key;
    const confirming = this.confirmingId.value === sound.id;
    return (
      <li class="snd__row" key={sound.id}>
        <button type="button" class="snd__play" aria-pressed={String(playing)} onClick={() => this.togglePreview(key, sound.uri, sound.fileName)}>
          <ve-icon name={playing ? 'pause' : 'play'}></ve-icon>
          {/*
            The name is the button's own hidden text and NOT an `aria-label`. With `aria-pressed`
            beside it, an `aria-label` reached Android's WebView as a ToggleButton with no text and
            no description: the label went to Android's supplemental description, so Maestro could
            not find "Play ...", and a screen reader that skips that field had nothing to read. See
            `.sheet__hidden-name` in sheet-common.css.
          */}
          <span class="sheet__hidden-name">{playing ? `Stop ${sound.fileName}` : `Play ${sound.fileName}`}</span>
        </button>

        <button type="button" class="snd__pick" onClick={() => this.use(sound)}>
          <span class="snd__name">{sound.fileName}</span>
          <span class="snd__meta">{meta(sound)}</span>
        </button>

        {/*
          An image, because the tick is a picture, and because ARIA does not allow a name on a span
          with no role. Android's WebView dropped that label: the tick reached the tree as a
          TextView with no text, and editor-sound-sheet.yaml could not find "On this post". An
          image's `aria-label` is its content description on Android and its label in VoiceOver.
        */}
        {inUse ? (
          <span class="snd__in-use" key="in-use" role="img" aria-label="On this post">
            <ve-icon name="checkmark"></ve-icon>
          </span>
        ) : null}

        {/*
          One button that changes what it is, keyed so the vdom swaps the element rather than
          patching a bin into a word and leaving the icon's `aria-label` on it. The download goes
          while the row asks about a delete, which is then the only question on it.
        */}
        {download && !confirming ? (
          <button
            type="button"
            class="snd__save"
            key="save"
            aria-label={`Download ${sound.fileName}`}
            disabled={downloading !== null}
            onClick={() => this.download(sound)}
          >
            {downloading === sound.id ? (
              <ve-spinner key="spinner" label={`Downloading ${sound.fileName}`}></ve-spinner>
            ) : (
              <ve-icon name="download-outline" key="icon"></ve-icon>
            )}
          </button>
        ) : null}

        {confirming ? (
          <button type="button" class="snd__confirm" key="confirm" onClick={() => this.deleteSound(sound.id)}>
            Delete
          </button>
        ) : (
          <button type="button" class="snd__bin" key="bin" aria-label={`Delete ${sound.fileName}`} onClick={() => this.deleteSound(sound.id)}>
            <ve-icon name="trash-outline"></ve-icon>
          </button>
        )}
      </li>
    );
  }

  /**
   * One catalogue track. Its picture, when the host has one, IS the play button, drawn round with
   * the icon on a dimmed disc over it, the way a music library shows a track.
   */
  private renderTrack(sound: CatalogueSound, inUse: boolean, fetching: string | null) {
    const key = `t:${sound.id}`;
    const playing = this.previewId.value === key;
    const art = sound.artworkUrl ? this.ctx.store.host.platform.fileUrl(sound.artworkUrl) : null;
    const info = trackMeta(sound);
    return (
      <li class="snd__row" key={sound.id}>
        <button
          type="button"
          class={{ 'snd__play': true, 'snd__art': !!art }}
          style={art ? { backgroundImage: `url(${JSON.stringify(art)})` } : undefined}
          aria-pressed={String(playing)}
          onClick={() => this.togglePreview(key, sound.previewUrl, sound.title)}
        >
          <ve-icon name={playing ? 'pause' : 'play'}></ve-icon>
          {/* Hidden text rather than an `aria-label`, for the reason [renderRow] gives. */}
          <span class="sheet__hidden-name">{playing ? `Stop ${sound.title}` : `Play ${sound.title}`}</span>
        </button>

        {/* Every row waits while one track is on its way: one fetch at a time, as one picker. */}
        <button type="button" class="snd__pick" disabled={fetching !== null} onClick={() => this.useTrack(sound)}>
          <span class="snd__name">{sound.title}</span>
          {info ? <span class="snd__meta">{info}</span> : null}
        </button>

        {fetching === sound.id ? (
          <span class="snd__fetching" key="fetching">
            <ve-spinner label={`Downloading ${sound.title}`}></ve-spinner>
          </span>
        ) : inUse ? (
          <span class="snd__in-use" key="in-use" role="img" aria-label="On this post">
            <ve-icon name="checkmark"></ve-icon>
          </span>
        ) : null}
      </li>
    );
  }

  /** The customer's own sounds and the two ways one gets in: the whole sheet before tabs existed. */
  private renderSaved(usedUris: ReadonlySet<string>) {
    const { media } = this.ctx;
    const library = media.hasSoundLibrary;
    const sounds = media.sounds.value;
    const extracting = media.extracting.value;
    const busy = media.busy.value;
    const loaded = media.soundsLoaded.value;
    const download = media.canDownloadSounds;
    const downloading = media.downloadingSound.value;

    return (
      <div class="snd__content" key="saved">
        <div class="snd__actions">
          {library ? (
            <button type="button" class="snd__action" key="extract" disabled={busy} onClick={this.extract}>
              {extracting ? (
                <ve-spinner class="snd__action-icon" key="spinner" label="Taking the sound out"></ve-spinner>
              ) : (
                <ve-icon class="snd__action-icon" name="arrow-down-circle-outline" key="icon"></ve-icon>
              )}
              <span class="snd__action-text">
                <span class="snd__action-title">{extracting ? 'Taking the sound out…' : 'Extract from video'}</span>
                <span class="snd__action-hint">{extracting ? 'This can take a moment on a long video' : 'Pick a video and keep its sound'}</span>
              </span>
            </button>
          ) : null}

          <button type="button" class="snd__action" key="files" disabled={busy} onClick={this.fromFiles}>
            <ve-icon class="snd__action-icon" name="musical-note-outline"></ve-icon>
            <span class="snd__action-text">
              <span class="snd__action-title">From files</span>
              <span class="snd__action-hint">A track already on this phone</span>
            </span>
          </button>
        </div>

        {library ? <p class="snd__heading" key="heading">Saved sounds</p> : null}

        {/*
          Three states, and each is a different element, so all three are keyed: an unkeyed
          list appearing where a sentence was would be matched against it by position.
        */}
        {!library ? null : sounds.length > 0 ? (
          <ul class="snd__list" key="list">
            {sounds.map(sound => this.renderRow(sound, usedUris.has(sound.uri), download, downloading))}
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
    );
  }

  /** One category's tracks, keyed by the category so switching tabs builds a new list. */
  private renderCategory(category: SoundCategory, usedUris: ReadonlySet<string>) {
    const { media } = this.ctx;
    const files = media.catalogueFiles.value;
    const fetching = media.fetchingSound.value;
    return (
      <div class="snd__content" key={`${CATEGORY_TAB}${category.id}`}>
        <ul class="snd__list">
          {category.sounds.map(sound => {
            const file = files.get(sound.id);
            return this.renderTrack(sound, file !== undefined && usedUris.has(file), fetching);
          })}
        </ul>
      </div>
    );
  }

  render() {
    return this.watcher.run(() => {
      const { store, media } = this.ctx;
      const categories = media.catalogue.value;
      const usedUris = new Set([
        ...(store.manifest.value.music ? [store.manifest.value.music.uri] : []),
        ...(store.manifest.value.audioTracks ?? []).flatMap(track => track.clips.map(clip => clip.uri)),
      ]);

      // No catalogue, no tabs: the sheet is exactly what it was before there was one.
      const tabs: SheetTab[] =
        categories.length > 0
          ? [
              { id: SAVED_TAB, label: media.hasSoundLibrary ? 'Saved' : 'Files' },
              ...categories.map(category => ({ id: `${CATEGORY_TAB}${category.id}`, label: category.name })),
            ]
          : [];
      const tab = activeTab(media.soundTab.value, tabs, {
        library: media.hasSoundLibrary,
        soundsLoaded: media.soundsLoaded.value,
        hasSounds: media.sounds.value.length > 0,
      });
      const category = tab.startsWith(CATEGORY_TAB) ? categories.find(one => `${CATEGORY_TAB}${one.id}` === tab) : undefined;

      return (
        <Host>
          <ve-sheet
            class="snd__frame"
            heading={tabs.length > 0 ? null : 'Sound'}
            tabs={tabs}
            activeTab={tabs.length > 0 ? tab : null}
            grabber={true}
            expanded={store.sheetExpanded.value}
            onVeTab={this.onTab}
            onVeConfirm={this.close}
          >
            {category ? this.renderCategory(category, usedUris) : this.renderSaved(usedUris)}
          </ve-sheet>
        </Host>
      );
    });
  }
}

/* ------------------------------------------------------------------------------------------- */

/**
 * The tab the sheet shows: the customer's choice in this edit while it is still on offer, and
 * otherwise their own sounds when they have some and a catalogue's first category when they have
 * none, so a new install opens on music rather than on an empty list. Their own sounds while those
 * are still being read, so the sheet does not open on a category and jump back.
 */
function activeTab(chosen: string | null, tabs: readonly SheetTab[], own: { library: boolean; soundsLoaded: boolean; hasSounds: boolean }): string {
  if (chosen && tabs.some(tab => tab.id === chosen)) return chosen;
  const firstCategory = tabs.find(tab => tab.id !== SAVED_TAB);
  if (!firstCategory) return SAVED_TAB;
  if (own.library && (!own.soundsLoaded || own.hasSounds)) return SAVED_TAB;
  return firstCategory.id;
}

/** `1:23 · today`, or just the date for a track whose length could not be read. */
function meta(sound: SavedSound): string {
  const when = savedWhen(sound.savedAt);
  return sound.durationMs > 0 ? `${clock(sound.durationMs)} · ${when}` : when;
}

/** `1:00 · 1.2 MB`: the length, and what choosing it downloads, each when the host knows it. */
function trackMeta(sound: CatalogueSound): string {
  const parts: string[] = [];
  if (sound.durationMs > 0) parts.push(clock(sound.durationMs));
  if (sound.sizeBytes && sound.sizeBytes > 0) parts.push(megabytes(sound.sizeBytes));
  return parts.join(' · ');
}

/** `1:23`, minutes and seconds, rounded down the way every other clock in the editor is. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** `1.2 MB`, and whole megabytes from ten up, where a decimal stops telling two tracks apart. */
function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.max(0.1, mb).toFixed(1)} MB`;
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
