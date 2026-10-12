import { signal } from '@preact/signals-core';
import { Component, Prop } from '@stencil/core';

import type { EditorContext } from '../../bridge/editor-context';
import { SignalWatcher } from '../../bridge/signal-watcher';
import type { Filmstrip } from '../../state/editor.types';
import { clockTenths, spokenSeconds, startFromScroll, stripScale, stripTiles, type StripTile } from './slip-strip';

/** How far the keyboard, or a screen reader's swipe, moves the part at a time. */
const KEY_STEP_MS = 100;

/** The narrowest the frame is drawn, so a very short part of a long clip is still something to see. */
const MIN_FRAME_PX = 12;

/**
 * How long after its last scroll event a slide is over, on a WebView too old for `scrollend` (it came
 * in Chrome 114). A fling sends one a frame, so this outlasts it; a finger held still for longer than
 * this and moved again is two undo steps rather than one, which is the whole cost.
 */
const SCROLL_SETTLE_MS = 180;

/**
 * Trim: which part of its clip the selected segment plays, at the length it already has.
 *
 * Somebody who cut a ten second video down to three seconds and then wants a different three seconds
 * should not have to drag both trim handles and land them on the same length again. Here the length
 * is kept for them: the whole clip is a strip under a frame fixed in the middle, the frame is exactly
 * as long as the segment, and sliding the strip changes only which part of the clip is under it - a
 * slip, in an editor's words. Nothing else on the timeline moves.
 *
 * The strip is a plain scrolling element, so a finger gets the phone's own fling and stop for free;
 * a mouse drags it and a wheel turns it, which no scrolling element does by itself; and a keyboard or
 * a screen reader moves the same part through a range hidden over it. Every slide is live: the
 * preview stays on the segment's first frame and follows the strip, the timeline's tiles move under
 * the segment, and the slide is one undo step when the strip comes to rest.
 */
@Component({
  tag: 've-slip-sheet',
  styleUrls: ['../sheet-common.css', 've-slip-sheet.css'],
  shadow: true,
})
export class VeSlipSheet {
  @Prop() ctx!: EditorContext;

  private readonly watcher = new SignalWatcher(this);

  /** The strip's width on screen, in px; 0 until it has been measured. */
  private readonly viewPx = signal(0);

  private scroller?: HTMLElement;
  private sizeWatch?: ResizeObserver;

  /** The last paint's geometry, for the handlers, which run between paints. */
  private pxPerMs = 0;
  private maxStartMs = 0;
  private startMs = 0;

  /**
   * Where the sheet last scrolled the strip itself, so the scroll event that comes of it is not taken
   * for a finger. Null once something else has moved it since.
   */
  private placedPx: number | null = null;

  /** The strip is moving under a finger, a fling or a mouse, inside a gesture the store has open. */
  private sliding = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  /** A mouse button down on the strip, dragging it; see [onPointerDown]. */
  private drag: { pointerId: number; x0: number; scroll0: number } | null = null;

  /** The tiles last laid out, kept while nothing they are made from changes; see [tilesFor]. */
  private laidOut: { key: string; clipMs: number; pxPerMs: number; strip: Filmstrip | undefined; tiles: StripTile[] } | null = null;

  /**
   * The clip's filmstrip, which the timeline has usually asked for already. Asking again for a strip
   * cut or on its way does nothing. The segment cannot change under an open sheet: `select` shuts it.
   */
  componentWillLoad() {
    const clip = this.ctx.store.selectedClip.peek();
    const source = clip ? this.ctx.store.clipByKey(clip.clipKey) : undefined;
    if (source && !clip?.image) void this.ctx.media.loadFilmstrip(source);
  }

  disconnectedCallback() {
    this.watcher.stop();
    this.keepScroller(undefined);
    this.endSlide();
  }

  /**
   * Puts the frame back over the segment's part whenever the part moved without the strip: on
   * opening, once the strip has a width, after a key, an undo or a redo. Never while the strip is
   * moving, which would stop a fling dead under the finger.
   */
  componentDidRender() {
    const el = this.scroller;
    if (!el || this.sliding || this.drag || this.pxPerMs <= 0) return;
    const want = this.startMs * this.pxPerMs;
    if (Math.abs(el.scrollLeft - want) < 1) return;
    el.scrollLeft = want;
    this.placedPx = el.scrollLeft;
  }

  /*
   * One stable function each rather than a fresh arrow per render: a new value is a changed value to
   * the vdom, so a listener would be taken off and put back on with every repaint, which is every
   * frame of a slide.
   */
  private readonly keepScroller = (el?: HTMLElement) => {
    if (this.scroller === el) return;
    if (this.scroller) {
      this.scroller.removeEventListener('scroll', this.onScroll);
      this.scroller.removeEventListener('scrollend', this.endSlide);
      this.scroller.removeEventListener('wheel', this.onWheel);
    }
    this.sizeWatch?.disconnect();
    this.sizeWatch = undefined;
    this.scroller = el;
    if (!el) return;
    el.addEventListener('scroll', this.onScroll, { passive: true });
    el.addEventListener('scrollend', this.endSlide);
    // Not passive: a wheel turned over the strip moves the strip and not the page under the editor.
    el.addEventListener('wheel', this.onWheel, { passive: false });
    this.sizeWatch = new ResizeObserver(() => {
      if (this.scroller) this.viewPx.value = this.scroller.clientWidth;
    });
    this.sizeWatch.observe(el);
  };

  private readonly close = () => {
    this.ctx.store.closePanel();
  };

  /** Plays the part once, start to end, back on its first frame after; or stops whatever is playing. */
  private readonly togglePlay = () => {
    const { store } = this.ctx;
    if (store.playing.value) {
      store.pause();
      return;
    }
    const clip = store.selectedClip.value;
    if (clip) store.auditionClip(clip.id);
  };

  /** The strip moved: by a finger, its fling, a mouse or a wheel - anything but [componentDidRender]. */
  private readonly onScroll = () => {
    const el = this.scroller;
    const { store } = this.ctx;
    const clip = store.selectedClip.value;
    if (!el || !clip || this.pxPerMs <= 0) return;
    if (this.placedPx !== null && Math.abs(el.scrollLeft - this.placedPx) < 1) return;
    this.placedPx = null;
    if (store.playing.value) store.pause();
    this.sliding = true;
    store.slipClip(clip.id, startFromScroll(el.scrollLeft, this.pxPerMs, this.maxStartMs), true);
    if (!('onscrollend' in window)) {
      if (this.settleTimer !== null) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(this.endSlide, SCROLL_SETTLE_MS);
    }
  };

  /** The strip has come to rest: the slide is one undo step. */
  private readonly endSlide = () => {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (!this.sliding || this.drag) return;
    this.sliding = false;
    this.ctx.store.endGesture('Trim');
  };

  /**
   * A mouse drags the strip, which a scrolling element does not let a mouse do by itself. A finger is
   * left to the browser, whose own scrolling is what gives it the fling.
   */
  private readonly onPointerDown = (event: PointerEvent) => {
    const el = this.scroller;
    if (event.pointerType !== 'mouse' || event.button !== 0 || !el) return;
    event.preventDefault();
    this.drag = { pointerId: event.pointerId, x0: event.clientX, scroll0: el.scrollLeft };
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* Uncaptured, and still a drag. */
    }
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    const el = this.scroller;
    if (!drag || !el || event.pointerId !== drag.pointerId) return;
    el.scrollLeft = drag.scroll0 - (event.clientX - drag.x0);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    try {
      if (this.scroller?.hasPointerCapture(event.pointerId)) this.scroller.releasePointerCapture(event.pointerId);
    } catch {
      /* Never captured. */
    }
    this.endSlide();
  };

  /** A wheel turns the strip, as it turns the toolbar's row: no browser makes `deltaY` scroll sideways. */
  private readonly onWheel = (event: WheelEvent) => {
    const el = this.scroller;
    if (!el || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1;
    el.scrollLeft += event.deltaY * step;
    event.preventDefault();
  };

  /** The hidden range: a keyboard's arrows, or a screen reader's swipe. A step each. */
  private readonly onKeys = (event: Event) => {
    const { store } = this.ctx;
    const clip = store.selectedClip.value;
    if (!clip) return;
    this.endSlide();
    store.slipClip(clip.id, Number((event.target as HTMLInputElement).value));
  };

  /**
   * The strip's tiles, laid out again only when the clip, its length on screen or its frames change.
   * A slide changes none of them, and it repaints the sheet on every frame.
   */
  private tilesFor(key: string, clipMs: number, pxPerMs: number, strip: Filmstrip | undefined): StripTile[] {
    const last = this.laidOut;
    if (last && last.key === key && last.clipMs === clipMs && last.pxPerMs === pxPerMs && last.strip === strip) return last.tiles;
    const tiles = stripTiles(clipMs, pxPerMs, strip);
    this.laidOut = { key, clipMs, pxPerMs, strip, tiles };
    return tiles;
  }

  render() {
    return this.watcher.run(() => {
      const { store } = this.ctx;
      const clip = store.selectedClip.value;
      if (!clip || clip.image) {
        return (
          <ve-sheet heading="Trim" onVeConfirm={this.close}>
            <p class="sheet__content slip__empty" key="empty">
              Select a clip first
            </p>
          </ve-sheet>
        );
      }

      const lengthMs = clip.outMs - clip.inMs;
      // A source whose length is not known yet ends where the segment does: nothing to slide until it is.
      const clipMs = Math.max(store.sourceDurationMs(clip.clipKey), clip.outMs);
      const maxStartMs = Math.max(0, clipMs - lengthMs);
      const whole = maxStartMs === 0;
      const viewPx = this.viewPx.value;
      const pxPerMs = stripScale(viewPx, lengthMs, clipMs);
      // Either end of the clip can come under the frame: half the strip less half the frame either side.
      const padPx = Math.max(0, (viewPx - lengthMs * pxPerMs) / 2);
      const filmPx = clipMs * pxPerMs;
      const tiles = this.tilesFor(clip.clipKey, clipMs, pxPerMs, store.filmstrips.value.get(clip.clipKey));
      const playing = store.playing.value;
      this.pxPerMs = pxPerMs;
      this.maxStartMs = maxStartMs;
      this.startMs = clip.inMs;

      return (
        <ve-sheet heading="Trim" onVeConfirm={this.close}>
          <div class="sheet__content slip" key="slip">
            <div class="slip__row">
              <button type="button" class="slip__play" aria-label={playing ? 'Pause' : 'Play part'} onClick={this.togglePlay}>
                <ve-icon name={playing ? 'pause' : 'play'} />
              </button>
              <span class="slip__times">
                {clockTenths(clip.inMs)} to {clockTenths(clip.outMs)}
              </span>
            </div>

            {/*
              The strip slides under a frame fixed in the middle: the frame is the segment, as long as
              it plays for, and whatever part of the clip is under it is the part that plays.
            */}
            <div class="slip__strip">
              <div
                class="slip__scroll"
                ref={this.keepScroller}
                onPointerDown={this.onPointerDown}
                onPointerMove={this.onPointerMove}
                onPointerUp={this.onPointerUp}
                onPointerCancel={this.onPointerUp}
              >
                <div class="slip__track" style={{ width: `${filmPx + 2 * padPx}px` }}>
                  <div class="slip__film" style={{ left: `${padPx}px`, width: `${filmPx}px` }}>
                    {tiles.map(tile => (
                      <span class="slip__tile" key={tile.x} style={{ left: `${tile.x}px` }}>
                        {tile.url ? <img src={tile.url} alt="" draggable={false} /> : null}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div class="slip__frame" style={{ width: `${Math.max(MIN_FRAME_PX, lengthMs * pxPerMs)}px` }} aria-hidden="true"></div>
              <input
                class="slip__keys"
                type="range"
                min="0"
                max={maxStartMs}
                step={KEY_STEP_MS}
                value={clip.inMs}
                aria-label="Start of part"
                aria-valuetext={spokenSeconds(clip.inMs)}
                disabled={whole}
                onInput={this.onKeys}
              />
            </div>

            <p class="slip__hint">{whole ? 'The whole video plays' : 'Drag to choose the part that plays'}</p>
          </div>
        </ve-sheet>
      );
    });
  }
}
