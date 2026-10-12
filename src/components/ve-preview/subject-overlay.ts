import { cameraAt } from '../../editor/camera';
import type { SubjectTrack } from '../../editor/subject-track';
import { WHOLE_FRAME, type LayerDraw } from '../../video-composer/web/painter';
import { pictureDest } from '../../video-composer/web/geometry';
import { LayerMap } from '../../video-composer/web/layer-map';
import type { EditorStore, PreviewVideoLayer } from '../../state/editor-store';
import { subjectRgb } from '../../state/subject-colours';
import { movedLayer } from './preview-canvas';

/**
 * The subjects of the clip the Focus sheet is open on, outlined on the preview in their colours and
 * numbered, and a tap on the picture answered with the subject under it.
 *
 * Chrome, not picture: it is a canvas of its own over the preview's, drawn only while the sheet is
 * open and the post is paused - which is when the customer is choosing - and cleared otherwise. Both
 * the drawing and the tap go through [LayerMap], the painter's own placement run backwards, so the
 * outline is where the footage is drawn however the clip is cropped, fitted, placed, turned or zoomed
 * into, and a tap names the subject the customer can see under the finger.
 *
 * The outline is worked out a pixel at a time at a quarter of the screen's pixels and drawn up, which
 * on a paused frame is a few milliseconds and keeps it from disagreeing with the tap by a single
 * pixel; the numbers are drawn after, at full size, so they stay sharp.
 */

/** How much of the screen's pixels the outline is worked out at, on each side. */
const OUTLINE_SCALE = 0.5;

/** A subject's place on the picture this frame: its id, and where its number goes in output pixels. */
interface Shown {
  id: number;
  x: number;
  y: number;
}

export class SubjectOverlay {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly outline = document.createElement('canvas');
  private pending = false;
  private destroyed = false;
  /** What the last draw drew, for [hitAt]: the map, the track and the frame's cells. */
  private last: { map: LayerMap; track: SubjectTrack; cells: Uint8Array } | null = null;

  constructor(
    private readonly store: EditorStore,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext('2d');
  }

  /** Draws on the next animation frame. Asking twice before it runs still draws once. */
  request(): void {
    if (this.pending || this.destroyed) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  /** The subject under frame point (`fx`, `fy`), 0..1 of the frame, or null for none. */
  hitAt(fx: number, fy: number): number | null {
    const last = this.last;
    if (!last) return null;
    const output = this.store.output.value;
    const point = last.map.toSource(fx * output.width, fy * output.height);
    if (!point) return null;
    const id = cellAt(last.cells, last.track, point.u, point.v);
    return id > 0 ? id : null;
  }

  destroy(): void {
    this.destroyed = true;
    this.last = null;
    this.outline.width = 0;
    this.outline.height = 0;
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || this.destroyed) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(width * ratio));
    const h = Math.max(1, Math.round(height * ratio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    this.last = null;

    const store = this.store;
    if (store.panel.value !== 'focus' || store.playing.value) return;
    const clip = store.focusClip.value;
    const state = store.focusTrack.value;
    if (!clip?.focus || state?.status !== 'ready' || state.result.subjects.length === 0) return;
    const resting = store.previewLayers.value.find(layer => layer.clipId === clip.id);
    const output = store.output.value;
    const motions = store.layoutMotions.value;
    const layer = resting && motions.size > 0 ? movedLayer(resting, motions, store.playheadMs.value, output) : resting;
    if (!layer) return;

    const track = state.track;
    const draw = geometry(layer, track, store.frameAspect.value, store.cameraLive.value ? cameraAt(store.camera.value, store.playheadMs.value) : null);
    const map = new LayerMap(draw, output);
    const sourceMs = clip.image ? 0 : layer.sourceMs;
    let cells: Uint8Array;
    try {
      cells = track.frame(track.span(sourceMs).from);
    } catch {
      return;
    }
    this.last = { map, track, cells };

    const inFocus = new Set(store.focusSubjectsNow.value);
    this.drawOutline(ctx, map, track, cells, inFocus, output, w, h);
    this.drawNumbers(ctx, shownSubjects(track, cells, map), inFocus, output, w, h);
  }

  /**
   * Each subject's cells as they fall on the screen: tinted in its colour, more strongly at its edge,
   * and more strongly again when it is in focus, worked out pixel by pixel at [OUTLINE_SCALE].
   */
  private drawOutline(ctx: CanvasRenderingContext2D, map: LayerMap, track: SubjectTrack, cells: Uint8Array, inFocus: ReadonlySet<number>, output: { width: number; height: number }, w: number, h: number): void {
    const ow = Math.max(1, Math.round(w * OUTLINE_SCALE));
    const oh = Math.max(1, Math.round(h * OUTLINE_SCALE));
    if (this.outline.width !== ow || this.outline.height !== oh) {
      this.outline.width = ow;
      this.outline.height = oh;
    }
    const octx = this.outline.getContext('2d');
    if (!octx) return;
    const image = octx.createImageData(ow, oh);
    const data = image.data;
    const gw = track.width;
    const gh = track.height;
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const point = map.toSource(((x + 0.5) / ow) * output.width, ((y + 0.5) / oh) * output.height);
        if (!point) continue;
        const cx = Math.min(gw - 1, Math.floor(point.u * gw));
        const cy = Math.min(gh - 1, Math.floor(point.v * gh));
        const id = cells[cy * gw + cx]!;
        if (id === 0) continue;
        // An edge cell is one with a neighbour that is somebody else, or nobody.
        const edge =
          (cx > 0 && cells[cy * gw + cx - 1] !== id) ||
          (cx < gw - 1 && cells[cy * gw + cx + 1] !== id) ||
          (cy > 0 && cells[(cy - 1) * gw + cx] !== id) ||
          (cy < gh - 1 && cells[(cy + 1) * gw + cx] !== id);
        const focused = inFocus.has(id);
        const [r, g, b] = subjectRgb(id);
        const i = (y * ow + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = edge ? (focused ? 235 : 150) : focused ? 70 : 28;
      }
    }
    octx.putImageData(image, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.outline, 0, 0, w, h);
    ctx.restore();
  }

  /** Each subject's number in a disc of its colour, where the subject's middle is on the screen. */
  private drawNumbers(ctx: CanvasRenderingContext2D, shown: readonly Shown[], inFocus: ReadonlySet<number>, output: { width: number; height: number }, w: number, h: number): void {
    const radius = Math.max(10, Math.round(Math.min(w, h) * 0.035));
    ctx.save();
    ctx.font = `700 ${Math.round(radius * 1.1)}px system-ui, Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const subject of shown) {
      const x = (subject.x / output.width) * w;
      const y = (subject.y / output.height) * h;
      if (x < -radius || y < -radius || x > w + radius || y > h + radius) continue;
      const [r, g, b] = subjectRgb(subject.id);
      const focused = inFocus.has(subject.id);
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = radius * 0.5;
      ctx.fillStyle = focused ? `rgb(${r},${g},${b})` : 'rgba(20,20,22,0.82)';
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(2, radius * 0.16);
      ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.stroke();
      ctx.fillStyle = focused ? '#000' : '#fff';
      ctx.fillText(String(subject.id), x, y + 1);
    }
    ctx.restore();
  }
}

/**
 * The geometry the painter draws `layer` with, built as `layerDraw` builds it, with the track's grid
 * standing in for the source's size: the grid has the oriented source's shape, which is all the
 * placement reads.
 */
function geometry(layer: PreviewVideoLayer, track: SubjectTrack, frameAspect: number, camera: LayerDraw['camera']): Pick<LayerDraw, 'framing' | 'dest' | 'sourceWidth' | 'sourceHeight' | 'rotationDeg' | 'camera'> {
  const common = { sourceWidth: track.width, sourceHeight: track.height, rotationDeg: layer.rect?.rotationDeg ?? 0, camera };
  if (layer.trackId === null) {
    return { ...common, framing: { fit: layer.fit, crop: layer.crop ?? undefined, rect: layer.rect ?? undefined }, dest: WHOLE_FRAME };
  }
  const framing = { fit: layer.fit, crop: layer.crop ?? undefined };
  return { ...common, framing, dest: pictureDest(layer.rect ?? WHOLE_FRAME, framing, frameAspect, track.width, track.height) };
}

/** The subject in the cell under source point (`u`, `v`), 0 for nobody. */
function cellAt(cells: Uint8Array, track: SubjectTrack, u: number, v: number): number {
  const cx = Math.min(track.width - 1, Math.max(0, Math.floor(u * track.width)));
  const cy = Math.min(track.height - 1, Math.max(0, Math.floor(v * track.height)));
  return cells[cy * track.width + cx]!;
}

/** Every subject in this frame and where its number goes: the middle of its cells, on the output. */
function shownSubjects(track: SubjectTrack, cells: Uint8Array, map: LayerMap): Shown[] {
  const sums = new Map<number, { x: number; y: number; n: number }>();
  for (let c = 0; c < cells.length; c++) {
    const id = cells[c]!;
    if (id === 0) continue;
    const sum = sums.get(id) ?? { x: 0, y: 0, n: 0 };
    sum.x += c % track.width;
    sum.y += Math.floor(c / track.width);
    sum.n++;
    sums.set(id, sum);
  }
  const shown: Shown[] = [];
  for (const [id, sum] of sums) {
    const at = map.toOutput((sum.x / sum.n + 0.5) / track.width, (sum.y / sum.n + 0.5) / track.height);
    shown.push({ id, x: at.x, y: at.y });
  }
  return shown.sort((a, b) => a.id - b.id);
}
