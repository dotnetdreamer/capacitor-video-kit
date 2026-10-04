import { Component, Host, Prop } from '@stencil/core';
import { signal } from '@preact/signals-core';

import type { EditorContext } from '../../bridge/editor-context';
import { closeWhenGone } from '../../bridge/deferred-effect';
import { SignalWatcher } from '../../bridge/signal-watcher';
import {
  DEFAULT_LAYOUT_ANIMATION_MS,
  LAYOUT_ANIMATIONS,
  LAYOUT_ANIMATION_STEP_MS,
  MAX_LAYOUT_ANIMATION_MS,
  MIN_LAYOUT_ANIMATION_MS,
  sameRect,
  type EditVideoTrack,
  type LayoutAnimationPreset,
  type LayoutPresetId,
} from '../../editor';
import type { SheetTab } from '../sheet.types';
import { durationChip } from '../ve-timeline/timeline-geometry';
import { percentLabel } from '../ve-slider/slider-geometry';
import { animationTile, layoutChips, matchLayoutPreset, type AnimationTile, type LayoutChip } from './layout-chips';

/** The sheet's two tabs: where the videos sit, and how that arrangement opens and closes. */
type LayoutTab = 'layout' | 'animation';

const TABS: readonly SheetTab[] = [
  { id: 'layout', label: 'Layout' },
  { id: 'animation', label: 'Animation' },
];

/**
 * Where the two videos sit on the frame: split screen, a corner inset, or one over the other - and,
 * on its second tab, how that arrangement opens when the second video comes on and closes when it
 * goes.
 *
 * A layout is nothing but a pair of rectangles written onto the clips of the two layers - the same
 * `rect` the crop tool already writes, and the same one the native engines already draw - so there
 * is no geometry here at all. The presets hold it, this row shows it, and every tap goes straight
 * to the store as one undo step with the preview above showing the result.
 *
 * An animation is one choice and one length, and nothing to place: the arrangement it opens into is
 * the one on the Layout tab, and when it opens is where the second video sits on the timeline. Each
 * tile draws its move on the customer's own arrangement, and choosing one plays it on the frame.
 */
@Component({
  tag: 've-layout-sheet',
  styleUrls: ['../sheet-common.css', 've-layout-sheet.css'],
  shadow: true,
})
export class VeLayoutSheet {
  @Prop() ctx!: EditorContext;

  /** The value above the knob: `80%`, shared with the volume and opacity sliders. */
  private readonly formatPercent = percentLabel;

  /** The value above the duration knob: `0.6s`, as the animation sheet reads a length. */
  private readonly formatDuration = (ms: number): string => durationChip(ms);

  /**
   * Which tab is showing. Not `part` or `slot`, which are an element's own: under
   * `dist-custom-elements` this class IS the element, so a field by either name would replace it.
   */
  private readonly showing = signal<LayoutTab>('layout');

  private readonly watcher = new SignalWatcher(this);
  private stopClose?: () => void;

  connectedCallback() {
    const { store } = this.ctx;
    // Remove takes the second video off, and so can an undo: there is then nothing left to lay out.
    // Deferred, so the sheet is not unmounting itself part way through the undo that emptied it.
    this.stopClose = closeWhenGone(
      () => !store.layoutTrack.value,
      () => store.closePanel(),
    );
  }

  disconnectedCallback() {
    this.stopClose?.();
    this.stopClose = undefined;
    this.watcher.stop();
  }

  private readonly onConfirm = () => this.ctx.store.closePanel();

  private readonly onTab = (event: CustomEvent<string>) => {
    const tab = TABS.find(one => one.id === event.detail)?.id as LayoutTab | undefined;
    if (tab) this.showing.value = tab;
  };

  /** A tile, or None. The same tile again plays its opening again, the only way to see it twice. */
  private readonly pickAnimation = (preset: LayoutAnimationPreset | null) => {
    const track = this.ctx.store.layoutTrack.value;
    if (track) this.ctx.store.setLayoutAnimation(track.id, preset?.id ?? null);
  };

  /** Inside the slider's gesture, which is why the change is live: one drag, one undo step. */
  private readonly onDuration = (event: CustomEvent<number>) => {
    const track = this.ctx.store.layoutTrack.value;
    if (track?.layoutAnimation && event.detail !== track.layoutAnimation.durationMs) {
      this.ctx.store.setLayoutAnimationMs(track.id, event.detail, true);
    }
  };

  private readonly pick = (chip: LayoutChip) => {
    const track = this.ctx.store.layoutTrack.value;
    if (track) this.ctx.store.applyLayoutPreset(track.id, chip.id, chip.label);
  };

  /** Inside the slider's gesture, which is why the change is live: one drag, one undo step. */
  private readonly onOpacity = (event: CustomEvent<number>) => {
    const track = this.ctx.store.layoutTrack.value;
    if (!track) return;
    const opacity = event.detail / 100;
    if (opacity !== track.opacity) this.ctx.store.setTrackOpacity(track.id, opacity, true);
  };

  private readonly swap = () => {
    const track = this.ctx.store.layoutTrack.value;
    if (track) this.ctx.store.swapTrackZ(track.id);
  };

  /*
   * `removeTrack` and not `remove`. Under `dist-custom-elements` a component class IS its element,
   * so a member called `remove` replaces `HTMLElement.prototype.remove` on that element - and the
   * vdom takes a sheet off the screen by calling `elm.remove()`. Closing this sheet therefore threw
   * the second video away and left the element in the document, silently, on the tick and on every
   * other way out. It cannot happen in the lazy build, where the element is a proxy around the
   * instance, which is why no test in this package saw it. The guard for the whole class of it is
   * `build/element-members.unit.test.ts`.
   */
  private readonly removeTrack = () => {
    const track = this.ctx.store.layoutTrack.value;
    if (track) this.ctx.store.removeVideoTrack(track.id);
  };

  /**
   * Which preset the two layers are on now.
   *
   * Every clip of a layer carries that layer's rectangle, so the first one answers for the layer and
   * a layer whose clips disagree is on no preset at all.
   */
  private activePreset(): LayoutPresetId | null {
    const { store } = this.ctx;
    const track = store.layoutTrack.value;
    if (!track) return null;
    const clips = store.manifest.value.clips;
    const baseRect = clips[0]?.rect ?? null;
    const trackRect = track.clips[0]?.rect ?? null;
    if (clips.some(clip => !sameRect(clip.rect, baseRect))) return null;
    if (track.clips.some(clip => !sameRect(clip.rect, trackRect))) return null;
    return matchLayoutPreset(baseRect, trackRect, store.frameAspect.value);
  }

  render() {
    return this.watcher.run(() => {
      const track = this.ctx.store.layoutTrack.value;
      const tab = this.showing.value;

      return (
        <Host>
          <ve-sheet tabs={TABS} activeTab={tab} onVeTab={this.onTab} onVeConfirm={this.onConfirm}>
            {track ? (tab === 'animation' ? this.animationTab(track) : this.layoutTab()) : null}
          </ve-sheet>
        </Host>
      );
    });
  }

  /**
   * How the arrangement opens and closes: None and the styles, each drawn moving on the customer's
   * own arrangement, then how long the move takes.
   *
   * The chosen tile is in its NAME (`Slide, selected`) and never in `aria-pressed`: on the Samsung
   * A13's WebView (Chrome 99) a change to `aria-pressed` inside a shadow root never reaches Android's
   * accessibility tree, while a change to the name does - the animation sheet made the same move.
   */
  private animationTab(track: EditVideoTrack) {
    const store = this.ctx.store;
    const current = track.layoutAnimation ?? null;
    const output = store.output.value;
    const frame = { '--ls-frame-w': String(output.width), '--ls-frame-h': String(output.height) };
    // The arrangement as the Layout tab left it: the base's rectangle and the layer's, read off the
    // first clip of each the way the Layout tab reads which preset is lit.
    const base = store.manifest.value.clips[0]?.rect;
    const layer = track.clips[0]?.rect;
    const aspect = store.frameAspect.value;
    const ms = current?.durationMs ?? DEFAULT_LAYOUT_ANIMATION_MS;

    return (
      <div class="sheet__content ls" key="animation">
        <div class="ls__presets" role="group" aria-label="Layout animation" key="tiles">
          <button
            type="button"
            key="none"
            class={{ 'ls__preset': true, 'ls__anim': true, 'ls__preset--on': !current }}
            aria-label={current ? 'None' : 'None, selected'}
            onClick={() => this.pickAnimation(null)}
          >
            <span class="ls__frame ls__frame--none" aria-hidden="true" style={frame}>
              <ve-icon class="ls__none" name="ban-outline"></ve-icon>
            </span>
            <span class="ls__label">None</span>
          </button>
          {LAYOUT_ANIMATIONS.map(preset => {
            const on = current?.id === preset.id;
            const tile = animationTile(base, layer, preset.id, aspect);
            return (
              <button
                type="button"
                key={preset.id}
                class={{ 'ls__preset': true, 'ls__anim': true, 'ls__preset--on': on }}
                aria-label={on ? `${preset.label}, selected` : preset.label}
                onClick={() => this.pickAnimation(preset)}
              >
                <span class="ls__frame" aria-hidden="true" style={frame}>
                  <span class="ls__box ls__box--base ls__box--moving" style={tileStyle(tile.base)}></span>
                  <span class="ls__box ls__box--track ls__box--moving" style={tileStyle(tile.layer)}></span>
                </span>
                <span class="ls__label">{preset.label}</span>
              </button>
            );
          })}
        </div>

        <p class="ls__hint" key="hint">
          Opens when the second video starts and closes when it ends
        </p>

        {/*
          On None it is still there, dimmed and out of reach, so choosing a tile does not push the
          row about under the finger - and so the customer can see there is a length to set. The
          readout beside it is the number TalkBack can read: the slider arrives unnamed.
        */}
        <div class={{ 'ls__length': true, 'ls__length--off': !current }} key="length" aria-disabled={current ? undefined : 'true'}>
          <span class="ls__word">Duration</span>
          <ve-slider
            class="ls__slider"
            ctx={this.ctx}
            label="Animation duration"
            value={ms}
            min={MIN_LAYOUT_ANIMATION_MS}
            max={MAX_LAYOUT_ANIMATION_MS}
            step={LAYOUT_ANIMATION_STEP_MS}
            pin="none"
            disabled={!current}
            format={this.formatDuration}
            onVeLive={this.onDuration}
          ></ve-slider>
          <span class="ls__value" data-readout="length">
            {durationChip(ms)}
          </span>
        </div>
      </div>
    );
  }

  private layoutTab() {
    const track = this.ctx.store.layoutTrack.value;
    if (!track) return null;
    const activeId = this.activePreset();
    // Drawn for the frame the post is on: the corner insets are square in pixels, so their
    // diagrams are a different shape once the customer turns the canvas on its side.
    const chips = layoutChips(this.ctx.store.frameAspect.value);
    const output = this.ctx.store.output.value;

    return (
      <div class="sheet__content ls" key="layout">
        <div class="ls__presets" role="group" aria-label="Layout">
          {chips.map(chip => (
            <button
              type="button"
              key={chip.id}
              class={{ 'ls__preset': true, 'ls__preset--on': chip.id === activeId }}
              // A string, because the vdom drops an attribute set to boolean false and a
              // chip with no `aria-pressed` at all is announced as a plain button.
              aria-pressed={String(chip.id === activeId)}
              onClick={() => this.pick(chip)}
            >
              {/*
                The frame with both rectangles in it, so the row can be read without anyone
                having to work out what "top left" means to a video that is already on screen.
              */}
              <span class="ls__frame" aria-hidden="true" style={{ '--ls-frame-w': String(output.width), '--ls-frame-h': String(output.height) }}>
                <span class="ls__box ls__box--base" style={{ left: `${chip.base.x}%`, top: `${chip.base.y}%`, width: `${chip.base.w}%`, height: `${chip.base.h}%` }}></span>
                <span class="ls__box ls__box--track" style={{ left: `${chip.track.x}%`, top: `${chip.track.y}%`, width: `${chip.track.w}%`, height: `${chip.track.h}%` }}></span>
              </span>
              <span class="ls__label">{chip.label}</span>
            </button>
          ))}
        </div>

        <ve-slider ctx={this.ctx} value={Math.round(track.opacity * 100)} label="Opacity" format={this.formatPercent} onVeLive={this.onOpacity}></ve-slider>

        <div class="ls__actions">
          <button type="button" class="ls__action" onClick={this.swap}>
            <ve-icon name="swap-vertical-outline"></ve-icon>
            <span>Swap</span>
          </button>
          <button type="button" class="ls__action ls__action--danger" onClick={this.removeTrack}>
            <ve-icon name="trash-outline"></ve-icon>
            <span>Remove</span>
          </button>
        </div>
      </div>
    );
  }
}

/**
 * A tile's box, moving: where it is closed and where it is open, as the percentages of the little
 * frame the tile's CSS animation runs between. The animation itself is `ve-layout-sheet.css`'s, so a
 * repaint never restarts it and a frame of it never costs the vdom anything.
 */
function tileStyle(box: AnimationTile['base']): Record<string, string> {
  return {
    '--ls-x0': `${box.closed.x}%`,
    '--ls-y0': `${box.closed.y}%`,
    '--ls-w0': `${box.closed.w}%`,
    '--ls-h0': `${box.closed.h}%`,
    '--ls-x1': `${box.open.x}%`,
    '--ls-y1': `${box.open.y}%`,
    '--ls-w1': `${box.open.w}%`,
    '--ls-h1': `${box.open.h}%`,
  };
}
