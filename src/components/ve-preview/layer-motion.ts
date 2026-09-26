import { overlayMotionAt, type OverlayMotionSample } from '../../editor/motion';
import type { ComposeOverlayMotion } from '../../video-composer/definitions';

import { layerTransform } from './overlay-gestures';

/**
 * A layer as the preview RESTS it: where the render places it when its motion leaves it alone. The
 * same numbers `ve-preview` writes into the layer's `<img>` through the vdom.
 */
export interface RestingLayer {
  id: string;
  /** A full-frame effect: only its opacity ever changes. */
  effect: boolean;
  cx: number;
  cy: number;
  rotationDeg: number;
  opacity: number;
  /**
   * Held at rest whatever its motion says: the text being typed, which has to be READABLE while it
   * is typed - a layer that fades in would otherwise be invisible under a playhead before its window.
   */
  held?: boolean;
}

/**
 * Moves the preview's text, stickers and photos, frame by frame, by writing their `<img>`s' styles
 * directly - never through the vdom.
 *
 * A moving layer changes every frame of its move, and a render per frame of `ve-preview` would diff
 * a dozen conditional blocks and every video element thirty to sixty times a second to change four
 * numbers on one image. So the vdom keeps writing what it always wrote - each layer at REST - and
 * this writes the moving ones over it: after every render (a vdom write puts a layer back at rest),
 * on every animation frame while the post plays, and on every playhead move while it does not.
 * Stencil diffs a style against the one it wrote last rather than against the element, so a value
 * written here stays until the next frame writes another or the vdom has something new to say.
 *
 * The numbers are the render's, through the one reading of the wire both call: `overlayMotionAt` on
 * the motion `toComposeSpec` compiles ([EditorStore.overlayMotions]), turned into CSS by the same
 * maths the painter uses - the centre moved in fractions of the frame (`left`/`top` percentages of
 * the frame are exactly those fractions), the turn added and the size multiplied about the layer's
 * centre (`scale()` after the `translate(-50%, -50%)` that centres it), the opacity multiplied.
 *
 * The selection box and its handles stay at rest: they are how a layer is taken hold of, and a
 * handle that danced with a pulsing sticker would be a handle nobody could hit.
 */
export class LayerMotion {
  private readonly elements = new Map<string, HTMLElement>();
  private readonly refs = new Map<string, (el?: HTMLElement) => void>();
  private layers: readonly RestingLayer[] = [];
  private motions: ReadonlyMap<string, ComposeOverlayMotion> = new Map();
  /** The layers this has written a pose into, which have to be put back at rest if their motion goes. */
  private readonly moved = new Set<string>();
  private playing = false;
  private rafId = 0;
  private destroyed = false;

  /** @param clock the output instant the preview is showing: the player's, which runs smoothly while it plays. */
  constructor(private readonly clock: () => number) {}

  /**
   * The ref for one layer's `<img>`, made once per id and never again: a fresh arrow every render is
   * a CHANGED ref to the vdom, which would take the element away and hand it back on every repaint.
   */
  refFor(id: string): (el?: HTMLElement) => void {
    const known = this.refs.get(id);
    if (known) return known;
    const made = (el?: HTMLElement) => {
      if (el) this.elements.set(id, el);
      else this.elements.delete(id);
    };
    this.refs.set(id, made);
    return made;
  }

  /**
   * What is on screen and how each of it moves, after a render or an edit, and every moving layer put
   * where it is at this instant. Nothing is kept for a layer that has left.
   */
  update(layers: readonly RestingLayer[], motions: ReadonlyMap<string, ComposeOverlayMotion>): void {
    this.layers = layers;
    this.motions = motions;
    const shown = new Set(layers.map(layer => layer.id));
    for (const id of this.refs.keys()) if (!shown.has(id) && !this.elements.has(id)) this.refs.delete(id);
    // A layer whose animation was just taken away, or that is now held at rest, may have been left
    // mid move, and the vdom, which has written nothing new for it, will not put it back.
    for (const layer of layers) {
      const el = this.elements.get(layer.id);
      if (el && this.moved.has(layer.id) && !this.moves(layer)) {
        writePose(el, layer, null);
        this.moved.delete(layer.id);
      }
    }
    for (const id of this.moved) if (!shown.has(id)) this.moved.delete(id);
    this.syncLoop();
    this.apply();
  }

  /** While playing, a frame per animation frame; stopped, only when the playhead or the post moves. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.syncLoop();
    this.apply();
  }

  /** Every moving layer on screen, at `atMs` - the clock's instant unless told otherwise. */
  apply(atMs: number = this.clock()): void {
    if (this.destroyed || this.motions.size === 0) return;
    for (const layer of this.layers) {
      const motion = layer.held ? undefined : this.motions.get(layer.id);
      const el = motion && this.elements.get(layer.id);
      if (!motion || !el) continue;
      writePose(el, layer, overlayMotionAt(motion, atMs));
      this.moved.add(layer.id);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.elements.clear();
    this.refs.clear();
    this.moved.clear();
  }

  private moves(layer: RestingLayer): boolean {
    return !layer.held && this.motions.has(layer.id);
  }

  /** The frame loop runs only while the post plays AND something on screen moves. */
  private syncLoop(): void {
    const wanted = this.playing && !this.destroyed && this.layers.some(layer => this.moves(layer));
    if (wanted && !this.rafId) {
      const tick = () => {
        this.rafId = requestAnimationFrame(tick);
        this.apply();
      };
      this.rafId = requestAnimationFrame(tick);
    } else if (!wanted && this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }
}

/**
 * One layer's `<img>` at `pose`, or at rest for none - in which case every string is the one the
 * vdom writes, character for character, so a layer that has finished moving is exactly where a
 * layer that never moved is.
 */
export function writePose(el: HTMLElement, layer: RestingLayer, pose: OverlayMotionSample | null): void {
  const opacity = String(pose ? layer.opacity * pose.opacity : layer.opacity);
  if (el.style.opacity !== opacity) el.style.opacity = opacity;
  if (layer.effect) return;
  const left = `${(layer.cx + (pose?.x ?? 0)) * 100}%`;
  const top = `${(layer.cy + (pose?.y ?? 0)) * 100}%`;
  const transform = pose ? `${layerTransform(layer.rotationDeg + pose.rotation)} scale(${pose.scale})` : layerTransform(layer.rotationDeg);
  if (el.style.left !== left) el.style.left = left;
  if (el.style.top !== top) el.style.top = top;
  if (el.style.transform !== transform) el.style.transform = transform;
}
