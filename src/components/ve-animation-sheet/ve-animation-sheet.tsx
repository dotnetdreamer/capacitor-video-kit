import { Component, Element, Prop } from '@stencil/core';
import { signal } from '@preact/signals-core';

import { closeWhenGone } from '../../bridge/deferred-effect';
import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { stickerUrl } from '../../data/stickers';
import {
  MAX_OVERLAY_LOOP_MS,
  MAX_OVERLAY_MOVE_MS,
  MIN_OVERLAY_LOOP_MS,
  MIN_OVERLAY_MOVE_MS,
  NEUTRAL_MOTION,
  OVERLAY_ANIMATIONS,
  type OverlayAnimation,
  type OverlayAnimationPart,
  type OverlayAnimationPreset,
  type OverlayKind,
} from '../../editor';
import type { EditorIconName } from '../../icons/icons';
import { computedWith } from '../../state/computed-with';
import type { SheetTab } from '../sheet.types';
import { durationChip } from '../ve-timeline/timeline-geometry';
import { animationChoices, animationTabs, openingPart, tileDemo, tileGlyph, tilePoseAt, tileStyle, type TileDemo } from './animation-tiles';

/**
 * The box the layer is fitted into on a tile, in CSS px: most of the 64 px frame's width, so a
 * caption is a line that can still be read, and a little over half its height, which is what a square
 * sticker comes to and leaves a move room around it.
 */
const GLYPH_BOX = { w: 48, h: 36 };
/** The tile's frame, in CSS px: the transition sheet's tile, so the two rows are one row. */
const TILE_PX = 64;
/**
 * The tiles move about thirty times a second. They are 64 px across, where sixty is not visible, and
 * the second half of that work would be the phone's while its preview is playing the same move.
 */
const ANIMATE_EVERY_MS = 32;
/** The slider's step: a tenth of a second, which is also what the readout shows. */
const STEP_MS = 100;
/**
 * The Speed slider runs the other way from the period it sets - right is FASTER, a shorter cycle -
 * so its units are this minus the period, and the ends stay the loop's own range.
 */
const LOOP_UNITS = MIN_OVERLAY_LOOP_MS + MAX_OVERLAY_LOOP_MS;
/** No layer, no tabs: made once, because a new array per render is a changed prop to the frame. */
const NO_TABS: readonly SheetTab[] = [];

/** What a layer is drawn as on the tiles. */
type TileGlyph =
  /** Its own bitmap - the text in its font, the sticker, the photo - or a picture file standing in. */
  | { kind: 'picture'; src: string; w: number; h: number }
  /** An emoji, or the letters a text layer stands in for until its bitmap is drawn. */
  | { kind: 'word'; text: string }
  | { kind: 'icon'; name: EditorIconName };

/** The selected layer, as far as this sheet reads it. */
interface AnimatedLayer {
  id: string;
  kind: OverlayKind;
  animation: OverlayAnimation | null;
}

/**
 * The Animation tool: CapCut's In / Out / Loop picker for the selected layer. A row of tiles under the
 * frame's three tabs, None first, and under them how long the move takes - or, on Loop, how fast it
 * goes.
 *
 * Every tile is the customer's OWN layer making that move - the text in its font, the sticker itself -
 * because a picker of labels asks them to imagine a slam on their caption, and this one shows it. The
 * moves are the render's: each tile compiles its preset with the render's compiler and reads it back
 * through the same `overlayMotionAt` the preview and the web engine read the export's keys with (see
 * `animation-tiles.ts`), so what a tile does is what the file will do. They loop, all of them, the
 * chosen one at the length the slider says.
 *
 * Nothing here decides anything. A tile is `chooseAnimation`, None is `removeAnimation`, the slider is
 * `setAnimationMs`: the store plays the move on the frame - the layer arriving, leaving, or a few
 * cycles of its loop - and folds the whole visit into one undo step, as the transition sheet does,
 * because trying six entrances before settling on one is one decision.
 *
 * The chosen tile is in its NAME (`Pop, selected`) and never in `aria-pressed`: on the Samsung A13's
 * WebView (Chrome 99) a change to `aria-pressed` inside a shadow root never reaches Android's
 * accessibility tree, while a change to the name does - the transition sheet's tiles and the zoom
 * sheet's chips made the same move. The slider sits between a visible word and a visible readout,
 * because a slider reaches Android's tree with no name of its own.
 *
 * The tiles move outside the vdom, as the preview's layers do: a repaint is a diff of fourteen
 * buttons, and a move is two style writes per tile per frame, done by a `requestAnimationFrame` pump
 * straight onto the glyphs. No `IntersectionObserver`, which is where this differs from the
 * transition sheet: a tile here costs a transform on a composited image, not a GPU draw, and the few
 * scrolled out of sight cost less than watching them would.
 */
@Component({
  tag: 've-animation-sheet',
  styleUrls: ['../sheet-common.css', 've-animation-sheet.css'],
  shadow: true,
})
export class VeAnimationSheet {
  @Prop() ctx!: EditorContext;

  @Element() el!: HTMLElement;

  private readonly watcher = new SignalWatcher(this);
  private stopClosing?: () => void;

  /**
   * Which of the layer's three moves the row is showing. Set from the layer's own on the way in.
   *
   * Not `part`, which is what the store and the manifest call one of the three: an element already
   * has a `part` - the `::part()` token list - and under `dist-custom-elements` this class IS the
   * element, so a field by that name would replace it.
   */
  private readonly showing = signal<OverlayAnimationPart>('in');

  /**
   * The selected layer, as the three things this sheet shows of it. A drag or a pinch on the preview
   * rewrites the layer on every frame and none of the three, and an animation the ops did not touch
   * is the same object (see `normaliseOverlayAnimation`), so the sheet sits still through a drag.
   */
  private readonly layer = computedWith<AnimatedLayer | null>(
    () => {
      const overlay = this.ctx.store.selectedOverlay.value;
      return overlay ? { id: overlay.id, kind: overlay.kind, animation: overlay.animation ?? null } : null;
    },
    (a, b) => a === b || (!!a && !!b && a.id === b.id && a.kind === b.kind && a.animation === b.animation),
  );

  /**
   * What the tiles draw the layer as: its own bitmap once there is one, and until then the nearest
   * thing to it that needs no drawing. Compared by what it shows, so a pinch - a new overlay object
   * per frame and, when it lands, a new bitmap of the same picture at a new size - repaints the row
   * once, when the picture really changes.
   */
  private readonly glyph = computedWith<TileGlyph | null>(() => {
    const store = this.ctx.store;
    const overlay = store.selectedOverlay.value;
    if (!overlay) return null;
    const bitmap = store.bitmaps.value.get(overlay.id);
    if (bitmap && bitmap.wPx > 0 && bitmap.hPx > 0) return { kind: 'picture', src: bitmap.png, w: bitmap.wPx, h: bitmap.hPx };
    switch (overlay.kind) {
      case 'text':
        return { kind: 'word', text: 'Aa' };
      case 'sticker':
        if (overlay.emoji) return { kind: 'word', text: overlay.emoji };
        return pictureOrIcon(overlay.assetId ? () => stickerUrl(overlay.assetId as string) : null, 'happy');
      case 'image':
        return pictureOrIcon(overlay.uri ? () => store.host.platform.fileUrl(overlay.uri) : null, 'image');
      case 'effect':
        return { kind: 'icon', name: 'sparkles' };
    }
  }, sameGlyph);

  /* -- the tiles' motion (plain fields: read and written per frame) -------------------------- */

  /** The glyphs of the row on screen, gathered after each render. */
  private glyphEls: HTMLElement[] = [];
  /** Each tile's demonstration, by `part|id|ms|kind`, compiled once and kept while the sheet is open. */
  private readonly demos = new Map<string, TileDemo>();
  /** Tile px per frame width and height, for the offsets; see [tileGlyph]. */
  private reach = { x: 0, y: 0 };
  /** When the tiles' passes began: every tile starts again together when a tile is chosen. */
  private epoch = 0;
  private lastDraw = 0;
  private rafId = 0;
  private destroyed = false;
  private readonly still = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  /**
   * The system's motion setting changing while the sheet is open. Asked for less, the next frame of
   * the pump puts every tile at rest and stops; allowed again, only this starts the pump back up.
   */
  private readonly onMotionSetting = () => this.schedule();

  private row?: HTMLElement;
  /** Answered by the next render: the chosen tile is brought to the middle of the row. */
  private centrePending = false;

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed value to
   * the vdom, and a `format` rebuilt on every repaint would re-render the slider under the finger,
   * which is every repaint of a drag.
   */
  private readonly keepRow = (el?: HTMLElement) => {
    this.row = el;
  };

  private readonly formatDuration = (ms: number): string => durationChip(ms);

  private readonly formatSpeed = (units: number): string => durationChip(LOOP_UNITS - units);

  private readonly onConfirm = () => this.ctx.store.closePanel();

  private readonly onTab = (event: CustomEvent<string>) => {
    const layer = this.layer.value;
    const part = layer ? animationTabs(layer.kind).find(tab => tab.id === event.detail)?.id : undefined;
    if (!part || part === this.showing.value) return;
    this.showing.value = part as OverlayAnimationPart;
    // A new tab is a new row: it opens on its own choice, or at its first tile.
    if (this.row) this.row.scrollLeft = 0;
    this.centrePending = true;
  };

  private readonly onNone = () => this.ctx.store.removeAnimation(this.showing.value);

  /** Inside the slider's gesture, which the store's history group folds into the visit's one step. */
  private readonly onLength = (event: CustomEvent<number>) => {
    const part = this.showing.value;
    this.ctx.store.setAnimationMs(part, part === 'loop' ? LOOP_UNITS - event.detail : event.detail, true);
  };

  /* ========================================================================================= */
  /* Lifecycle                                                                                 */
  /* ========================================================================================= */

  connectedCallback() {
    // Everything `disconnectedCallback` took away is put back here and not in `componentDidLoad`,
    // which Stencil does not call a second time when it re-attaches an element it has moved.
    this.destroyed = false;
    this.still?.addEventListener('change', this.onMotionSetting);
    // Undo can take the layer away, and Delete on the timeline can too; either way there is nothing
    // left to animate and the sheet goes. Deferred, because closing the panel unmounts this element
    // and would otherwise be doing it from inside the undo that emptied the selection.
    this.stopClosing = closeWhenGone(
      () => !this.ctx.store.selectedOverlay.value,
      () => this.ctx.store.closePanel(),
    );
  }

  componentWillLoad() {
    const layer = this.layer.value;
    if (layer) this.showing.value = openingPart(layer.kind, layer.animation);
    this.epoch = performance.now();
  }

  componentDidLoad() {
    this.centreChosen();
  }

  componentDidRender() {
    if (this.centrePending) {
      this.centrePending = false;
      this.centreChosen();
    }
    this.glyphEls = [...(this.el.shadowRoot?.querySelectorAll<HTMLElement>('.an__glyph') ?? [])];
    // The vdom never writes a glyph's transform, so a glyph it has just made is at rest until the
    // pump's next frame: this puts every tile where its pass is NOW, before that frame is painted.
    this.lastDraw = 0;
    this.draw(performance.now());
    this.schedule();
  }

  disconnectedCallback() {
    this.destroyed = true;
    this.watcher.stop();
    this.stopClosing?.();
    this.stopClosing = undefined;
    this.still?.removeEventListener('change', this.onMotionSetting);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.glyphEls = [];
    this.demos.clear();
  }

  /* ========================================================================================= */
  /* Choosing                                                                                  */
  /* ========================================================================================= */

  /** The same tile again plays it again on the frame, which is the only way to see it twice. */
  private choose(preset: OverlayAnimationPreset): void {
    this.ctx.store.chooseAnimation(this.showing.value, preset.id);
    // Every tile from the start of its pass, so the one just chosen is seen from its first frame.
    this.epoch = performance.now();
  }

  /** Puts the chosen tile in the middle of the row, like the transition and filter sheets do. */
  private centreChosen(): void {
    const row = this.row;
    const on = this.el.shadowRoot?.querySelector<HTMLElement>('.an__tile--on');
    if (!row || !on) return;
    row.scrollLeft = Math.max(0, on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2);
  }

  /* ========================================================================================= */
  /* The tiles' motion                                                                         */
  /* ========================================================================================= */

  private schedule(): void {
    if (!this.rafId && !this.destroyed && this.glyphEls.length > 0) this.rafId = requestAnimationFrame(this.pump);
  }

  /**
   * One frame of the tiles, about thirty times a second, for as long as the sheet is open. A customer
   * who has asked the system for less motion gets every tile at rest - the layer as it will look once
   * it has arrived - and the pump stops until the setting changes.
   */
  private readonly pump = (now: number): void => {
    this.rafId = 0;
    if (this.destroyed) return;
    const still = !!this.still?.matches;
    // The last frame before the pump stops is drawn whenever it falls, due or not: it is the one
    // that puts every tile at rest, and skipped it would leave them wherever their passes had got to.
    if (still || now - this.lastDraw >= ANIMATE_EVERY_MS) this.draw(now);
    if (!still) this.schedule();
  };

  private draw(now: number): void {
    this.lastDraw = now;
    const still = !!this.still?.matches;
    for (const el of this.glyphEls) {
      const demo = this.demoFor(el);
      const pose = still || !demo ? NEUTRAL_MOTION : tilePoseAt(demo, now - this.epoch);
      const { transform, opacity } = tileStyle(pose, this.reach);
      if (el.style.transform !== transform) el.style.transform = transform;
      if (el.style.opacity !== opacity) el.style.opacity = opacity;
    }
  }

  /**
   * A glyph's demonstration, from what its tile says it is. Read off the element rather than kept
   * beside it, because a tile keyed `fade` is the same button on the In tab and the Out tab, and the
   * slider changes the chosen tile's length without making it a new element.
   */
  private demoFor(el: HTMLElement): TileDemo | null {
    const { part, move, ms, kind } = el.dataset;
    if (!part || !move || !ms || !kind) return null;
    const key = `${part}|${move}|${ms}|${kind}`;
    let demo = this.demos.get(key);
    if (!demo) {
      demo = tileDemo(part as OverlayAnimationPart, move, Number(ms), kind as OverlayKind);
      this.demos.set(key, demo);
    }
    return demo;
  }

  /* ========================================================================================= */
  /* Render                                                                                    */
  /* ========================================================================================= */

  render() {
    return this.watcher.run(() => {
      const layer = this.layer.value;
      const part = this.showing.value;
      const glyph = this.glyph.value;
      const output = this.ctx.store.output.value;

      // The glyph's box, and how far a move carries it, from the layer's size on the frame. An
      // effect IS the frame, and fills the tile instead.
      const fit = tileGlyph(glyph?.kind === 'picture' && layer?.kind !== 'effect' ? { w: glyph.w, h: glyph.h } : null, output, GLYPH_BOX);
      this.reach = fit.reach;

      return (
        <ve-sheet tabs={layer ? animationTabs(layer.kind) : NO_TABS} activeTab={part} onVeTab={this.onTab} onVeConfirm={this.onConfirm}>
          {layer && glyph ? (
            <div class="an" key="animation">
              {/* Every child keyed: the body is conditional, and the vdom pairs unkeyed siblings by position. */}
              <div class="an__row" key="row" ref={this.keepRow}>
                {this.noneTile(!layer.animation?.[part])}
                {animationChoices(layer.kind, part).map(preset => this.tile(layer, part, preset, glyph, fit))}
              </div>
              {this.lengthRow(layer, part)}
            </div>
          ) : null}
        </ve-sheet>
      );
    });
  }

  /**
   * None, first in every row as it is in CapCut's: this part of the animation taken off, the rest
   * left as they are. A tile rather than the frame's own None in the head, because a sheet with three
   * tabs has three things a head button could mean, and a tile in the row means the one on screen.
   */
  private noneTile(on: boolean) {
    return (
      <button type="button" key="none" class={{ 'an__tile': true, 'an__tile--none': true, 'an__tile--on': on }} aria-label={on ? 'None, selected' : 'None'} onClick={this.onNone}>
        <span class="an__frame">
          <ve-icon class="an__none" name="ban-outline"></ve-icon>
        </span>
        <span class="an__label">None</span>
      </button>
    );
  }

  private tile(layer: AnimatedLayer, part: OverlayAnimationPart, preset: OverlayAnimationPreset, glyph: TileGlyph, fit: { w: number; h: number }) {
    const current = layer.animation?.[part];
    const on = current?.id === preset.id;
    // The chosen tile moves at the layer's own length, so the slider shows on it as it is dragged;
    // the rest at the length a tap would give them, which is each preset's own.
    const ms = on && current ? lengthOf(current) : preset.defaultMs;
    return (
      <button
        type="button"
        key={preset.id}
        class={{ 'an__tile': true, 'an__tile--on': on }}
        aria-label={on ? `${preset.label}, selected` : preset.label}
        onClick={() => this.choose(preset)}
      >
        <span class={{ 'an__frame': true, 'an__frame--fill': layer.kind === 'effect' }}>
          {/*
            The glyph's transform and opacity are the pump's and never the vdom's: nothing here
            writes a style on it, so a repaint cannot put a moving tile back at rest.
          */}
          <span class="an__glyph" data-part={part} data-move={preset.id} data-ms={String(ms)} data-kind={layer.kind}>
            {glyphContent(glyph, layer.kind === 'effect' ? { w: TILE_PX, h: TILE_PX } : fit)}
          </span>
        </span>
        <span class="an__label">{preset.label}</span>
      </button>
    );
  }

  /**
   * How long the move takes, or on Loop how fast it goes, from the shortest worth drawing to the
   * longest that still reads as the move.
   *
   * On None it is still there, dimmed and out of reach, so choosing a tile does not push the row down
   * under the finger - and so the customer can see there is a length to set. Out of reach is the
   * transition sheet's: `pointer-events: none` on the row, the slider's own `disabled`, and
   * `aria-disabled` on the row - never `inert`, which Chrome 99 ignores and a current WebView answers
   * by taking the readout out of the accessibility tree.
   *
   * Speed runs right for faster, which is the way a customer reaches for it, while its readout is
   * the cycle in seconds, the unit Duration is read in and the one a template is written in.
   */
  private lengthRow(layer: AnimatedLayer, part: OverlayAnimationPart) {
    const current = layer.animation?.[part] ?? null;
    const loop = part === 'loop';
    // On None, the length the first tile would start at, so the number does not jump when it is tapped.
    const ms = current ? lengthOf(current) : (animationChoices(layer.kind, part)[0] ?? OVERLAY_ANIMATIONS[part][0]).defaultMs;
    return (
      <div class={{ 'an__length': true, 'an__length--off': !current }} key="length" aria-disabled={current ? undefined : 'true'}>
        <span class="an__word">{loop ? 'Speed' : 'Duration'}</span>
        <ve-slider
          class="an__slider"
          ctx={this.ctx}
          label={loop ? 'Animation speed' : 'Animation duration'}
          value={loop ? LOOP_UNITS - ms : ms}
          min={loop ? MIN_OVERLAY_LOOP_MS : MIN_OVERLAY_MOVE_MS}
          max={loop ? MAX_OVERLAY_LOOP_MS : MAX_OVERLAY_MOVE_MS}
          step={STEP_MS}
          pin="none"
          disabled={!current}
          format={loop ? this.formatSpeed : this.formatDuration}
          onVeLive={this.onLength}
        />
        {/* The number a test can read, and the one TalkBack can: the slider arrives unnamed. */}
        <span class="an__value" data-readout="length">
          {durationChip(ms)}
        </span>
      </div>
    );
  }
}

/** An in's or an out's length, or a loop's period: the one number each part has. */
function lengthOf(move: NonNullable<OverlayAnimation[OverlayAnimationPart]>): number {
  return 'periodMs' in move ? move.periodMs : move.durationMs;
}

/** The glyph's own markup, in a `w` x `h` box: a picture sized to it, or a word or an icon. */
function glyphContent(glyph: TileGlyph, box: { w: number; h: number }) {
  switch (glyph.kind) {
    case 'picture':
      return <img class="an__picture" src={glyph.src} alt="" draggable={false} style={{ width: `${Math.round(box.w)}px`, height: `${Math.round(box.h)}px` }} />;
    case 'word':
      return <span class="an__word-glyph">{glyph.text}</span>;
    case 'icon':
      return <ve-icon class="an__icon" name={glyph.name}></ve-icon>;
  }
}

/**
 * A picture file for a layer with no bitmap yet, or its kind's glyph when there is none to be had: a
 * sticker whose asset base nobody has set throws rather than naming a URL that would 404.
 */
function pictureOrIcon(url: (() => string) | null, fallback: EditorIconName): TileGlyph {
  try {
    const src = url?.();
    if (src) return { kind: 'picture', src, w: 0, h: 0 };
  } catch {
    /* No asset base: the glyph instead. */
  }
  return { kind: 'icon', name: fallback };
}

function sameGlyph(a: TileGlyph | null, b: TileGlyph | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'picture':
      return b.kind === 'picture' && a.src === b.src && a.w === b.w && a.h === b.h;
    case 'word':
      return b.kind === 'word' && a.text === b.text;
    case 'icon':
      return b.kind === 'icon' && a.name === b.name;
  }
}
