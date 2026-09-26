import { Component, Element, Prop } from '@stencil/core';
import { effect, signal } from '@preact/signals-core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import { EFFECT_CATEGORIES, EFFECT_PRESETS, drawEffect, slotAt, sourceMsAt, type EffectPreset } from '../../editor';
import { debugWarn } from '../../host/debug';
import type { SheetTab } from '../sheet.types';

const TRENDING = 'trending';
/** How many of each category the Trending tab borrows. */
const TRENDING_PER_CATEGORY = 2;

/** Trending, then one tab per category. Fixed for the life of the build, so it is built once. */
const TABS: readonly SheetTab[] = [{ id: TRENDING, label: 'Trending' }, ...EFFECT_CATEGORIES];

/** The preview is drawn as a 9:16 frame, the shape of the video, and fitted into the square cell. */
const THUMB_W = 90;
const THUMB_H = 160;
/**
 * The 64px cell shows the middle 64 CSS px of the 90-wide frame, so at the test phone's density
 * (2.75) a 1:1 canvas would be stretched almost 2x and a frame effect's thin lines would go soft.
 * The canvas gets that many device pixels instead - capped at 2x, which is sharp enough at this
 * size - and `drawEffect` reads the scale off the context and draws at it.
 */
const THUMB_SCALE = Math.max(1, Math.min(2, ((globalThis.devicePixelRatio || 1) * 64) / THUMB_W));
const THUMB_PX_W = Math.round(THUMB_W * THUMB_SCALE);
const THUMB_PX_H = Math.round(THUMB_H * THUMB_SCALE);
/** The cell in the grid is 64 CSS px square; its canvas gets those pixels at up to 2x. */
const CELL_PX = Math.round(64 * Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1)));

/**
 * The presets outside the Frames category that are drawn entirely at the frame's edges: their black
 * bars run along the top and the bottom, which is exactly what a square crop takes away.
 */
const BAR_IDS: readonly string[] = ['cinema', 'letterbox'];

/**
 * The effects whose whole point is what they draw at the FRAME'S EDGES: the film strip's sprocket
 * bands, the polaroid's card, the viewfinder's corners, the cinema bars. Cropping a 9:16 frame to a
 * square cell cuts those edges off - on the phone, the film strip's bands were a dark sliver and the
 * polaroid's card was gone - so their previews show the whole frame instead, letterboxed in the cell.
 */
const EDGE_EFFECT_IDS = new Set(EFFECT_PRESETS.filter(preset => preset.category === 'frame' || BAR_IDS.includes(preset.id)).map(preset => preset.id));

/** Finished thumbnails kept, by effect and frame: two frames' worth of the whole catalogue. */
const THUMB_CACHE_MAX = 40;
const FRAME_CACHE_MAX = 24;
/** Per-frame drawing budget, so opening the sheet never stalls the playhead or a scroll. */
const DRAW_BUDGET_MS = 8;
/** A scrub crosses many filmstrip frames; the thumbnails follow once it settles. */
const FRAME_SETTLE_MS = 150;

interface ThumbState {
  visible: boolean;
  /** `effectId|frameUrl` the canvas currently shows. */
  drawnKey: string | null;
}

/**
 * The Effects tool: TikTok's compact effect picker - search, none, category tabs, and a grid of
 * previews - over a slim timeline, so the customer watches the effect land on their own video.
 *
 * A tap with no effect layer selected adds one from the playhead to the end and selects it; a tap
 * while an effect layer is selected swaps that layer's effect. The sheet stays open either way, so
 * trying one look after another is a row of taps, each its own undo step.
 *
 * Each preview is the customer's own frame under the playhead with the effect drawn over it by the
 * same `drawEffect` the rasteriser uses, so the thumbnail is an honest picture of the result.
 *
 * The previews live outside the vdom on purpose. A repaint is a diff of forty buttons; a preview is
 * a decode and two `drawImage` calls, so they are drawn onto their canvases by a budgeted rAF pump
 * keyed by `effectId|frameUrl` and only the cells an `IntersectionObserver` says are on screen are
 * ever drawn at all.
 */
@Component({
  tag: 've-effects-sheet',
  styleUrls: ['../sheet-common.css', 've-effects-sheet.css'],
  shadow: true,
})
export class VeEffectsSheet {
  @Prop() ctx!: EditorContext;

  @Element() el!: HTMLElement;

  private readonly watcher = new SignalWatcher(this);

  /** The category on screen, or Trending. Ignored while there is something in the search field. */
  private readonly tab = signal<string>(TRENDING);

  /** The search text. The frame owns the field and hands the text back, so this is what clears it. */
  private readonly query = signal('');

  private sheet?: HTMLVeSheetElement;

  /* -- thumbnails -------------------------------------------------------------------------- */

  /**
   * The filmstrip frame under the playhead, or null for the dark stand-in.
   *
   * A plain field rather than a signal, which is where this differs from the Angular sheet. Nothing
   * renders it: the canvases are drawn by hand, so the only readers are [keyFor] and the pump. The
   * second Angular effect existed solely to turn a write here into a redraw, and with one writer
   * that is a line inside [applyFrame] instead of an effect that would fire, synchronously, in the
   * middle of the effect above it.
   */
  private frame: string | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;

  private observer: IntersectionObserver | null = null;
  private readonly tracked = new Map<HTMLCanvasElement, ThumbState>();
  private readonly queue = new Set<HTMLCanvasElement>();
  private readonly rendered = new Map<string, HTMLCanvasElement>();
  /** Decoded frames by URL; null when one could not be loaded. */
  private readonly frames = new Map<string, HTMLImageElement | null>();
  private readonly loadingFrames = new Set<string>();
  private rafId = 0;
  private destroyed = false;

  /** False until the frame's scrolling body has been found, which is the observer's root. */
  private started = false;

  /** Whether this element has ever finished loading, which decides what a re-attach has to redo. */
  private loaded = false;

  private stopPlayhead?: () => void;

  connectedCallback() {
    const { store } = this.ctx;
    /*
     * Everything `disconnectedCallback` took away is put back here and not in `componentDidLoad`,
     * which Stencil does not call a second time when it re-attaches an element it has moved. Left
     * out, a moved sheet keeps `destroyed` and draws nothing again, ever, without a word.
     */
    this.destroyed = false;
    if (this.loaded) void this.findBody();
    /*
     * Follow the playhead only while paused: a playing video would redraw every preview once a
     * second while the decoder is busy with the preview itself.
     *
     * A real effect rather than `componentDidRender`, because the render reads nothing of the
     * playhead and never would. Reading `playing` FIRST and returning is what makes that
     * affordable: an effect subscribes to exactly what it read, so while the video plays this
     * watches one boolean and sleeps through the thirty playhead writes a second. Turned around, it
     * would wake on every one of them.
     */
    this.stopPlayhead = effect(() => {
      if (store.playing.value) return;
      this.setFrame(this.frameUrlAt(store.playheadMs.value));
    });
  }

  componentDidLoad() {
    this.loaded = true;
    void this.findBody();
  }

  componentDidRender() {
    // Before the body has been found there is no observer to hand the cells to, and [findBody] does
    // this first pass itself once there is.
    if (this.started) this.syncThumbs();
  }

  disconnectedCallback() {
    this.destroyed = true;
    this.watcher.stop();
    this.stopPlayhead?.();
    this.stopPlayhead = undefined;
    this.observer?.disconnect();
    this.observer = null;
    // With no observer there is no root to decide what is on screen, so a render is not allowed to
    // start tracking cells again until [findBody] has built another one.
    this.started = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.queue.clear();
    this.tracked.clear();
    this.rendered.clear();
    this.frames.clear();
    this.loadingFrames.clear();
  }

  /* ========================================================================================= */
  /* Chrome                                                                                    */
  /* ========================================================================================= */

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed value
   * to the vdom, and a listener that changes identity is taken off and put back on every repaint.
   */
  private readonly keepSheet = (el?: HTMLVeSheetElement) => {
    this.sheet = el;
  };

  private readonly onTab = (event: CustomEvent<string>) => {
    this.tab.value = event.detail;
    // A tab is a way back out of a search.
    this.query.value = '';
    this.scrollToTop();
  };

  private readonly onSearch = (event: CustomEvent<string>) => {
    this.query.value = event.detail;
    this.scrollToTop();
  };

  /** None removes the selected effect layer; with no effect selected there is nothing to undo, so it closes. */
  private readonly onNone = () => {
    const { store } = this.ctx;
    if (store.selectedOverlay.value?.kind === 'effect') store.deleteSelectedOverlay();
    else this.close();
  };

  private readonly onConfirm = () => this.close();

  private close(): void {
    // The search field is the one thing in this sheet that can be holding a keyboard up, and it is
    // in the frame's shadow root, where the old `document.activeElement.blur()` reaches only the
    // outermost host - which drops the keyboard by taking the focus off the whole editor.
    void this.sheet?.blurSearch();
    this.ctx.store.closePanel();
  }

  private choose(preset: EffectPreset): void {
    const { store } = this.ctx;
    const overlay = store.selectedOverlay.value;
    if (overlay?.kind === 'effect') {
      if (overlay.effectId === preset.id) return;
      store.commitOverlay(overlay.id, { effectId: preset.id }, 'Effect');
      store.haptic('selection');
      return;
    }
    store.addEffect(preset.id, preset.label);
  }

  /** A new grid starts at the top: a tab switch that kept the scroll would open part way down it. */
  private scrollToTop(): void {
    void this.sheet?.scrollBodyTo(0);
  }

  /** What the grid shows: search results across every category, or the active tab. */
  private presetsFor(query: string, tab: string): EffectPreset[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      return EFFECT_PRESETS.filter(preset => {
        const label = preset.label.toLowerCase();
        return words.every(word => label.includes(word));
      });
    }
    if (tab === TRENDING) {
      return EFFECT_CATEGORIES.flatMap(category => EFFECT_PRESETS.filter(preset => preset.category === category.id).slice(0, TRENDING_PER_CATEGORY));
    }
    return EFFECT_PRESETS.filter(preset => preset.category === tab);
  }

  /* ========================================================================================= */
  /* Thumbnails                                                                                */
  /* ========================================================================================= */

  /**
   * The frame's scrolling body, which is the observer's root: a cell is "visible" when it is inside
   * the sheet's own scroller, not when it is inside the window.
   *
   * It is in `ve-sheet`'s shadow root, so it is asked for rather than walked to. The Angular sheet
   * climbed from the grid to the first ancestor with an overflow, "found by behaviour, not by the
   * frame's class names", and a walk stops dead at a shadow boundary.
   */
  private async findBody(): Promise<void> {
    const body = (await this.sheet?.bodyElement()) ?? null;
    if (this.destroyed) return;
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(entries => this.onThumbEntries(entries), {
        root: body,
        // One more row below the fold, so it is ready by the time a scroll reveals it.
        rootMargin: '96px 0px',
      });
    }
    this.started = true;
    this.syncThumbs();
  }

  /**
   * Observes the canvases the grid has now and forgets the ones a tab switch or a search removed.
   *
   * Angular ran this after a render that had actually changed the list. `componentDidRender` runs
   * after every repaint, and a drag on the preview repaints this sheet sixty times a second through
   * `selectedOverlay`, so the re-enqueue at the end is gated on the grid having really changed. The
   * pump would otherwise be woken for a frame by every one of those repaints.
   */
  private syncThumbs(): void {
    const canvases = [...(this.el.shadowRoot?.querySelectorAll<HTMLCanvasElement>('canvas.fx__canvas') ?? [])];
    const current = new Set(canvases);
    let changed = false;

    for (const canvas of [...this.tracked.keys()]) {
      if (current.has(canvas)) continue;
      this.observer?.unobserve(canvas);
      this.tracked.delete(canvas);
      this.queue.delete(canvas);
      changed = true;
    }

    for (const canvas of canvases) {
      if (this.tracked.has(canvas)) continue;
      // The backing store is sized here and not in the JSX, because writing `width` or `height`
      // clears a canvas: a repaint that rewrote either would blank a cell while `drawnKey` still
      // said it had been drawn, and nothing would ever draw it again.
      canvas.width = CELL_PX;
      canvas.height = CELL_PX;
      // Without an observer nothing will ever report a cell as visible, so they all are, which is
      // the branch the Angular sheet wrote out in full.
      this.tracked.set(canvas, { visible: !this.observer, drawnKey: null });
      if (this.observer) this.observer.observe(canvas);
      else this.enqueue(canvas);
      changed = true;
    }

    // A cell kept across a tab switch can now show a different effect in place, which is why every
    // visible cell is offered and not only the new ones. `enqueue` drops the ones already drawn.
    if (changed) this.requeueVisible();
  }

  private onThumbEntries(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const canvas = entry.target as HTMLCanvasElement;
      const state = this.tracked.get(canvas);
      if (!state) continue;
      state.visible = entry.isIntersecting;
      if (state.visible) this.enqueue(canvas);
    }
  }

  private requeueVisible(): void {
    for (const [canvas, state] of this.tracked) if (state.visible) this.enqueue(canvas);
  }

  private enqueue(canvas: HTMLCanvasElement): void {
    const state = this.tracked.get(canvas);
    if (!state || state.drawnKey === this.keyFor(canvas)) return;
    this.queue.add(canvas);
    if (!this.rafId && !this.destroyed) {
      this.rafId = requestAnimationFrame(() => this.pump());
    }
  }

  private keyFor(canvas: HTMLCanvasElement): string {
    return `${canvas.dataset.effect ?? ''}|${this.frame ?? ''}`;
  }

  /** The nearest filmstrip frame to the source time under `outputMs`. */
  private frameUrlAt(outputMs: number): string | null {
    const { store } = this.ctx;
    const slot = slotAt(store.manifest.value, outputMs);
    if (!slot) return null;
    const strip = store.filmstrips.value.get(slot.clip.clipKey);
    if (!strip?.urls.length) return null;
    const index = Math.round(sourceMsAt(slot, outputMs) / Math.max(1, strip.stepMs));
    return strip.urls[Math.max(0, Math.min(strip.urls.length - 1, index))] ?? null;
  }

  /** The first frame applies at once; later changes wait for a scrub to settle. */
  private setFrame(url: string | null): void {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
    if (url === this.frame) return;
    if (!this.tracked.size || this.drawnCount() === 0) {
      this.applyFrame(url);
      return;
    }
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.applyFrame(url);
    }, FRAME_SETTLE_MS);
  }

  private applyFrame(url: string | null): void {
    this.frame = url;
    this.requeueVisible();
  }

  private drawnCount(): number {
    let count = 0;
    for (const state of this.tracked.values()) if (state.drawnKey) count++;
    return count;
  }

  /** Draws queued thumbnails until the frame's budget runs out, then carries on next frame. */
  private pump(): void {
    this.rafId = 0;
    if (this.destroyed) return;
    const started = performance.now();
    const url = this.frame;

    for (const canvas of this.queue) {
      if (performance.now() - started > DRAW_BUDGET_MS) break;
      this.queue.delete(canvas);
      const state = this.tracked.get(canvas);
      const effectId = canvas.dataset.effect;
      if (!state?.visible || !effectId) continue;
      const key = `${effectId}|${url ?? ''}`;
      if (state.drawnKey === key) continue;

      let thumb = this.rendered.get(key);
      if (!thumb) {
        const frame = url ? this.frames.get(url) : null;
        if (url && frame === undefined) {
          // Drawn when the frame has decoded; see loadFrame.
          this.loadFrame(url);
          continue;
        }
        thumb = this.renderThumb(effectId, frame ?? null);
        this.remember(key, thumb);
      }

      const g = canvas.getContext('2d');
      if (!g) continue;
      g.clearRect(0, 0, canvas.width, canvas.height);
      drawIntoCell(g, thumb, canvas.width, canvas.height, EDGE_EFFECT_IDS.has(effectId));
      state.drawnKey = key;
    }

    if (this.queue.size && !this.rafId) {
      this.rafId = requestAnimationFrame(() => this.pump());
    }
  }

  private loadFrame(url: string): void {
    if (this.loadingFrames.has(url)) return;
    this.loadingFrames.add(url);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    const settle = (ok: boolean): void => {
      this.loadingFrames.delete(url);
      if (this.destroyed) return;
      this.frames.set(url, ok ? img : null);
      while (this.frames.size > FRAME_CACHE_MAX) {
        const oldest = this.frames.keys().next().value;
        if (oldest === undefined) break;
        this.frames.delete(oldest);
      }
      if (url === this.frame) this.requeueVisible();
    };
    img.decode().then(
      () => settle(true),
      () => settle(img.complete && img.naturalWidth > 0),
    );
  }

  /** The frame cover-cropped into 9:16, or a dark gradient without one, and the effect over it. */
  private renderThumb(effectId: string, frame: HTMLImageElement | null): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_PX_W;
    canvas.height = THUMB_PX_H;
    const g = canvas.getContext('2d');
    if (!g) return canvas;
    // Everything below is drawn in the 90x160 frame's own units.
    g.setTransform(THUMB_PX_W / THUMB_W, 0, 0, THUMB_PX_H / THUMB_H, 0, 0);

    if (frame && frame.naturalWidth > 0 && frame.naturalHeight > 0) {
      const scale = Math.max(THUMB_W / frame.naturalWidth, THUMB_H / frame.naturalHeight);
      const sw = THUMB_W / scale;
      const sh = THUMB_H / scale;
      g.drawImage(frame, (frame.naturalWidth - sw) / 2, (frame.naturalHeight - sh) / 2, sw, sh, 0, 0, THUMB_W, THUMB_H);
    } else {
      const gradient = g.createLinearGradient(0, 0, THUMB_W, THUMB_H);
      gradient.addColorStop(0, '#4a4a52');
      gradient.addColorStop(1, '#121214');
      g.fillStyle = gradient;
      g.fillRect(0, 0, THUMB_W, THUMB_H);
    }

    g.save();
    try {
      drawEffect(g, effectId, THUMB_W, THUMB_H);
    } catch (error) {
      debugWarn('[ve-effects-sheet] effect thumbnail failed', effectId, error);
    }
    g.restore();
    return canvas;
  }

  private remember(key: string, thumb: HTMLCanvasElement): void {
    this.rendered.set(key, thumb);
    while (this.rendered.size > THUMB_CACHE_MAX) {
      const oldest = this.rendered.keys().next().value;
      if (oldest === undefined) break;
      this.rendered.delete(oldest);
    }
  }

  render() {
    return this.watcher.run(() => {
      const { store } = this.ctx;
      const query = this.query.value;
      const searching = query.trim().length > 0;
      const presets = this.presetsFor(query, this.tab.value);
      /** The effect of the selected effect layer, which the grid outlines as applied. */
      const overlay = store.selectedOverlay.value;
      const appliedId = overlay?.kind === 'effect' ? overlay.effectId : null;

      return (
        <ve-sheet
          class="fx__frame"
          ref={this.keepSheet}
          searchPlaceholder="Search effects"
          searchValue={query}
          showNone={true}
          tabs={TABS}
          // No tab is the customer's while they are searching: the results cross every category.
          activeTab={searching ? null : this.tab.value}
          onVeSearch={this.onSearch}
          onVeTab={this.onTab}
          onVeNone={this.onNone}
          onVeConfirm={this.onConfirm}
        >
          <div class="fx__grid">
            {presets.length === 0 ? (
              <p class="fx__empty" key="empty">
                No effects found
              </p>
            ) : (
              presets.map(preset => {
                const on = preset.id === appliedId;
                return (
                  <button
                    type="button"
                    key={preset.id}
                    class={{ 'fx__cell': true, 'fx__cell--on': on }}
                    // A string on purpose: the vdom removes an attribute set to boolean false, and a
                    // cell with no `aria-pressed` at all is announced as a plain button.
                    aria-pressed={String(on)}
                    onClick={() => this.choose(preset)}
                  >
                    <span class="fx__thumb">
                      {/*
                        Empty in the vdom and drawn to by hand. `width` and `height` are set in
                        [syncThumbs] rather than here for the same reason: they are the canvas's
                        pixels, and a repaint writing either one would wipe the preview.
                      */}
                      <canvas class="fx__canvas" data-effect={preset.id}></canvas>
                    </span>
                    <span class="fx__label">{preset.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </ve-sheet>
      );
    });
  }
}

/**
 * Puts the 9:16 preview in the square cell.
 *
 * A look that lives all over the frame - a vignette, a leak, grain - fills the cell and is cropped
 * top and bottom, the way any video thumbnail is. An [EDGE_EFFECT_IDS] look is shown whole instead,
 * scaled down until the frame fits the cell's height: cropping it would take away the very thing the
 * customer is choosing. What is left either side stays transparent, so the cell's own grey shows
 * there - the Cinema bars are black, and on a black letterbox nobody could tell they were bars.
 */
function drawIntoCell(g: CanvasRenderingContext2D, thumb: HTMLCanvasElement, width: number, height: number, letterbox: boolean): void {
  if (letterbox) {
    const frameWidth = Math.round((height * thumb.width) / thumb.height);
    g.drawImage(thumb, Math.round((width - frameWidth) / 2), 0, frameWidth, height);
    return;
  }
  // The middle of the frame, as tall as it is wide.
  const side = Math.min(thumb.width, thumb.height);
  g.drawImage(thumb, 0, Math.round((thumb.height - side) / 2), side, side, 0, 0, width, height);
}
