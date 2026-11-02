import { signal } from '@preact/signals-core';

/** How long a photo's reveal plays: as long as a clip's (`CUTOUT_REVEAL_MS` in preview-canvas.ts). */
export const PHOTO_REVEAL_MS = 900;

/**
 * How long after a cutout's matte arrived a new bitmap of its photo still counts as the cutout landing.
 * The rasteriser draws a cut-out photo a moment after its matte is ready - longer on a slow phone with
 * a large photo - and a bitmap later than this is some other change.
 */
const REVEAL_WINDOW_MS = 4000;

/** A photo layer as it looked on screen: enough to keep it there while it fades. */
export interface RevealGhost {
  png: string;
  /** Percent of the frame's width, the layer's own box. */
  width: number;
  /** CSS `aspect-ratio`. */
  aspect: string;
}

/** What this reads of the preview's layer views. */
interface ShownLayer extends RevealGhost {
  id: string;
  effect: boolean;
}

/**
 * A photo layer's cutout arriving on screen: the photo as it was fades away over the moment after its
 * cut-out bitmap lands, while a light rises and falls round what is kept - the photo half of the reveal
 * the canvas gives a clip ([EditorStore.cutoutReveals]). A layer is a bitmap the rasteriser draws, so
 * the reveal is `<img>`s rather than a shader: the old bitmap over the new one, fading to nothing, and
 * a glowing copy of the new one fading in and out under it (`.pv__layer--ghost`, `.pv__layer--glow`).
 *
 * What starts one is the BITMAP changing while the store says the layer's cutout is being revealed -
 * its matte arrived, or the Cutout sheet opened on a matte already made - not the reveal itself, which
 * comes before the bitmap does. A bitmap drawn twice for one reveal plays it once.
 */
export class PhotoReveals {
  /** The photo as it was, by layer id, for each reveal under way. */
  readonly ghosts = signal<ReadonlyMap<string, RevealGhost>>(new Map());

  /** What each layer on screen showed at the last update. */
  private readonly shown = new Map<string, RevealGhost>();
  /** The reveal each layer last played, by the moment it was asked for. */
  private readonly played = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** @param reveals the store's [EditorStore.cutoutReveals], read when a bitmap changes. */
  constructor(private readonly reveals: () => ReadonlyMap<string, number>) {}

  /** Called with every list of layers the preview draws; starts a reveal where a photo's bitmap has just changed under one. */
  update(layers: readonly ShownLayer[]): void {
    const now = performance.now();
    const seen = new Set<string>();
    for (const layer of layers) {
      if (layer.effect) continue;
      seen.add(layer.id);
      const before = this.shown.get(layer.id);
      this.shown.set(layer.id, { png: layer.png, width: layer.width, aspect: layer.aspect });
      if (!before || before.png === layer.png) continue;
      const asked = this.reveals().get(layer.id);
      if (asked === undefined || now - asked > REVEAL_WINDOW_MS || this.played.get(layer.id) === asked) continue;
      this.played.set(layer.id, asked);
      this.start(layer.id, before);
    }
    // A layer off screen comes back as it is: a change made while it was away is not news.
    for (const id of [...this.shown.keys()]) if (!seen.has(id)) this.shown.delete(id);
  }

  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.shown.clear();
  }

  private start(id: string, ghost: RevealGhost): void {
    const running = this.timers.get(id);
    if (running) clearTimeout(running);
    this.ghosts.value = new Map(this.ghosts.peek()).set(id, ghost);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        const next = new Map(this.ghosts.peek());
        next.delete(id);
        this.ghosts.value = next;
      }, PHOTO_REVEAL_MS),
    );
  }
}
