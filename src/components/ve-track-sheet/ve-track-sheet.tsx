import { Component, Prop } from '@stencil/core';

import { activeElementDeep } from '../../bridge/active-element';
import { closeWhenGone } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { MAX_TRACK_NAME, trackSmooth, weakSpots, type EditOverlay, type EditTrack, type OverlayKind } from '../../editor';
import type { CoalesceKey } from '../../state/editor-store';
import type { TrackRunView } from '../../state/editor.types';

/** What the hints call the layer being pinned. */
const NOUN: Readonly<Record<OverlayKind, string>> = { text: 'text', sticker: 'sticker', image: 'photo', effect: 'effect' };

/**
 * What the sheet shows, in the order the five win when more than one could: a run under way; a layer
 * that follows nothing, asking which track to follow; the box being aimed for a new track; the shown
 * track's box dragged off its path; and the track itself.
 */
type Face = 'run' | 'choose' | 'aim' | 'fix' | 'track';

/**
 * How long the name's field waits to take the focus. Android raises the keyboard for a programmatic focus
 * only once the field is laid out, while the tap that asked for it still counts as a gesture: the text
 * sheet's wait, for the text sheet's reason.
 */
const FOCUS_DELAY_MS = 120;

/** How long the WebView is given to raise the keyboard by itself before the host is asked to: the text sheet's. */
const KEYBOARD_FALLBACK_MS = 450;

/** A track's colour, as the timeline, the preview and this sheet all name it. */
function hueOf(track: Pick<EditTrack, 'hue'>): string {
  return `var(--ve-track-${track.hue})`;
}

/**
 * Track: something in the footage followed, a layer of its own that texts, stickers and photos are pinned
 * to so they move with it.
 *
 * The sheet is where a track is made, looked at and mended, and it opens from three places: the Track tool
 * on the main row (a new track), the Track tool on a text, sticker or photo (the track the layer follows,
 * or one for it to follow), and a track's own row. It shows one of five faces, the first that applies:
 *
 *  - A run under way: how far it has got, and Stop, which keeps what it found.
 *  - Choosing: a layer that follows nothing, on a post that has tracks, picks one of them - pinned where
 *    it is drawn now - or New track.
 *  - Aiming: the box on the picture, which a tap or a drag puts on the thing, and Track. The people the
 *    finder found light up on the picture, where a tap on one aims at them; this face only offers to
 *    look for them, and says how that went.
 *  - Fixing: the shown track's box dragged off its path. Fix track follows the thing again from this
 *    frame, both ways, until each way meets the old path.
 *  - The track: how sure it is, how smooth its path is and, on a layer that follows it, whether the layer
 *    grows and turns with the thing.
 *
 * A shown track's name heads the body rather than the frame: `ve-sheet` takes its heading as a string,
 * and the name is a button that becomes a field - on a tap, or from Rename on the track's row, which opens
 * the sheet with `trackRenaming` set.
 *
 * The sheet's height depends on whether it is open on a layer and on nothing else, never on the face:
 * the picture above it is what the box is dragged on, and a sheet that grew when the box left the track
 * resized the picture under the finger that was dragging it. The stylesheet has the arithmetic.
 *
 * Every control writes the manifest through the store, as every sheet does, and the store gives the
 * haptics. The none button takes a layer off its track (Remove tracking) or, with no layer, the track off
 * the post (Remove track); the tick is done, and a run still going keeps what it found.
 */
@Component({
  tag: 've-track-sheet',
  styleUrls: ['../sheet-common.css', 've-track-sheet.css'],
  shadow: true,
})
export class VeTrackSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);
  private stopClosing?: () => void;
  /** The coalesce key of the slider drag under way; see `VeZoomSheet.gestureKey`. */
  private gestureKey?: CoalesceKey;
  /** The name's field, while the name is being typed. */
  private field?: HTMLInputElement;
  private focusTimer?: ReturnType<typeof setTimeout>;
  private keyboardTimer?: ReturnType<typeof setTimeout>;

  connectedCallback() {
    // Nothing left to show is nothing left to do: the track the sheet showed undone away, with no box
    // drawn and no run going. A layer undone or deleted away is not watched for here, because it takes
    // the selection with it and the selection takes the sheet. Only while this is the open sheet: another
    // one opening in its place empties all of these a moment before this element is taken off.
    this.stopClosing = closeWhenGone(
      () => {
        const store = this.ctx.store;
        return store.panel.value === 'track' && !store.trackRun.value && !store.trackShown.value && !store.trackAim.value && !store.trackChoosing.value;
      },
      () => this.ctx.store.closePanel(),
    );
  }

  disconnectedCallback() {
    this.stopClosing?.();
    this.watcher.stop();
    clearTimeout(this.focusTimer);
    clearTimeout(this.keyboardTimer);
  }

  private readonly onConfirm = () => {
    // A name being typed is kept. Chrome blurs the field as the tick takes the focus, which keeps it
    // anyway, but WebKit does not focus a tapped button, and the field would go with the sheet unread.
    this.endRename(true);
    this.ctx.store.closePanel();
  };
  private readonly onNone = () => {
    const store = this.ctx.store;
    const none = this.noneAction();
    const track = store.trackShown.value;
    if (none === 'unpin') store.unpinLayer();
    else if (none === 'remove' && track) store.deleteTrack(track.id);
  };
  private readonly onTrack = () => void this.ctx.store.startTracking();
  private readonly onStop = () => this.ctx.store.stopTracking();
  private readonly onCancelFix = () => this.ctx.store.cancelTrackAim();
  private readonly onNewTrack = () => this.ctx.store.chooseTrack(null);
  private readonly onFindPeople = () => this.ctx.store.findTrackPeople();
  private readonly onNextSpot = () => {
    const track = this.ctx.store.trackShown.value;
    if (track) this.ctx.store.fixNextSpot(track.id);
  };
  private readonly onRename = () => {
    this.ctx.store.trackRenaming.value = true;
  };
  private readonly onGestureStart = () => {
    this.gestureKey = this.ctx.store.coalesceKey('track-smooth');
  };
  private readonly onSmooth = (event: CustomEvent<number>) => this.ctx.store.setTrackSmooth(event.detail / 100, { coalesce: this.gestureKey });
  private readonly formatPercent = (value: number): string => `${Math.round(value)}%`;

  /**
   * What the none button does, when there is one: on a layer that follows a track, takes the layer off it;
   * on a track with no layer, takes the track off the post. None while a run is going, which Stop ends.
   */
  private noneAction(): 'unpin' | 'remove' | null {
    const store = this.ctx.store;
    if (store.trackRun.value) return null;
    const layer = store.trackLayer.value;
    if (layer) return layer.follow ? 'unpin' : null;
    return store.trackShown.value ? 'remove' : null;
  }

  /* ========================================================================================= */
  /* The name                                                                                  */
  /* ========================================================================================= */

  private readonly keepField = (el?: HTMLInputElement) => {
    if (el && el !== this.field) this.focusSoon(el);
    this.field = el ?? undefined;
  };

  private readonly onFieldKey = (event: KeyboardEvent) => {
    // The Enter that ends a composition is the keyboard's, not the customer's.
    if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
    // Taken, so the editor's own Escape, which closes the sheet, leaves the sheet be.
    event.preventDefault();
    this.endRename(event.key === 'Enter');
  };

  private readonly onFieldBlur = () => this.endRename(true);

  /**
   * The field put down: what was typed kept - on Enter, or the focus going anywhere else, the tick
   * included - or not, on Escape. Once only: a field taken off the page can blur on its way out as well,
   * after the key that took it away.
   */
  private endRename(keep: boolean): void {
    const store = this.ctx.store;
    if (!store.trackRenaming.peek()) return;
    const typed = this.field?.value;
    const track = store.trackShown.peek();
    store.trackRenaming.value = false;
    if (keep && track && typed !== undefined) store.renameTrack(track.id, typed);
  }

  /**
   * The field as it comes up: focused with the whole name selected, so typing replaces it. A beat later
   * rather than at once ([FOCUS_DELAY_MS]), and with the keyboard asked for from the host when the WebView
   * focused the field without raising one, as the text sheet does for its own field.
   */
  private focusSoon(field: HTMLInputElement): void {
    clearTimeout(this.focusTimer);
    clearTimeout(this.keyboardTimer);
    this.focusTimer = setTimeout(() => {
      if (this.field !== field || !field.isConnected) return;
      field.focus({ preventScroll: true });
      field.select();
      const { keyboard } = this.ctx.store.host.platform;
      this.keyboardTimer = setTimeout(() => {
        if (activeElementDeep() === field) keyboard.show?.();
      }, KEYBOARD_FALLBACK_MS);
    }, FOCUS_DELAY_MS);
  }

  /* ========================================================================================= */
  /* Render                                                                                    */
  /* ========================================================================================= */

  render() {
    return this.watcher.run(() => {
      const store = this.ctx.store;
      const run = store.trackRun.value;
      const track = store.trackShown.value;
      const layer = store.trackLayer.value;
      const none = this.noneAction();
      const face: Face = run ? 'run' : layer && store.trackChoosing.value ? 'choose' : !track ? 'aim' : store.trackAimMoved.value ? 'fix' : 'track';
      return (
        <ve-sheet heading="Track" showNone={none !== null} noneLabel={none === 'unpin' ? 'Remove tracking' : 'Remove track'} onVeNone={this.onNone} onVeConfirm={this.onConfirm}>
          <div class={{ 'tk': true, 'tk--layer': !!layer }} style={track ? { '--tk-hue': hueOf(track) } : undefined}>
            {/* Every child keyed: all of them are conditional, and the vdom pairs unkeyed siblings by position. */}
            {track ? this.renderName(track, face) : null}
            {face === 'run' && run ? this.renderRun(run) : null}
            {face === 'choose' && layer ? this.renderChoose(layer.kind) : null}
            {face === 'aim' ? this.renderAim() : null}
            {face === 'fix' ? this.renderFix() : null}
            {face === 'track' && track ? this.renderTrack(track, layer) : null}
          </div>
        </ve-sheet>
      );
    });
  }

  /**
   * The shown track's name in its colour, over whatever the sheet shows of it. A tap on the name, or
   * Rename on the track's row, makes it a field; Enter or a tap anywhere else keeps what was typed, Escape
   * does not. Plain words while a run is going. On the track's own face it ends with how sure the track is.
   *
   * The button's name says what a tap does, "Rename Track 1", rather than only repeating the name: that is
   * what TalkBack reads and what a flow finds it by.
   */
  private renderName(track: EditTrack, face: Face) {
    if (this.ctx.store.trackRenaming.value && face !== 'run') {
      return (
        <div class="tk__head tk__head--field" key="name">
          <span class="tk__dot" key="dot"></span>
          <input
            key="field"
            class="tk__field"
            type="text"
            aria-label="Track name"
            value={track.name}
            maxLength={MAX_TRACK_NAME}
            enterkeyhint="done"
            autocomplete="off"
            spellcheck={false}
            ref={this.keepField}
            onKeyDown={this.onFieldKey}
            onBlur={this.onFieldBlur}
          />
        </div>
      );
    }
    return (
      <div class="tk__head" key="name">
        {face === 'run' ? (
          <span class="tk__name tk__name--still" key="still">
            <span class="tk__dot"></span>
            <span class="tk__name-text">{track.name}</span>
          </span>
        ) : (
          <button type="button" key="rename" class="tk__name" aria-label={`Rename ${track.name}`} onClick={this.onRename}>
            <span class="tk__dot"></span>
            <span class="tk__name-text">{track.name}</span>
            <ve-icon class="tk__pencil" name="pencil"></ve-icon>
          </button>
        )}
        {face === 'track' ? this.renderHealth(track) : null}
      </div>
    );
  }

  /**
   * How sure the track is, from its spots worth a second look: none, or how many and the way to the next
   * one after the playhead. Keyed by which, so the line fades over when a fix takes the last spot away.
   */
  private renderHealth(track: EditTrack) {
    const spots = weakSpots(track).length;
    if (spots === 0) {
      return (
        <span class="tk__health" key="sure">
          <ve-icon class="tk__check" name="checkmark"></ve-icon>
          Sure the whole way
        </span>
      );
    }
    return [
      <span class="tk__health tk__health--spots" key="spots">
        {spots === 1 ? '1 spot to check' : `${spots} spots to check`}
      </span>,
      <button type="button" key="next" class="tk__chip tk__next" onClick={this.onNextSpot}>
        <span class="tk__pill">Next spot</span>
      </button>,
    ];
  }

  /**
   * A run going: how far, on a bar in the track's colour for a fix and the editor's own for a new track,
   * and the way to end it early with what it has found.
   */
  private renderRun(run: TrackRunView) {
    const percent = Math.round(run.progress * 100);
    return (
      <div class="tk__face tk__face--run" key="run">
        <p class="tk__status" key="status">
          Tracking {percent}%
        </p>
        <div
          class={{ 'tk__bar': true, 'tk__bar--fix': run.mode === 'fix' }}
          key="bar"
          role="progressbar"
          aria-label="Tracking"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={String(percent)}
        >
          <span class="tk__bar-fill" style={{ transform: `scaleX(${run.progress})` }}></span>
        </div>
        <button type="button" key="stop" class="tk__stop" onClick={this.onStop}>
          Stop
        </button>
      </div>
    );
  }

  /**
   * A layer that follows nothing, on a post that has tracks: which one it follows, pinned at once where it
   * is drawn now, or a new one aimed round it. Each chip wears its track's colour, as the track's row does.
   */
  private renderChoose(kind: OverlayKind) {
    const store = this.ctx.store;
    return (
      <div class="tk__face tk__face--choose" key="choose">
        <p class="tk__hint" key="hint">
          {`Pick what the ${NOUN[kind]} follows`}
        </p>
        <div class="tk__chips" key="chips">
          <div class="tk__chips-run">
            {store.tracks.value.map(track => (
              <button type="button" key={track.id} class="tk__chip" data-track={track.id} style={{ '--tk-hue': hueOf(track) }} onClick={() => store.chooseTrack(track.id)}>
                <span class="tk__pill">
                  <span class="tk__dot"></span>
                  {track.name}
                </span>
              </button>
            ))}
            <button type="button" key="new" class="tk__chip" onClick={this.onNewTrack}>
              <span class="tk__pill">
                <ve-icon name="add"></ve-icon>
                New track
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  /**
   * No track shown: the box is on the picture, a tap or a drag puts it on the thing, and Track follows it.
   * The people line under the hint is quiet on purpose - the picture is where people are picked.
   */
  private renderAim() {
    return (
      <div class="tk__face tk__face--aim" key="aim">
        <p class="tk__hint" key="hint">
          Tap what to follow, or drag a box
        </p>
        {this.renderPeople()}
        <button type="button" key="go" class="tk__go" onClick={this.onTrack}>
          <ve-icon name="track-outline"></ve-icon>
          <span>Track</span>
        </button>
      </div>
    );
  }

  /**
   * The people finder, as far as it has got: an offer to look, the looking, what to do with what it
   * found, or that it found nobody. Nothing at all on a device that cannot look. A polite live region, so
   * TalkBack says how the looking went without the customer going back to find out.
   */
  private renderPeople() {
    const people = this.ctx.store.trackPeople.value;
    if (people === 'unavailable') return null;
    return (
      <div class="tk__people" key="people" aria-live="polite">
        {people === 'idle' ? (
          <button type="button" key="idle" class="tk__chip" onClick={this.onFindPeople}>
            <span class="tk__pill">Find people</span>
          </button>
        ) : (
          <p class="tk__note" key={people}>
            {people === 'finding' ? 'Finding people...' : people === 'ready' ? 'Tap a person to follow' : 'No people found'}
          </p>
        )}
      </div>
    );
  }

  /**
   * The shown track's box dragged off its path: Fix track follows the thing again from this frame, both
   * ways until each way meets the old path, and blends the joins; Cancel puts the box back on the track.
   * Side by side rather than one under the other, so the face fits under the track's name.
   */
  private renderFix() {
    return (
      <div class="tk__face tk__face--fix" key="fix">
        <p class="tk__hint" key="hint">
          Fixes the track both ways from here
        </p>
        <div class="tk__pair" key="pair">
          <button type="button" key="cancel" class="sheet__apply-all tk__cancel" onClick={this.onCancelFix}>
            Cancel
          </button>
          <button type="button" key="go" class="tk__go" onClick={this.onTrack}>
            <ve-icon name="track-outline"></ve-icon>
            <span>Fix track</span>
          </button>
        </div>
      </div>
    );
  }

  /**
   * The track: how smooth its path is, for everything that follows it, and - on a layer that follows it -
   * whether that layer grows and turns with the thing. How sure it is ends the name's row above.
   */
  private renderTrack(track: EditTrack, layer: EditOverlay | null) {
    const store = this.ctx.store;
    const smooth = Math.round(trackSmooth(track) * 100);
    const follow = layer?.follow?.trackId === track.id ? layer.follow : null;
    return (
      <div class="tk__face tk__face--rows" key="track">
        <div class="tk__row" key="smooth">
          <span class="tk__word">Smooth</span>
          <ve-slider
            class="tk__slider"
            ctx={this.ctx}
            label="Smooth"
            value={smooth}
            min={0}
            max={100}
            step={1}
            pin="none"
            format={this.formatPercent}
            onVeGestureStart={this.onGestureStart}
            onVeLive={this.onSmooth}
          />
          {/* The number a test can read: the slider reaches uiautomator unnamed (see ve-slider). */}
          <span class="tk__value" data-readout="smooth">
            {smooth}%
          </span>
        </div>
        {follow ? (
          <div class="tk__row" key="follow">
            <span class="tk__word">Follow</span>
            {this.switchChip('size', 'Size', !!follow.scaleWith, () => store.setTrackFollow({ scaleWith: !follow.scaleWith }))}
            {this.switchChip('turn', 'Rotation', !!follow.turnWith, () => store.setTrackFollow({ turnWith: !follow.turnWith }))}
          </div>
        ) : null}
        <p class="tk__hint" key="hint">
          Drag the box to fix the track from here
        </p>
      </div>
    );
  }

  /**
   * A chip that is a switch, named by its own words, which the switch role lets Chromium pass to
   * Android (see `build/android-names.unit.test.ts`) - and while it is on, the name says so as well.
   * On the A13's WebView 156 a changed `aria-checked` inside a shadow root never reaches Android's tree:
   * tapped on, the chip read as off there, where TalkBack and the Maestro flows read it. A changed name
   * does reach it, which is the volume sheet's fade switches' finding too.
   */
  private switchChip(key: string, label: string, on: boolean, toggle: () => void) {
    return (
      <button
        type="button"
        key={key}
        role="switch"
        aria-checked={String(on)}
        aria-label={on ? `${label}, on` : label}
        class={{ 'tk__chip': true, 'tk__chip--on': on }}
        onClick={toggle}
      >
        <span class="tk__pill">{label}</span>
      </button>
    );
  }
}
