import { computed } from '@preact/signals-core';
import {
  overlayRasterKey,
  rasteriseOverlay,
  type EditOutput,
  type EditOverlay,
  type RasterContext,
  type RasterisedOverlay,
} from '../editor';

import { debugError, debugWarn } from '../host/debug';
import type { ResolvedEditorHost } from '../host/host.types';
import { createEditorRasterContext } from './editor-raster-context';
import type { EditorStore } from './editor-store';
import type { OverlayBitmap } from './editor.types';

/**
 * How many drawn bitmaps are kept by key after they stop being current. Enough that undo, redo and
 * duplicate put a layer back instantly instead of redrawing it; small enough that a long typing
 * session - a new key on every keystroke - cannot pile PNG strings up in the WebView's heap.
 */
const RECENT_BITMAPS = 16;

interface StaleLayer {
  overlay: EditOverlay;
  key: string;
}

/** A drawn bitmap and the frame (`RasterContext.output`) it was drawn against. */
interface DrawnRaster {
  raster: RasterisedOverlay;
  frameW: number;
  frameH: number;
}

/**
 * Keeps `store.bitmaps` in step with the manifest's layers, so the preview shows exactly the PNG
 * the render will place.
 *
 * Drawing is slow next to a drag - a photo layer has to be decoded, a text layer measured and
 * wrapped - so it never follows the finger frame by frame. There is at most ONE pass running; a
 * change that arrives mid-pass only marks that another pass is wanted, and that pass reads the
 * manifest as it is by then. Whatever the customer touched last is drawn first, so the layer being
 * typed into or pinched is the one that catches up, not the one that was already right.
 *
 * Created by the editor shell next to [EditorStore]; nothing else writes `store.bitmaps`.
 */
export class OverlayBitmaps {
  /**
   * The context the CURRENT frame is drawn with.
   *
   * Rebuilt whenever the frame changes rather than made once, because `output` is what every
   * layer's pixel size is worked out from: a sticker is a fraction of the frame's WIDTH, so the
   * same layer is a different bitmap on a 720 post and a 4K one. The render's context comes out of
   * the same factory: the editor makes one for the frame it renders at and hands it to the host as
   * `RenderRequest.raster`.
   */
  get rasterContext(): RasterContext {
    const width = this.store.outputWidth.value;
    if (!this.context || this.context.output.width !== width) {
      this.context = createEditorRasterContext(this.host, this.store.manifest.value.output);
    }
    return this.context;
  }

  private context: RasterContext | null = null;

  /**
   * What wakes a pass: a new overlays array, or a new frame to draw them for.
   *
   * The array BY REFERENCE, because trims, filters and sound replace the manifest and keep it, and
   * should not cost a pass. The frame's width beside it because it is the other half of what a
   * bitmap is: the same layer at the same scale is a different number of pixels on a 4K post, and a
   * pass woken only by the array would have left every layer drawn for the frame before last.
   */
  private readonly work = computed(() => ({
    overlays: this.store.manifest.value.overlays,
    width: this.store.outputWidth.value,
  }));

  private busy = false;
  private rerun = false;
  private running: Promise<void> = Promise.resolve();
  private destroyed = false;
  private readonly stopWatching: () => void;

  /** The last key each layer was seen with, and when it changed, for newest-first ordering. */
  private readonly seenKeys = new Map<string, string>();
  private readonly changedAt = new Map<string, number>();
  private tick = 0;
  /**
   * The key a layer last failed to draw with. It is not retried until the layer changes: a photo
   * that cannot be decoded would otherwise be attempted again on every frame of every drag.
   */
  private readonly failedKeys = new Map<string, string>();
  private readonly recent = new Map<string, DrawnRaster>();

  constructor(
    private readonly store: EditorStore,
    private readonly host: ResolvedEditorHost,
  ) {

    /*
     * `subscribe` rather than an `effect` whose body opens with a bare `this.overlays.value;`.
     * The two are the same thing - signals-core implements `subscribe` as an effect that reads the
     * value and calls back outside the tracking context - but a read written as its own statement
     * is a property access whose result nothing uses, and the production minifier deletes it. That
     * leaves an effect subscribed to nothing: it runs once when it is made and never again, no
     * layer is ever drawn, and the preview shows the video with its text, stickers and effects
     * missing while every test over the unminified build passes. Here the value is an argument, so
     * there is nothing to delete.
     *
     * The pass reads the manifest and the bitmaps itself; tracking them here would have every
     * bitmap it writes wake this again.
     *
     * It runs the moment the layers change, where the Angular original waited for the next change
     * detection pass and coalesced a burst of writes into one run. Running more often costs nothing
     * here: `schedule()` either starts the one pass or marks that another is wanted, and the pass
     * itself is what does the work.
     */
    this.stopWatching = this.work.subscribe(() => this.schedule());
  }

  /**
   * Resolves once every layer has a current bitmap, or has failed to get one. Kicks a pass off
   * itself rather than trusting the effect to have run: a render started in the same turn as a
   * change would otherwise find nothing pending and go ahead.
   */
  async ensureFresh(): Promise<void> {
    this.schedule();
    while (this.busy) {
      await this.running;
    }
  }

  /** Called by the shell when the editor leaves the document. */
  dispose(): void {
    this.destroyed = true;
    this.stopWatching();
    this.recent.clear();
  }

  /**
   * The context a render at `output` draws its layers with: the one the preview's own bitmaps come
   * out of (see [rasterContext]), plus `drawn`, which hands back the bitmap already on screen for
   * any layer where drawing it again would produce the same PNG. `toComposeSpec` then places those
   * instead of decoding, drawing and encoding each of them a second time, one after another, while
   * the export screen sits at 0%.
   *
   * A bitmap is only handed back for the render's exact key AND frame. The key alone is not enough:
   * an effect's key leaves the frame out, so the effect on screen can have been drawn for a frame the
   * post no longer has, and a bitmap can come out of the [recent] cache from an older frame.
   *
   * Text and emoji are always drawn again. Both wait for a font, and a font that took longer than the
   * rasteriser waits leaves the preview drawn in the fallback face - which the render, drawing later,
   * would have drawn in the right one. They are also the small, cheap canvases; the time is in the
   * photos, stickers and full-frame effects.
   */
  renderContext(output: EditOutput): RasterContext {
    return {
      ...createEditorRasterContext(this.host, output),
      drawn: (overlay) => {
        if (overlay.kind === 'text' || (overlay.kind === 'sticker' && overlay.emoji)) return null;
        const bitmap = this.store.bitmaps.value.get(overlay.id);
        if (!bitmap || bitmap.key !== overlayRasterKey(overlay, output.width)) return null;
        if (bitmap.frameW !== output.width || bitmap.frameH !== output.height) return null;
        // The key rounds the scale to a thousandth, but photos and stickers are drawn at the exact
        // one, so a bitmap from a scale a hair away is a pixel off what the render would draw.
        if (overlay.kind !== 'effect' && bitmap.scale !== overlay.scale) return null;
        return { png: bitmap.png, wPx: bitmap.wPx, hPx: bitmap.hPx };
      },
    };
  }

  private schedule(): void {
    if (this.destroyed) return;
    if (this.busy) {
      this.rerun = true;
      return;
    }
    this.busy = true;
    this.running = this.drain();
  }

  /**
   * Runs passes until one finishes with nothing new waiting. `busy` is cleared in the same tick as
   * the last `rerun` check, so a change can never land in a gap between "the loop ended" and "the
   * loop is marked as ended" and be lost.
   */
  private async drain(): Promise<void> {
    try {
      do {
        this.rerun = false;
        await this.pass();
      } while (this.rerun && !this.destroyed);
    } catch (error) {
      debugError('[OverlayBitmap] pass failed', error);
    } finally {
      this.busy = false;
    }
  }

  private async pass(): Promise<void> {
    const overlays = this.store.manifest.value.overlays;
    this.forgetRemoved(new Set(overlays.map((overlay) => overlay.id)));

    const width = this.store.outputWidth.value;
    const layers: StaleLayer[] = overlays.map((overlay) => ({ overlay, key: overlayRasterKey(overlay, width) }));
    for (const { overlay, key } of layers) {
      if (this.seenKeys.get(overlay.id) !== key) {
        this.seenKeys.set(overlay.id, key);
        this.changedAt.set(overlay.id, ++this.tick);
      }
    }

    const bitmaps = this.store.bitmaps.value;
    const stale = layers
      .filter(({ overlay, key }) => bitmaps.get(overlay.id)?.key !== key && this.failedKeys.get(overlay.id) !== key)
      .sort((a, b) => (this.changedAt.get(b.overlay.id) ?? 0) - (this.changedAt.get(a.overlay.id) ?? 0));

    for (const { overlay, key } of stale) {
      if (this.destroyed) return;
      const raster = await this.draw(overlay, key);
      if (raster && !this.destroyed) this.write(overlay, raster, key);
      // Something changed while this layer was being drawn. The rest of this list may already be
      // out of date, and the change is most likely to the layer under the customer's finger - so
      // hand over to the next pass, which re-reads the manifest and puts that layer first.
      if (this.rerun) return;
    }
  }

  private async draw(overlay: EditOverlay, key: string): Promise<DrawnRaster | null> {
    const kept = this.recent.get(key);
    if (kept) {
      // Re-inserted, so the Map's insertion order stays least-recently-used first.
      this.recent.delete(key);
      this.recent.set(key, kept);
      this.failedKeys.delete(overlay.id);
      return kept;
    }
    try {
      // The frame is read off the context the layer is actually drawn with, BEFORE the await: the
      // frame can change while it draws, and a bitmap must never be labelled with a frame it was
      // not drawn for (see [renderContext]).
      const context = this.rasterContext;
      const { width: frameW, height: frameH } = context.output;
      const drawn: DrawnRaster = { raster: await rasteriseOverlay(overlay, context), frameW, frameH };
      this.failedKeys.delete(overlay.id);
      this.recent.set(key, drawn);
      while (this.recent.size > RECENT_BITMAPS) {
        const oldest = this.recent.keys().next().value;
        if (oldest === undefined) break;
        this.recent.delete(oldest);
      }
      return drawn;
    } catch (error) {
      // One layer that cannot be drawn must not take the others down with it; it keeps whatever
      // bitmap it had, and the render reports it properly if it still fails there.
      this.failedKeys.set(overlay.id, key);
      debugWarn('[OverlayBitmap] could not draw layer', overlay.id, overlay.kind, error);
      return null;
    }
  }

  /** @param drawn the layer as it was when its bitmap was drawn, which may be older than now. */
  private write(drawn: EditOverlay, { raster, frameW, frameH }: DrawnRaster, key: string): void {
    const id = drawn.id;
    const current = this.store.manifest.value.overlays.find((overlay) => overlay.id === id);
    // Deleted while it was being drawn.
    if (!current) return;
    // An undo during the draw can have put the layer back to the look its existing bitmap was drawn
    // for; the bitmap just finished is for a state that no longer exists and must not replace it.
    if (this.store.bitmaps.value.get(id)?.key === overlayRasterKey(current, this.store.outputWidth.value)) return;

    const bitmap: OverlayBitmap = { ...raster, key, scale: drawn.scale, frameW, frameH };
    // A signal write repaints the preview by itself, even this far after an image load resolved.
    this.store.bitmaps.value = new Map(this.store.bitmaps.value).set(id, bitmap);
  }

  private forgetRemoved(live: ReadonlySet<string>): void {
    for (const map of [this.seenKeys, this.changedAt, this.failedKeys]) {
      for (const id of map.keys()) {
        if (!live.has(id)) map.delete(id);
      }
    }
    const bitmaps = this.store.bitmaps.value;
    if (![...bitmaps.keys()].some((id) => !live.has(id))) return;
    this.store.bitmaps.value = new Map([...bitmaps].filter(([id]) => live.has(id)));
  }
}
