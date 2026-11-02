import { Component, Prop } from '@stencil/core';
import { signal } from '@preact/signals-core';

import { BACKGROUND_COLORS, DEFAULT_OUTLINE_COLOR, DEFAULT_OUTLINE_WIDTH, MIN_CUTOUT_COVERAGE, cutoutTarget } from '../../editor';
import { closeWhenGone } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import type { CoalesceKey } from '../../state/editor-store';
import type { MatteState } from '../../state/editor.types';
import type { SheetTab } from '../sheet.types';

/** The sheet's two tabs: what is kept and how its edge sits, and what goes behind and round it. */
type CutoutTab = 'subject' | 'style';

const TABS: readonly SheetTab[] = [
  { id: 'subject', label: 'Subject' },
  { id: 'style', label: 'Style' },
];

/** What the sheet says on a host with no `findMatte`, which reaches it only for a cutout made elsewhere, to take it off. */
const UNSUPPORTED: MatteState = { status: 'none', reason: 'unsupported' };

/**
 * A clip's or a photo's Cutout: its background taken away, and what goes behind and round what is
 * left.
 *
 * The matte is found by the host's segmenter ([EditorMediaHost.findMatte]), which `EditorMedia` starts
 * as soon as the clip or photo has a cutout - opening this sheet puts one on - so the first tab says
 * how far that has got, stage by stage, until it is done; the preview then reveals the cutout. A photo
 * looked at as it went on (the offer over the preview) answers at once.
 *
 * Subject: what is kept - whatever stands out, or only the people - Compare, which holds the original
 * on the preview while it is pressed, and the edge: how soft, and where it sits. Style: a colour behind
 * the subject on a clip, a line round it in one of the swatches' colours, and on a photo a shadow under it.
 *
 * Every control writes the manifest live through the store, as every other sheet does; a slider's drag
 * lands as one undo step by its coalesce key, and a tap is a step of its own. The none button is Remove
 * cutout, which gives the background back and closes the sheet.
 */
@Component({
  tag: 've-cutout-sheet',
  styleUrls: ['../sheet-common.css', 've-cutout-sheet.css'],
  shadow: true,
})
export class VeCutoutSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);
  private readonly tab = signal<CutoutTab>('subject');
  private stopClosing?: () => void;
  /** The coalesce key of the slider drag under way; see `VeZoomSheet.gestureKey`. */
  private gestureKey?: CoalesceKey;

  connectedCallback() {
    // A clip or photo deleted under the sheet, or its cutout undone, leaves nothing to set.
    this.stopClosing = closeWhenGone(
      () => !this.ctx.store.subjectCutout.value,
      () => this.ctx.store.closePanel(),
    );
  }

  disconnectedCallback() {
    this.stopClosing?.();
    // A sheet that goes while Compare is held must not leave the preview showing the original.
    this.ctx.store.cutoutCompare.value = false;
    this.watcher.stop();
  }

  private readonly onConfirm = () => this.ctx.store.closePanel();
  private readonly onNone = () => this.ctx.store.removeCutout();
  private readonly onRetry = () => {
    this.ctx.media.retryCutout();
    this.ctx.store.haptic('light');
  };
  private readonly onTab = (event: CustomEvent<string>) => {
    this.tab.value = event.detail === 'style' ? 'style' : 'subject';
  };
  private readonly onGestureStart = () => {
    this.gestureKey = this.ctx.store.coalesceKey('cutout-slider');
  };
  private readonly onSoft = (event: CustomEvent<number>) => this.ctx.store.setCutoutLook({ soft: event.detail / 100 }, { coalesce: this.gestureKey });
  private readonly onShift = (event: CustomEvent<number>) => this.ctx.store.setCutoutLook({ shift: event.detail / 100 }, { coalesce: this.gestureKey });
  private readonly onOutlineWidth = (event: CustomEvent<number>) => {
    const outline = this.ctx.store.subjectCutout.value?.outline;
    if (outline) this.ctx.store.setCutoutLook({ outline: { color: outline.color, width: Math.max(0.01, event.detail / 100) } }, { coalesce: this.gestureKey });
  };
  private readonly formatPercent = (value: number): string => `${Math.round(value)}%`;
  private readonly formatSigned = (value: number): string => (value > 0 ? `+${Math.round(value)}` : `${Math.round(value)}`);

  /** Compare: the original on the preview for as long as the finger stays down. */
  private readonly onCompareDown = (event: PointerEvent) => {
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    this.ctx.store.cutoutCompare.value = true;
    this.ctx.store.haptic('light');
  };
  private readonly onCompareUp = () => {
    this.ctx.store.cutoutCompare.value = false;
  };
  private readonly onCompareKey = (event: KeyboardEvent) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    this.ctx.store.cutoutCompare.value = event.type === 'keydown';
  };

  private keep(target: 'subject' | 'people'): void {
    const store = this.ctx.store;
    if (cutoutTarget(store.subjectCutout.value) === target) return;
    store.setCutoutLook({ target });
    store.haptic('selection');
  }

  render() {
    return this.watcher.run(() => {
      const store = this.ctx.store;
      const tab = this.tab.value;
      return (
        <ve-sheet heading="Cutout" tabs={TABS} activeTab={tab} showNone={true} noneLabel="Remove cutout" onVeTab={this.onTab} onVeNone={this.onNone} onVeConfirm={this.onConfirm}>
          {store.subjectCutout.value ? (tab === 'style' ? this.renderStyle() : this.renderSubject()) : null}
        </ve-sheet>
      );
    });
  }

  private renderSubject() {
    const store = this.ctx.store;
    const subject = store.cutoutSubject.value!;
    const cutout = store.subjectCutout.value!;
    const state = store.cutoutMatte.value ?? (store.host.media.findMatte ? null : UNSUPPORTED);
    const noun = subject.kind === 'overlay' ? 'photo' : subject.clip.image ? 'picture' : 'clip';
    if (!state || state.status === 'finding') {
      const preparing = state?.status === 'finding' && state.stage === 'preparing';
      const percent = Math.round((state?.status === 'finding' ? state.progress : 0) * 100);
      return (
        <div class="cs cs--finding" key="finding">
          <p class="cs__status" key="status">
            {preparing ? `Getting ready ${percent}%` : `Finding the subject ${percent}%`}
          </p>
          <div class="cs__bar" key="bar" role="progressbar" aria-label="Finding the subject" aria-valuemin="0" aria-valuemax="100" aria-valuenow={String(percent)}>
            <span class="cs__bar-fill" style={{ transform: `scaleX(${percent / 100})` }}></span>
            <span class="cs__bar-glint"></span>
          </div>
        </div>
      );
    }
    if (state.status === 'none') {
      // A search that broke may well work a second time; a device with no engine never will.
      const failed = state.reason !== 'unsupported';
      return (
        <div class="cs" key="none">
          <p class="cs__status">{failed ? `This ${noun} could not be read` : 'Cutout is not available on this device'}</p>
          {failed ? (
            <button type="button" key="retry" class="cs__retry" onClick={this.onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      );
    }
    const target = cutoutTarget(cutout);
    const empty = !(state.result.coverage >= MIN_CUTOUT_COVERAGE);
    // An engine that finds only people answers `people` whatever was asked, and then offering the
    // choice is offering nothing.
    const choosable = state.result.engine !== 'mediapipe';
    return (
      <div class="cs" key="subject">
        <div class="cs__row cs__keep" key="keep">
          {choosable ? (
            <div class="cs__chips" key="chips">
              {this.keepChip('subject', 'Subject', target === 'subject')}
              {this.keepChip('people', 'People', target === 'people')}
            </div>
          ) : (
            <span class="cs__word cs__word--wide" key="people">
              People
            </span>
          )}
          {!empty ? (
            <button
              type="button"
              key="compare"
              class={{ 'cs__compare': true, 'cs__compare--held': store.cutoutCompare.value }}
              aria-label="Hold to compare"
              onPointerDown={this.onCompareDown}
              onPointerUp={this.onCompareUp}
              onPointerCancel={this.onCompareUp}
              onLostPointerCapture={this.onCompareUp}
              onKeyDown={this.onCompareKey}
              onKeyUp={this.onCompareKey}
            >
              <ve-icon name="eye-outline"></ve-icon>
              <span>Compare</span>
            </button>
          ) : null}
        </div>
        {empty ? (
          <p class="cs__status cs__status--row" key="empty">
            {target === 'people' ? `No people found in this ${noun}` : `No subject found in this ${noun}`}
          </p>
        ) : (
          [
            this.slider('soft', 'Soft', 'Cutout softness', Math.round((cutout.soft ?? 0) * 100), 0, 100, 0, this.onSoft, this.formatPercent),
            this.slider('shift', 'Edge', 'Cutout edge', Math.round((cutout.shift ?? 0) * 100), -100, 100, 0, this.onShift, this.formatSigned),
          ]
        )}
      </div>
    );
  }

  private keepChip(target: 'subject' | 'people', word: string, on: boolean) {
    return (
      <button type="button" key={target} class={{ 'cs__chip': true, 'cs__chip--on': on }} aria-label={on ? `${word}, selected` : word} onClick={() => this.keep(target)}>
        <span class="cs__pill">{word}</span>
      </button>
    );
  }

  private renderStyle() {
    const store = this.ctx.store;
    const subject = store.cutoutSubject.value!;
    const cutout = store.subjectCutout.value!;
    const outline = cutout.outline;
    return (
      <div class="cs cs--style" key="style">
        {subject.kind === 'clip'
          ? this.swatches('fill', 'Fill', cutout.fill ?? null, colour => {
              store.setCutoutLook({ fill: colour });
              store.haptic('selection');
            })
          : null}
        {this.swatches('outline', 'Outline', outline?.color ?? null, colour => {
          store.setCutoutLook({ outline: colour ? { color: colour, width: outline?.width ?? DEFAULT_OUTLINE_WIDTH } : null });
          store.haptic('selection');
        })}
        {outline ? this.slider('width', 'Width', 'Outline width', Math.round(outline.width * 100), 1, 100, 1, this.onOutlineWidth, this.formatPercent) : null}
        {subject.kind === 'overlay' ? (
          <button
            type="button"
            key="shadow"
            role="switch"
            class="cs__row cs__switch-row"
            aria-checked={String(!!cutout.shadow)}
            // The state in the name as well: a changed aria-checked never reaches Android's tree from a shadow root.
            aria-label={cutout.shadow ? 'Shadow, on' : 'Shadow'}
            onClick={() => {
              store.setCutoutLook({ shadow: !cutout.shadow });
              store.haptic('selection');
            }}
          >
            <span class="cs__switch-label">Shadow</span>
            <span class={{ 'cs__switch': true, 'cs__switch--on': !!cutout.shadow }} aria-hidden="true">
              <span class="cs__switch-knob"></span>
            </span>
          </button>
        ) : null}
      </div>
    );
  }

  /**
   * A row of colours with None first: the fill behind the subject, or the line round it. The colour in
   * use wears a ring, and says so in its name, which is what an old WebView passes on to a screen
   * reader where it drops a pressed state.
   */
  private swatches(key: string, word: string, current: string | null, pick: (colour: string | null) => void) {
    const palette = BACKGROUND_COLORS.map(entry => entry.colour);
    // A sticker's line is white first: the look the outline is there for.
    const colours = key === 'outline' ? [DEFAULT_OUTLINE_COLOR, ...palette.filter(colour => colour !== DEFAULT_OUTLINE_COLOR)] : palette;
    const labelOf = (colour: string): string => BACKGROUND_COLORS.find(entry => entry.colour === colour)?.label ?? colour;
    const none = `No ${word.toLowerCase()}`;
    return (
      <div class="cs__row cs__swatch-row" key={key}>
        <span class="cs__word">{word}</span>
        <div class="cs__swatches" role="group" aria-label={word}>
          <button type="button" key="none" class={{ 'cs__swatch': true, 'cs__swatch--none': true, 'cs__swatch--on': current === null }} aria-label={current === null ? `${none}, selected` : none} onClick={() => pick(null)}>
            <ve-icon name="ban-outline"></ve-icon>
          </button>
          {colours.map(colour => (
            <button
              type="button"
              key={colour}
              class={{ 'cs__swatch': true, 'cs__swatch--on': current === colour }}
              style={{ '--cs-colour': colour }}
              aria-label={current === colour ? `${word} ${labelOf(colour)}, selected` : `${word} ${labelOf(colour)}`}
              onClick={() => pick(colour)}
            >
              <span class="cs__dot"></span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  private slider(key: string, word: string, label: string, value: number, min: number, max: number, from: number, onLive: (event: CustomEvent<number>) => void, format: (value: number) => string) {
    return (
      <div class="cs__row" key={key}>
        <span class="cs__word">{word}</span>
        <ve-slider
          class="cs__slider"
          ctx={this.ctx}
          label={label}
          value={value}
          min={min}
          max={max}
          step={1}
          from={from}
          snap={min < 0 ? [0] : []}
          snapRadius={min < 0 ? 4 : 0}
          pin="none"
          format={format}
          onVeGestureStart={this.onGestureStart}
          onVeLive={onLive}
        />
        {/* The number a test can read: the slider reaches uiautomator unnamed (see ve-slider). */}
        <span class="cs__value" data-readout={key}>
          {format(value)}
        </span>
      </div>
    );
  }
}
