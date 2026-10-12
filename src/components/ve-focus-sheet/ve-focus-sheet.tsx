import { Component, Prop } from '@stencil/core';
import { signal } from '@preact/signals-core';

import { closeWhenGone } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import type { CoalesceKey } from '../../state/editor-store';
import { subjectColour } from '../../state/subject-colours';
import type { SheetTab } from '../sheet.types';

/** The sheet's two tabs: who stays sharp and when that changes, and what becomes of everything else. */
type FocusTab = 'subjects' | 'look';

const TABS: readonly SheetTab[] = [
  { id: 'subjects', label: 'Subjects' },
  { id: 'look', label: 'Look' },
];

/**
 * A clip's Focus: which of its subjects stay sharp while the rest of the picture is softened, greyed
 * or darkened, and where in the clip the focus moves from one subject to another.
 *
 * The subjects are found by the host's segmenter ([EditorMediaHost.findSubjects]), which `EditorMedia`
 * starts as soon as the clip has a focus - opening this sheet puts one on - so the first tab says how
 * far that has got until it is done. Then each subject has a chip, in the colour and number it is
 * outlined in on the preview, where a tap on the person does what a tap on their chip does.
 *
 * WHICH subjects a tap changes is the choice in effect at the playhead: the clip's own until its first
 * change, a change's from its time on. "Change here" makes a change at the playhead for the next taps
 * to fill, and a change's chip moves the playhead to it. The look is one for the whole clip.
 *
 * Every control writes the manifest live through the store, as every other sheet does; a slider's
 * drag lands as one undo step by its coalesce key, and a tap is a step of its own. The none button is
 * Remove focus, which takes the focus off and closes the sheet.
 */
@Component({
  tag: 've-focus-sheet',
  styleUrls: ['../sheet-common.css', 've-focus-sheet.css'],
  shadow: true,
})
export class VeFocusSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);
  private readonly tab = signal<FocusTab>('subjects');
  private stopClosing?: () => void;
  /** The coalesce key of the slider drag under way; see `VeZoomSheet.gestureKey`. */
  private gestureKey?: CoalesceKey;

  connectedCallback() {
    // A clip deleted under the sheet, or its focus undone, leaves nothing to set.
    this.stopClosing = closeWhenGone(
      () => !this.ctx.store.focusClip.value?.focus,
      () => this.ctx.store.closePanel(),
    );
  }

  disconnectedCallback() {
    this.stopClosing?.();
    this.watcher.stop();
  }

  private readonly onConfirm = () => this.ctx.store.closePanel();
  private readonly onNone = () => this.ctx.store.removeFocus();
  private readonly onTab = (event: CustomEvent<string>) => {
    this.tab.value = event.detail === 'look' ? 'look' : 'subjects';
  };
  private readonly onGestureStart = () => {
    this.gestureKey = this.ctx.store.coalesceKey('focus-slider');
  };
  private readonly onBlur = (event: CustomEvent<number>) => this.ctx.store.setFocusLook({ blur: event.detail / 100 }, { coalesce: this.gestureKey });
  private readonly onMono = (event: CustomEvent<number>) => this.ctx.store.setFocusLook({ mono: event.detail / 100 }, { coalesce: this.gestureKey });
  private readonly onDim = (event: CustomEvent<number>) => this.ctx.store.setFocusLook({ dim: event.detail / 100 }, { coalesce: this.gestureKey });
  private readonly formatPercent = (value: number): string => `${Math.round(value)}%`;
  private readonly onInvert = () => {
    const focus = this.ctx.store.focusClip.value?.focus;
    if (!focus) return;
    this.ctx.store.setFocusLook({ invert: !focus.invert });
    this.ctx.store.haptic('selection');
  };
  private readonly onChangeHere = () => this.ctx.store.addFocusChangeAtPlayhead();

  private goToChange(atMs: number): void {
    const store = this.ctx.store;
    const clip = store.focusClip.value;
    const at = clip ? store.focusChangeOutputMs(clip.id, atMs) : null;
    if (at !== null) store.seek(at);
  }

  render() {
    return this.watcher.run(() => {
      const store = this.ctx.store;
      const tab = this.tab.value;
      return (
        <ve-sheet heading="Focus" tabs={TABS} activeTab={tab} showNone={true} noneLabel="Remove focus" onVeTab={this.onTab} onVeNone={this.onNone} onVeConfirm={this.onConfirm}>
          {store.focusClip.value?.focus ? (tab === 'look' ? this.renderLook() : this.renderSubjects()) : null}
        </ve-sheet>
      );
    });
  }

  private renderSubjects() {
    const store = this.ctx.store;
    const clip = store.focusClip.value!;
    const state = store.focusTrack.value;
    if (!state || state.status === 'finding') {
      const percent = Math.round((state?.status === 'finding' ? state.progress : 0) * 100);
      return (
        <div class="fs" key="finding">
          <p class="fs__status" key="status">
            Finding subjects {percent}%
          </p>
          <div class="fs__bar" key="bar" role="progressbar" aria-label="Finding subjects" aria-valuemin="0" aria-valuemax="100" aria-valuenow={String(percent)}>
            <span class="fs__bar-fill" style={{ transform: `scaleX(${percent / 100})` }}></span>
          </div>
        </div>
      );
    }
    if (state.status === 'none') {
      return (
        <div class="fs" key="none">
          <p class="fs__status">{state.reason === 'unsupported' ? 'Focus is not available on this device' : 'This clip could not be read'}</p>
        </div>
      );
    }
    const subjects = state.result.subjects;
    if (subjects.length === 0) {
      return (
        <div class="fs" key="empty">
          <p class="fs__status">No subjects found in this clip</p>
        </div>
      );
    }
    const inFocus = new Set(store.focusSubjectsNow.value);
    const all = subjects.every(subject => inFocus.has(subject.id));
    const changes = (clip.focus?.changes ?? []).map((change, index) => ({ change, index })).filter(({ change }) => change.atMs > clip.inMs && change.atMs < clip.outMs);
    return (
      <div class="fs" key="subjects">
        <div class="fs__row fs__chips" key="chips">
          <button type="button" key="all" class={{ 'fs__chip': true, 'fs__chip--on': all }} aria-label={all ? 'All subjects, in focus' : 'All subjects'} onClick={() => store.toggleFocusSubject('all')}>
            <span class="fs__pill">All</span>
          </button>
          {subjects.map(subject => {
            const on = inFocus.has(subject.id);
            return (
              <button
                type="button"
                key={`subject-${subject.id}`}
                data-subject={String(subject.id)}
                class={{ 'fs__chip': true, 'fs__chip--on': on }}
                aria-label={on ? `Subject ${subject.id}, in focus` : `Subject ${subject.id}`}
                style={{ '--fs-colour': subjectColour(subject.id) }}
                onClick={() => store.toggleFocusSubject(subject.id)}
              >
                <span class="fs__pill fs__pill--subject">{subject.id}</span>
              </button>
            );
          })}
        </div>

        <div class="fs__row fs__changes" key="changes">
          <button type="button" key="here" class="fs__here" onClick={this.onChangeHere}>
            <ve-icon name="add"></ve-icon>
            <span>Change here</span>
          </button>
          {changes.map(({ change, index }) => {
            const label = `${(change.atMs - clip.inMs) / 1000 < 10 ? ((change.atMs - clip.inMs) / 1000).toFixed(1) : Math.round((change.atMs - clip.inMs) / 1000)}s`;
            return (
              <span key={`change-${change.atMs}`} class="fs__change">
                <button type="button" class="fs__change-time" aria-label={`Focus change at ${label}`} onClick={() => this.goToChange(change.atMs)}>
                  {label}
                </button>
                <button type="button" class="fs__change-remove" aria-label={`Remove focus change at ${label}`} onClick={() => store.removeFocusChange(index)}>
                  <ve-icon name="close"></ve-icon>
                </button>
              </span>
            );
          })}
        </div>

        <p class="fs__hint" key="hint">
          Tap the video to choose who stays sharp
        </p>
      </div>
    );
  }

  private renderLook() {
    const focus = this.ctx.store.focusClip.value!.focus!;
    return (
      <div class="fs fs--look" key="look">
        {this.slider('blur', 'Blur', 'Focus blur', focus.blur, this.onBlur)}
        {this.slider('mono', 'Grey', 'Focus grey', focus.mono ?? 0, this.onMono)}
        {this.slider('dim', 'Dim', 'Focus dim', focus.dim ?? 0, this.onDim)}
        <button type="button" key="invert" role="switch" class="fs__row fs__invert" aria-checked={String(!!focus.invert)} onClick={this.onInvert}>
          <span class="fs__invert-label">Blur the subjects instead</span>
          <span class={{ 'fs__switch': true, 'fs__switch--on': !!focus.invert }} aria-hidden="true">
            <span class="fs__switch-knob"></span>
          </span>
        </button>
      </div>
    );
  }

  private slider(key: string, word: string, label: string, value: number, onLive: (event: CustomEvent<number>) => void) {
    return (
      <div class="fs__row" key={key}>
        <span class="fs__word">{word}</span>
        <ve-slider
          class="fs__slider"
          ctx={this.ctx}
          label={label}
          value={Math.round(value * 100)}
          min={0}
          max={100}
          step={1}
          pin="none"
          format={this.formatPercent}
          onVeGestureStart={this.onGestureStart}
          onVeLive={onLive}
        />
        {/* The number a test can read: the slider reaches uiautomator unnamed (see ve-slider). */}
        <span class="fs__value" data-readout={key}>
          {Math.round(value * 100)}%
        </span>
      </div>
    );
  }
}
