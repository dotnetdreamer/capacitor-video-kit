import { Component, Element, Prop } from '@stencil/core';
import { computed, effect, signal, untracked } from '@preact/signals-core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import {
  MIN_TRANSITION_MS,
  TRANSITIONS,
  TRANSITION_CATEGORIES,
  TRANSITION_STEP_MS,
  cssFor,
  transitionPreset,
  type FilterOp,
  type TransitionCategory,
  type TransitionPreset,
} from '../../editor';
import { computedWith } from '../../state/computed-with';
import { fold, isIdentity } from '../../video-composer/web/color-matrix';
import { durationChip, frameUrl } from '../ve-timeline/timeline-geometry';
import { ThumbPainter, loopProgress, prepareFrame, type ThumbColour, type ThumbSource } from './transition-thumbs';

/**
 * The tile is 64 CSS px square, and its canvas is the screen's own pixels for that square, up to 3x:
 * one canvas pixel to one device pixel on every phone the editor is tested on, so the edge of a wipe
 * or of a spinning frame is drawn sharp by the painter rather than stretched soft by the compositor.
 * The painter draws on the GPU, where a 192 px tile costs little more than a 128 px one did.
 */
const CELL_PX = Math.round(64 * Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1)));
/** Per-frame drawing budget, so opening the sheet never stalls the preview's own frame. */
const DRAW_BUDGET_MS = 8;
/**
 * The chosen tile is redrawn about thirty times a second. Its picture is 64 px across, where the
 * difference from sixty is not visible and the second half of the work would be the phone's.
 */
const ANIMATE_EVERY_MS = 32;
/** Decoded frames kept, by URL: the two at this cut and a few from cuts visited before it. */
const FRAME_CACHE_MAX = 8;

/** What a tile canvas is showing, so the pump can tell a drawn tile from one that is out of date. */
interface TileState {
  visible: boolean;
  /** `kind|frames` the canvas shows as a still, or null when it shows nothing yet or a moving frame. */
  drawnKey: string | null;
}

/** The filmstrip frames either side of the cut: the outgoing clip's last and the incoming clip's first. */
interface CutFrames {
  from: string | null;
  to: string | null;
}

/**
 * LightCut's transition picker, opened by the white dot on a cut: Basic, Camera, Mask and Effect in
 * the frame's head, a row of tiles, how long the transition runs, and the offer to use it on every
 * cut of the video.
 *
 * Every tile is the customer's OWN two clips going through that transition - the frame the outgoing
 * clip leaves on and the frame the incoming one opens with, drawn at the moment that says most about
 * it - and the chosen tile plays it on a loop. A picker of static icons asks the customer to imagine
 * a spin on their own footage; this one shows it to them.
 *
 * Nothing here decides anything. A tile is `chooseTransition`, None is `removeTransition`, the
 * slider is `setTransitionDuration`: the store auditions the choice in the preview and folds the
 * whole visit into one undo step, so the sheet can be browsed freely and left with one tap of undo.
 *
 * Every tile is drawn by the render's own painter, handed the very transition the export draws at
 * that moment, so what a tile shows is what the customer will get - blur, mosaic and all. The
 * thumbnails live outside the vdom, as the effects sheet's do: a repaint is a diff of nine buttons,
 * and a thumbnail is a GPU composite, so they are drawn onto their canvases by a budgeted
 * `requestAnimationFrame` pump, and only the tiles an `IntersectionObserver` says are on screen are
 * drawn at all.
 */
@Component({
  tag: 've-transition-sheet',
  styleUrls: ['../sheet-common.css', 've-transition-sheet.css'],
  shadow: true,
})
export class VeTransitionSheet {
  @Prop() ctx!: EditorContext;

  @Element() el!: HTMLElement;

  private readonly watcher = new SignalWatcher(this);

  /**
   * Which category's tiles are on screen. Set from the cut's own transition on the way in, so the
   * sheet opens on the customer's choice rather than on Basic.
   */
  private readonly category = signal<TransitionCategory>('basic');

  /** The transition on the cut, as its own value: the boundary object is new on every manifest write. */
  private readonly chosen = computed(() => this.ctx.store.targetBoundary.value?.transition?.kind ?? null);

  /**
   * The frames the tiles are drawn from, and only those: the outgoing clip's picture near its out
   * point, and the incoming clip's first. Compared by URL, so a duration drag - which writes the
   * manifest on every frame and hands back a new boundary each time - redraws nothing.
   */
  private readonly frames = computedWith<CutFrames>(
    () => {
      const store = this.ctx.store;
      const boundary = store.targetBoundary.value;
      if (!boundary) return { from: null, to: null };
      const strips = store.filmstrips.value;
      const { from, to } = boundary;
      return {
        from: frameUrl(strips.get(from.clipKey), Math.max(from.inMs, from.outMs - 1)),
        to: frameUrl(strips.get(to.clipKey), to.inMs),
      };
    },
    (a, b) => a.from === b.from && a.to === b.to,
  );

  /**
   * The post's colour work, which the render lays over both sides of a transition and so the tiles
   * do too. Compared by what it says, because the store builds a new list on every manifest write
   * and a duration drag is a manifest write per frame.
   */
  private readonly filterOps = computedWith<FilterOp[]>(
    () => this.ctx.store.filterOps.value,
    (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
  );

  /* -- thumbnails (plain fields: read and written per frame) --------------------------------- */

  private observer: IntersectionObserver | null = null;
  private readonly tracked = new Map<HTMLCanvasElement, TileState>();
  private readonly queue = new Set<HTMLCanvasElement>();
  /**
   * The ONE painter every tile of this sheet is drawn by, built by the first tile drawn and given
   * back - GL context and all - when the sheet leaves the document.
   */
  private thumbs: ThumbPainter | null = null;
  /** The colour the tiles are drawn in, and a count that goes up whenever it changes, for [TileState.drawnKey]. */
  private colour: ThumbColour | null = null;
  private colourVersion = 0;
  private seenOps: FilterOp[] | null = null;
  /** Frames by URL, decoded and brought to the tile's size once; null for one that could not be loaded. */
  private readonly images = new Map<string, ThumbSource | null>();
  private readonly loading = new Set<string>();
  private rafId = 0;
  private destroyed = false;
  /** Whether this element has ever finished loading, which decides what a re-attach has to redo. */
  private loaded = false;
  /** When the chosen tile's loop began, so a new choice plays from its start. */
  private loopFrom = 0;
  private lastLoopDraw = 0;
  /**
   * The tile the last frame of the pump had moving. A tile that stops moving with no new choice -
   * the system has asked for less motion - is left on whatever moment of its loop it last showed,
   * half way through a wipe, and nothing but this remembers that it is owed its still.
   */
  private moved: HTMLCanvasElement | null = null;
  /** The last frames and choice the thumbnails were told about, to tell a real change from a wake. */
  private seenFrames: CutFrames | null = null;
  private seenChosen: string | null | undefined = undefined;
  /** The cut the sheet last set itself up for; a tap on another dot while open is a new cut. */
  private seenTarget: string | null = null;
  /** Answered by the next render: the chosen tile is brought to the middle of the row. */
  private centrePending = false;
  private readonly still = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  /**
   * The system's motion setting changing while the sheet is open, which matters in one direction:
   * motion allowed again, when the pump has stopped and nothing else would start the chosen tile's
   * loop. The other direction cannot be left to this. The pump reads `matches` every frame of a
   * loop, and Chrome reports no change to a query whose `matches` was read after it - so the pump
   * sees less motion asked for itself, and puts the still back through [moved].
   */
  private readonly onMotionSetting = () => this.requeueVisible();
  private stopWatching?: () => void;

  private row?: HTMLElement;

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed value to
   * the vdom, and a `format` rebuilt on every repaint would re-render the slider under the finger,
   * which is every repaint of a drag.
   */
  private readonly keepRow = (el?: HTMLElement) => {
    this.row = el;
  };

  private readonly formatDuration = (ms: number): string => durationChip(ms);

  private readonly onTab = (event: CustomEvent<string>) => {
    const category = TRANSITION_CATEGORIES.find(c => c.id === event.detail)?.id;
    if (!category || category === this.category.value) return;
    this.category.value = category;
    // A new category is a new row; starting it part-way along would hide its first tiles.
    if (this.row) this.row.scrollLeft = 0;
  };

  private readonly onNone = () => this.ctx.store.removeTransition();

  private readonly onConfirm = () => this.ctx.store.closePanel();

  /** Inside the slider's gesture, which the store's history group folds into the visit's one step. */
  private readonly onDuration = (event: CustomEvent<number>) => {
    this.ctx.store.setTransitionDuration(event.detail, true);
  };

  private readonly applyToAll = () => this.ctx.store.applyTransitionToAll();

  /* ========================================================================================= */
  /* Lifecycle                                                                                 */
  /* ========================================================================================= */

  connectedCallback() {
    /*
     * Everything `disconnectedCallback` took away is put back here and not in `componentDidLoad`,
     * which Stencil does not call a second time when it re-attaches an element it has moved.
     */
    this.destroyed = false;
    this.still?.addEventListener('change', this.onMotionSetting);
    if (this.loaded) this.observe();
    /*
     * The thumbnails answer to four things the render does not need to repaint for: which frames
     * the cut has, which transition is chosen, which cut it is, and the post's colour. An effect
     * rather than a render hook, because a render can happen for any reason and these four are the
     * only ones that mean a canvas is now out of date.
     */
    this.stopWatching = effect(() => {
      const target = this.ctx.store.transitionTarget.value;
      const frames = this.frames.value;
      const chosen = this.chosen.value;
      const ops = this.filterOps.value;
      untracked(() => this.follow(target, frames, chosen, ops));
    });
  }

  componentWillLoad() {
    this.openOn(this.chosen.value);
    this.seenTarget = this.ctx.store.transitionTarget.value;
  }

  componentDidLoad() {
    this.loaded = true;
    this.centreChosen();
    this.observe();
  }

  componentDidRender() {
    if (this.centrePending) {
      this.centrePending = false;
      this.centreChosen();
    }
    this.syncThumbs();
  }

  disconnectedCallback() {
    this.destroyed = true;
    this.watcher.stop();
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.still?.removeEventListener('change', this.onMotionSetting);
    this.observer?.disconnect();
    this.observer = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.queue.clear();
    this.tracked.clear();
    this.moved = null;
    this.images.clear();
    this.loading.clear();
    this.seenFrames = null;
    this.seenChosen = undefined;
    this.seenOps = null;
    // The GL context goes back NOW rather than when the element is collected: the page only has a
    // handful, and a sheet opened and shut a few times would otherwise cost the preview its own.
    this.thumbs?.dispose();
    this.thumbs = null;
  }

  /* ========================================================================================= */
  /* Chrome                                                                                    */
  /* ========================================================================================= */

  /** The tab of `kind`, or Basic for a plain cut. */
  private openOn(kind: string | null): void {
    this.category.value = (kind ? transitionPreset(kind)?.category : null) ?? 'basic';
  }

  private choose(preset: TransitionPreset): void {
    // The same tile again plays it again, which is the only way to see it twice.
    this.ctx.store.chooseTransition(preset.id);
  }

  /** Puts the chosen tile in the middle of the row, like the filter sheet does. */
  private centreChosen(): void {
    const row = this.row;
    const on = this.el.shadowRoot?.querySelector<HTMLElement>('.ts__tile--on');
    if (!row || !on) return;
    row.scrollLeft = Math.max(0, on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2);
  }

  /* ========================================================================================= */
  /* Thumbnails                                                                                */
  /* ========================================================================================= */

  /**
   * One answer to all four of the effect's inputs.
   *
   * Another cut - a different dot tapped while the sheet is open - is a new sheet in all but the
   * element: it opens on that cut's own tab with its own tile in the middle. New frames, or a new
   * colour, make every still out of date. A new choice restarts the loop from its first frame, and
   * the tile that was looping goes back to its still.
   */
  private follow(target: string | null, frames: CutFrames, chosen: string | null, ops: FilterOp[]): void {
    if (this.destroyed) return;
    if (target !== this.seenTarget) {
      this.seenTarget = target;
      if (target) {
        this.openOn(chosen);
        this.centrePending = true;
        if (this.row) this.row.scrollLeft = 0;
      }
    }
    /*
     * No cut is the sheet on its way out: the store lets go of the target as it shuts the panel,
     * a frame before the element leaves the document. Answering it would redraw every tile on
     * screen as stand-ins, up to the whole budget, in the very frame the editor is laying itself
     * out again without the sheet. A tap on another dot passes through here on its way to the new
     * cut, and the new cut, which differs from what was seen, is what gets the redraw.
     */
    if (target === null && this.seenFrames !== null) return;
    const framesChanged = this.seenFrames !== frames;
    const chosenChanged = this.seenChosen !== chosen;
    const colourChanged = this.seenOps !== ops;
    this.seenFrames = frames;
    this.seenChosen = chosen;
    if (colourChanged) {
      this.seenOps = ops;
      // Folded here, once per filter, exactly as the preview folds it; an identity is no colour at all.
      const matrix = ops.length === 0 ? null : fold(ops);
      this.colour = ops.length === 0 ? null : { matrix: matrix && !isIdentity(matrix) ? matrix : null, css: cssFor(ops) };
      this.colourVersion += 1;
    }
    if (chosenChanged) {
      this.loopFrom = performance.now();
      this.lastLoopDraw = 0;
    }
    if (framesChanged || chosenChanged || colourChanged) this.requeueVisible();
  }

  /**
   * Rooted at the ROW rather than at the sheet's body, which is where this differs from the effects
   * sheet: there the grid scrolls down the body, here the row scrolls sideways inside it, and the
   * margin that has the next tile drawn before it is scrolled in only means anything on the root.
   */
  private observe(): void {
    if (this.observer || this.destroyed) return;
    if (typeof IntersectionObserver !== 'undefined' && this.row) {
      this.observer = new IntersectionObserver(entries => this.onEntries(entries), { root: this.row, rootMargin: '0px 96px' });
    }
    // Tiles tracked before there was an observer are observed now, and everything starts over. They
    // were taken to be on screen while nothing could say otherwise; from here the observer says, and
    // it answers for every tile it is given. Left as they were, the whole row would be drawn in the
    // first frame, which the painter is quick enough to do - the tiles far off the row's end included.
    for (const [canvas, state] of this.tracked) {
      if (!this.observer) break;
      state.visible = false;
      this.observer.observe(canvas);
    }
    this.syncThumbs();
  }

  /**
   * Tracks the canvases the row has now and forgets the ones a tab switch removed. Runs after every
   * render, and only wakes the pump when the row has really changed: a duration drag repaints the
   * sheet on every frame.
   */
  private syncThumbs(): void {
    if (this.destroyed) return;
    const canvases = [...(this.el.shadowRoot?.querySelectorAll<HTMLCanvasElement>('canvas.ts__canvas') ?? [])];
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
      // Sized here and never in the JSX: writing either dimension clears a canvas, and a repaint
      // that did so would blank a tile while `drawnKey` still said it had been drawn.
      canvas.width = CELL_PX;
      canvas.height = CELL_PX;
      // Without an observer nothing would ever report a tile as visible, so they all are.
      this.tracked.set(canvas, { visible: !this.observer, drawnKey: null });
      this.observer?.observe(canvas);
      changed = true;
    }

    if (changed) this.requeueVisible();
  }

  private onEntries(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const state = this.tracked.get(entry.target as HTMLCanvasElement);
      if (!state) continue;
      state.visible = entry.isIntersecting;
    }
    this.requeueVisible();
  }

  private requeueVisible(): void {
    for (const [canvas, state] of this.tracked) {
      if (state.visible) this.queue.add(canvas);
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.rafId && !this.destroyed) this.rafId = requestAnimationFrame(this.pump);
  }

  /**
   * The chosen tile, when it should be moving: on screen, on a cut with a transition, and for a
   * customer who has not asked the system for less motion. Otherwise it is a still like the rest.
   */
  private looping(): HTMLCanvasElement | null {
    const chosen = this.seenChosen;
    if (!chosen || this.still?.matches) return null;
    for (const [canvas, state] of this.tracked) {
      if (state.visible && canvas.dataset.kind === chosen) return canvas;
    }
    return null;
  }

  /**
   * The two frames as pictures, or null while either is still loading - in which case its load
   * wakes the pump again. A frame with no URL, or one that failed, is null inside the pair, which
   * [ThumbPainter.drawThumb] draws as its stand-in.
   */
  private sources(frames: CutFrames): { from: ThumbSource | null; to: ThumbSource | null; key: string } | null {
    const from = this.image(frames.from);
    const to = this.image(frames.to);
    if (from === undefined || to === undefined) return null;
    return { from, to, key: `${from ? frames.from : '-'}|${to ? frames.to : '-'}` };
  }

  private image(url: string | null): ThumbSource | null | undefined {
    if (!url) return null;
    if (this.images.has(url)) {
      const known = this.images.get(url) ?? null;
      // Moved to the young end on every read, so the frame let go when the cache is full is the one
      // looked at longest ago. Let go by age of arrival instead, a cut sharing a frame with one seen
      // earlier - a clip shorter than a filmstrip step leaves on the picture it entered on - loses
      // that frame to the decode of its other one, and the row waits for it to be decoded again.
      this.images.delete(url);
      this.images.set(url, known);
      return known;
    }
    this.load(url);
    return undefined;
  }

  /**
   * Decodes one frame and keeps it at the tile's size, once per URL: the animated tile draws the
   * pair thirty times a second, and a picture resampled on every one of those would be resampled
   * worse (a bilinear read) for no gain.
   */
  private load(url: string): void {
    if (this.loading.has(url)) return;
    this.loading.add(url);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    const settle = (ok: boolean): void => {
      this.loading.delete(url);
      if (this.destroyed) return;
      this.images.set(url, ok ? prepareFrame(img, img.naturalWidth, img.naturalHeight, CELL_PX) : null);
      while (this.images.size > FRAME_CACHE_MAX) {
        const oldest = this.images.keys().next().value;
        if (oldest === undefined) break;
        this.images.delete(oldest);
      }
      this.requeueVisible();
    };
    img.decode().then(
      () => settle(true),
      () => settle(img.complete && img.naturalWidth > 0),
    );
  }

  /**
   * One frame of drawing: the looping tile if its moment has come round, then as many stills as
   * the budget allows, the rest next frame. Keeps itself running only while there is something
   * left to draw or a tile to move.
   */
  private readonly pump = (now: number): void => {
    this.rafId = 0;
    if (this.destroyed) return;
    const frames = this.seenFrames ?? this.frames.value;
    const sources = this.sources(frames);
    // A frame still decoding: its load requeues everything once it lands.
    if (!sources) return;

    const started = performance.now();
    const looping = this.looping();
    if (this.moved && this.moved !== looping) this.queue.add(this.moved);
    this.moved = looping;
    if (looping && now - this.lastLoopDraw >= ANIMATE_EVERY_MS) {
      this.lastLoopDraw = now;
      this.painter().drawThumb(looping, sources.from, sources.to, looping.dataset.kind ?? '', loopProgress(now - this.loopFrom));
      const state = this.tracked.get(looping);
      // No longer the still: when it stops looping, the queue has to draw that again.
      if (state) state.drawnKey = null;
    }

    for (const canvas of this.queue) {
      if (performance.now() - started > DRAW_BUDGET_MS) break;
      this.queue.delete(canvas);
      if (canvas === looping) continue;
      const state = this.tracked.get(canvas);
      const kind = canvas.dataset.kind;
      if (!state?.visible || !kind) continue;
      const key = `${kind}|${sources.key}|${this.colourVersion}`;
      if (state.drawnKey === key) continue;
      this.painter().drawThumb(canvas, sources.from, sources.to, kind, transitionPreset(kind)?.posterAt ?? 0.5);
      state.drawnKey = key;
    }

    if (this.queue.size || looping) this.schedule();
  };

  /**
   * The sheet's one painter, built by the first tile that is actually drawn and so inside that
   * frame's budget: compiling its shaders is most of what a first frame costs, and the budget then
   * leaves the rest of the row to the next one. Never built for a sheet shut before it drew.
   */
  private painter(): ThumbPainter {
    const thumbs = this.thumbs ?? (this.thumbs = new ThumbPainter(CELL_PX));
    thumbs.setColour(this.colour);
    return thumbs;
  }

  /* ========================================================================================= */
  /* Render                                                                                    */
  /* ========================================================================================= */

  render() {
    return this.watcher.run(() => {
      const store = this.ctx.store;
      const boundary = store.targetBoundary.value;
      const category = this.category.value;
      const chosen = this.chosen.value;
      const tiles = TRANSITIONS.filter(preset => preset.category === category);
      // A video with one cut has nobody else to apply it to.
      const manyCuts = store.slots.value.length > 2;

      return (
        <ve-sheet tabs={TRANSITION_CATEGORIES} activeTab={category} showNone={true} onVeTab={this.onTab} onVeNone={this.onNone} onVeConfirm={this.onConfirm}>
          <div class="ts">
            {/*
              Every child here is keyed: two of them are conditional, and the vdom matches unkeyed
              siblings of the same tag by position.
            */}
            <div class="ts__row" key="row" ref={this.keepRow}>
              {tiles.map(preset => {
                const on = preset.id === chosen;
                return (
                  <button
                    type="button"
                    key={preset.id}
                    class={{ 'ts__tile': true, 'ts__tile--on': on }}
                    // The choice is in the NAME rather than in `aria-pressed`. On the WebView still
                    // shipping on the Samsung A13 (Chrome 99), a change to `aria-pressed` inside a
                    // shadow root never reaches Android's accessibility tree - the tile tapped reads
                    // unpressed for as long as the sheet is open - while a change to the name does,
                    // as the dots' names show. The same move the gallery made with ", clip N".
                    aria-label={on ? `${preset.label}, selected` : preset.label}
                    onClick={() => this.choose(preset)}
                  >
                    <span class="ts__frame">
                      {/*
                        Empty in the vdom and drawn to by hand; its pixel size is set in
                        [syncThumbs] for the same reason.
                      */}
                      <canvas class="ts__canvas" data-kind={preset.id}></canvas>
                    </span>
                    <span class="ts__label">{preset.label}</span>
                  </button>
                );
              })}
            </div>

            {boundary ? this.durationRow(boundary.transition !== null, boundary.effectiveMs, boundary.maxMs) : null}

            {/*
              Offered only once the cut HAS a transition to apply. On a plain cut the same tap took
              every transition off the video, under a label that says nothing of the kind.

              Hidden rather than left out, so the space stays: the sheet stacks up from the bottom
              of the screen, and a pill arriving with the first tile tapped would lift the whole row
              46px under the finger that tapped it - the very move the dimmed duration row is there
              to prevent. `visibility: hidden` also takes it out of the accessibility tree, and
              `disabled` out of reach of a click that does not come from a pointer.
            */}
            {manyCuts ? (
              <button
                type="button"
                class={{ 'ts__apply-all': true, 'ts__apply-all--off': !boundary?.transition }}
                key="apply-all"
                disabled={!boundary?.transition}
                onClick={this.applyToAll}
              >
                Apply to all clips
              </button>
            ) : null}
          </div>
        </ve-sheet>
      );
    });
  }

  /**
   * How long the transition runs, from the shortest worth drawing to the longest the two clips can
   * hold.
   *
   * On a plain cut it is still there, dimmed and out of reach, so choosing a transition does not
   * push the row down under the finger - and so the customer can see there is a length to set.
   * Two clips that cannot hold more than the shortest transition get a sentence instead, because a
   * slider whose two ends are the same place is not a control. That is a clip under 400 ms on either
   * side, not only one under 200: from 200 the pair holds exactly the shortest transition, which a
   * tile still puts on, so the sentence there says how long it runs rather than that there is no
   * room for one at all.
   *
   * Out of reach is `pointer-events: none` on the row (see the stylesheet), the slider's own
   * `disabled` for focus and keys, and `aria-disabled` for the row as a whole - and not `inert`,
   * which it was. The A13's Chrome 99 ignores `inert` outright, so there it held nothing, and a
   * current WebView that does honour it takes the whole row out of the accessibility tree: the word
   * and the readout went with the slider, and Maestro could no longer find the number it checks.
   */
  private durationRow(set: boolean, effectiveMs: number, maxMs: number) {
    if (maxMs <= MIN_TRANSITION_MS) {
      return (
        <p class="ts__hint" key="hint">
          {maxMs < MIN_TRANSITION_MS ? 'These clips are too short for a transition' : `These clips are too short for more than a ${durationChip(MIN_TRANSITION_MS)} transition`}
        </p>
      );
    }
    // On a cut, the duration the first tile tapped will get, so the number does not jump when it is.
    const ms = set ? effectiveMs : this.ctx.store.nextTransitionMs.value;
    return (
      <div class={{ 'ts__duration': true, 'ts__duration--off': !set }} key="duration" aria-disabled={set ? undefined : 'true'}>
        {/*
          A visible word as well as the slider's own name: on a current Android WebView the slider
          reaches the accessibility tree with no name at all, and the word is what is left.
        */}
        <span class="ts__duration-label">Duration</span>
        <ve-slider
          class="ts__slider"
          ctx={this.ctx}
          label="Transition duration"
          value={ms}
          min={MIN_TRANSITION_MS}
          max={maxMs}
          step={TRANSITION_STEP_MS}
          pin="press"
          disabled={!set}
          format={this.formatDuration}
          onVeLive={this.onDuration}
        />
        {/* The number a test can read: the slider's own bubble only shows while a finger is on it. */}
        <span class="ts__duration-value">{durationChip(ms)}</span>
      </div>
    );
  }
}
