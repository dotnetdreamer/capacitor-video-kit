import { computed, effect, untracked } from '@preact/signals-core';
import {
  overlayRasterKey,
  rasteriseOverlay,
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
  /** The one context the editor draws with. The render builds its own from the same factory. */
  readonly rasterContext: RasterContext;

  /**
   * Only a new overlays array wakes this. Trims, filters and sound replace the manifest but keep
   * its `overlays` by reference, and should not cost a pass.
   */
  private readonly overlays = computed(() => this.store.manifest.value.overlays);

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
  private readonly recent = new Map<string, RasterisedOverlay>();

  constructor(
    private readonly store: EditorStore,
    host: ResolvedEditorHost,
  ) {
    this.rasterContext = createEditorRasterContext(host);

    this.stopWatching = effect(() => {
      this.overlays.value;
      // The pass reads the manifest and the bitmaps itself; tracking them here would have every
      // bitmap it writes wake the effect again.
      //
      // A signal effect runs the moment the layers change, where the Angular original waited for
      // the next change detection pass and coalesced a burst of writes into one run. Running more
      // often costs nothing here: `schedule()` either starts the one pass or marks that another is
      // wanted, and the pass itself is what does the work.
      untracked(() => this.schedule());
    });
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

    const layers: StaleLayer[] = overlays.map((overlay) => ({ overlay, key: overlayRasterKey(overlay) }));
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

  private async draw(overlay: EditOverlay, key: string): Promise<RasterisedOverlay | null> {
    const kept = this.recent.get(key);
    if (kept) {
      // Re-inserted, so the Map's insertion order stays least-recently-used first.
      this.recent.delete(key);
      this.recent.set(key, kept);
      this.failedKeys.delete(overlay.id);
      return kept;
    }
    try {
      const raster = await rasteriseOverlay(overlay, this.rasterContext);
      this.failedKeys.delete(overlay.id);
      this.recent.set(key, raster);
      while (this.recent.size > RECENT_BITMAPS) {
        const oldest = this.recent.keys().next().value;
        if (oldest === undefined) break;
        this.recent.delete(oldest);
      }
      return raster;
    } catch (error) {
      // One layer that cannot be drawn must not take the others down with it; it keeps whatever
      // bitmap it had, and the render reports it properly if it still fails there.
      this.failedKeys.set(overlay.id, key);
      debugWarn('[OverlayBitmap] could not draw layer', overlay.id, overlay.kind, error);
      return null;
    }
  }

  /** @param drawn the layer as it was when its bitmap was drawn, which may be older than now. */
  private write(drawn: EditOverlay, raster: RasterisedOverlay, key: string): void {
    const id = drawn.id;
    const current = this.store.manifest.value.overlays.find((overlay) => overlay.id === id);
    // Deleted while it was being drawn.
    if (!current) return;
    // An undo during the draw can have put the layer back to the look its existing bitmap was drawn
    // for; the bitmap just finished is for a state that no longer exists and must not replace it.
    if (this.store.bitmaps.value.get(id)?.key === overlayRasterKey(current)) return;

    const bitmap: OverlayBitmap = { ...raster, key, scale: drawn.scale };
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
