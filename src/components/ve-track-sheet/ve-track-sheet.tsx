import { Component, Prop } from '@stencil/core';

import { closeWhenGone } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { trackSmooth, type OverlayKind, type OverlayTrack } from '../../editor';
import type { CoalesceKey } from '../../state/editor-store';

/** What the hint calls the layer being pinned. */
const NOUN: Readonly<Record<OverlayKind, string>> = { text: 'text', sticker: 'sticker', image: 'photo', effect: 'effect' };

/**
 * Track: a text, a sticker or a photo pinned to something in the footage, so it moves with it.
 *
 * One thing to do and one button to do it with. The sheet opens with a box on the picture round the
 * layer - most layers are put on or beside what they are about - which the customer drags onto the thing
 * (a tap moves it there, a corner or a pinch sizes it), and Track follows it through the layer's time on
 * screen, both ways from the frame the box is on. The run is watched on the picture rather than waited
 * for: the box rides along the footage as it is read, and the finished track plays itself back once.
 *
 * Tracked, the sheet is the few choices a track has - whether the layer grows and turns with the thing,
 * and how smooth its path is - and the box on the picture is the way to mend it: scrubbed to where it
 * slipped and dragged back onto the thing, it tracks again from there and keeps everything before.
 *
 * Every control writes the manifest through the store, as every sheet does. The none button takes the
 * track off and leaves the layer where it is; the tick is done, and a run still going keeps what it found.
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

  connectedCallback() {
    // The layer deleted under the sheet, or undone away, leaves nothing to track.
    this.stopClosing = closeWhenGone(
      () => !this.ctx.store.trackLayer.value,
      () => this.ctx.store.closePanel(),
    );
  }

  disconnectedCallback() {
    this.stopClosing?.();
    this.watcher.stop();
  }

  private readonly onConfirm = () => this.ctx.store.closePanel();
  private readonly onNone = () => this.ctx.store.removeTrack();
  private readonly onTrack = () => void this.ctx.store.startTracking('all');
  private readonly onTrackFromHere = () => void this.ctx.store.startTracking('from');
  private readonly onStop = () => this.ctx.store.stopTracking();
  private readonly onCancelMend = () => this.ctx.store.cancelTrackAim();
  private readonly onGestureStart = () => {
    this.gestureKey = this.ctx.store.coalesceKey('track-smooth');
  };
  private readonly onSmooth = (event: CustomEvent<number>) => this.ctx.store.setTrackSmooth(event.detail / 100, { coalesce: this.gestureKey });
  private readonly formatPercent = (value: number): string => `${Math.round(value)}%`;

  render() {
    return this.watcher.run(() => {
      const store = this.ctx.store;
      const layer = store.trackLayer.value;
      const run = store.trackRun.value;
      const track = layer?.track;
      let body = null;
      if (layer && run) body = this.renderRun(run.progress);
      else if (layer && track && !store.trackAimMoved.value) body = this.renderTracked(track);
      else if (layer) body = this.renderAim(layer.kind, !!track);
      return (
        <ve-sheet heading="Track" showNone={!!track && !run} noneLabel="Remove tracking" onVeNone={this.onNone} onVeConfirm={this.onConfirm}>
          {body}
        </ve-sheet>
      );
    });
  }

  /** Nothing tracked yet, or a track being mended from the playhead: the box is on the picture, and this goes. */
  private renderAim(kind: OverlayKind, mending: boolean) {
    return (
      <div class="tk" key={mending ? 'mend' : 'aim'}>
        <p class="tk__hint" key="hint">
          {mending ? 'The part before the playhead stays as it is' : `Drag the box onto what the ${NOUN[kind]} should follow`}
        </p>
        <button type="button" key="go" class="tk__go" onClick={mending ? this.onTrackFromHere : this.onTrack}>
          <ve-icon name="track-outline"></ve-icon>
          <span>{mending ? 'Track from here' : 'Track'}</span>
        </button>
        {mending ? (
          <button type="button" key="cancel" class="sheet__apply-all tk__cancel" onClick={this.onCancelMend}>
            Cancel
          </button>
        ) : null}
      </div>
    );
  }

  /** A run going: how far, and the way to end it early with what it has found. */
  private renderRun(progress: number) {
    const percent = Math.round(progress * 100);
    return (
      <div class="tk" key="run">
        <p class="tk__status" key="status">
          Tracking {percent}%
        </p>
        <div class="tk__bar" key="bar" role="progressbar" aria-label="Tracking" aria-valuemin="0" aria-valuemax="100" aria-valuenow={String(percent)}>
          <span class="tk__bar-fill" style={{ transform: `scaleX(${progress})` }}></span>
        </div>
        <button type="button" key="stop" class="tk__stop" onClick={this.onStop}>
          Stop
        </button>
      </div>
    );
  }

  /** A track on the layer: what it follows besides where the thing is, and how smooth its path is. */
  private renderTracked(track: OverlayTrack) {
    const store = this.ctx.store;
    const smooth = Math.round(trackSmooth(track) * 100);
    return (
      <div class="tk tk--tracked" key="tracked">
        <div class="tk__row" key="follow">
          <span class="tk__word">Follow</span>
          {this.switchChip('size', 'Size', !!track.scaleWith, () => store.setTrackFollow({ scaleWith: !track.scaleWith }))}
          {this.switchChip('turn', 'Rotation', !!track.turnWith, () => store.setTrackFollow({ turnWith: !track.turnWith }))}
        </div>
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
