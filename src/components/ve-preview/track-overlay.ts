import type { ReadonlySignal } from '@preact/signals-core';

import {
  TRACK_HUES,
  UNSURE_BELOW,
  lostAt,
  sureAt,
  trackById,
  trackStretches,
  trackedFootage,
  trackedThingAt,
  type EditTrack,
  type TrackScene,
  type TrackStretch,
} from '../../editor';
import { squareToQuad } from '../../editor/homography';
import type { EditorStore, TrackPersonBox } from '../../state/editor-store';
import type { TrackAim } from '../../state/editor.types';
import type { DropTarget } from './overlay-gestures';

/**
 * The Track sheet on the picture: the box the customer aims, the run as it reads the footage, and the path
 * of the track the sheet shows - which may have come from a layer, from the track's own row, or from the
 * main row's Track tool, with no layer at all.
 *
 * Chrome, not picture, like the Focus sheet's outlines: a canvas of its own over the preview's, drawn while
 * the sheet is open or a layer is dragged over things it can be pinned to, and cleared otherwise. One look
 * for each thing the customer is doing:
 *
 *  - CHOOSING: each of the post's tracks boxed where its thing is, in its own colour, so the sheet's chips
 *    name things the customer can see.
 *  - AIMING: the picture dims everywhere but the box, so what will be followed is the one bright part of
 *    the frame; brackets at its corners - the accent for a new track, the track's colour for a fix -
 *    handles to size it by, a dot at its middle. The people the finder found are lifted out of the dimming
 *    and outlined, to say a tap aims at them. A tap locks on: the box closes to a small square at the
 *    finger while its fit is worked out, then opens out round the thing.
 *  - RUNNING: the frame being read, grey, laid over the picture through the clip's own framing, with the
 *    box riding along on it and the way it has come trailing behind - the run watched, not waited for.
 *    Where the thing is lost the box goes amber and dashed, and finds it again.
 *  - TRACK: the path over the stretch of the post its footage plays in, coloured by how sure the tracker
 *    was - the track's colour where sure, amber where unsure, red and dotted where it lost the thing -
 *    solid behind the playhead and faint ahead of it, and the box round the thing now in the track's
 *    colour, red and dashed where the thing was lost.
 *  - DROPPING, with the sheet shut: a text, sticker or photo dragged over the picture lights up each thing
 *    it can be pinned to, boxed faintly in its track's colour with its name in a pill above it, and the one
 *    under the finger bright, "Drop to pin" beside its name, its brackets swelling once as it lights up.
 *
 * Everything is placed through the same arithmetic the render places the footage with ([trackedFootage]),
 * so the box is where the thing is however the clip is cropped, fitted, placed, turned or zoomed into.
 *
 * Drawn on demand, a frame at a time, and on a cheap phone: a path is worked out once per track, post and
 * canvas size and kept, rather than once a frame, and a box locking on asks for frames only while it moves.
 */

/** How dark the picture outside the box goes while it is aimed. */
const SPOTLIGHT = 'rgba(0, 0, 0, 0.42)';

/** How much of that dark is taken off the people the finder found, so they stand out as things to tap. */
const PERSON_LIFT = 'rgba(0, 0, 0, 0.35)';

/** How often the path is read, across the stretch of the post it is drawn over. */
const PATH_STEP_MS = 1000 / 15;

/** The lock-on: the box opens out from a square this many CSS pixels across at the finger, over this long. */
const LOCK_SQUARE_PX = 36;
const LOCK_MS = 180;

/** As the box lands, its brackets swell and settle over this long. */
const PULSE_MS = 260;

/**
 * While the fit is worked out the square at the finger breathes, once in [BREATHE_MS] - for at most
 * [BREATHE_FOR_MS], so a fit that never lands does not cost a frame of drawing for ever.
 */
const BREATHE_MS = 900;
const BREATHE_FOR_MS = 4000;

/** How strong a thing a dragged layer can be dropped on is drawn while the finger is not on it. */
const FAINT = 0.5;

/** As the finger reaches a thing to drop on, its brackets swell and settle over this long. */
const LIGHT_MS = 200;

/** The pill naming a thing to drop on: its height and its type size, in CSS pixels. */
const PILL_PX = 20;
const PILL_FONT_PX = 11;

/** A pill's ground while its thing is one of those on offer, and its ink while the finger is on it. */
const PILL_GROUND = 'rgba(0, 0, 0, 0.6)';
const PILL_INK = '#0b0b0b';
const PILL_INK_SOFT = 'rgba(11, 11, 11, 0.72)';

/** Beside the name of the thing under the finger: what letting go does. */
const DROP_HINT = 'Drop to pin';

/** The track colours the tokens name (`--ve-track-0` on), for a page that does not load them. */
const FALLBACK_HUES = ['#a6ff2e', '#4dd8ff', '#ff6bd6', '#c77dff', '#6b8cff', '#5cffc8'];

/** A track's health at a point of its path, as [healthAt] codes it: a byte a point. */
const SURE = 0;
const UNSURE = 1;
const LOST = 2;

/** No dashes: one array, handed to `setLineDash` as often as it likes, which copies it. */
const NO_DASH: number[] = [];

/**
 * A layer being dragged over the picture, as the preview's gestures report it: what it can be dropped on to
 * pin it to a track, and the track whose thing the finger is over.
 */
export interface TrackDrop {
  targets: ReadonlySignal<readonly DropTarget[]>;
  hot: ReadonlySignal<string | null>;
}

export class TrackOverlay {
  private readonly ctx: CanvasRenderingContext2D | null;
  /** The frame a run is reading, as a picture: the luma laid into grey RGBA. */
  private readonly frame = document.createElement('canvas');
  private frameImage: ImageData | null = null;
  private pending = false;
  private destroyed = false;
  /** The tokens' colours, read once the canvas is in a styled page; see [colours]. */
  private palette: Palette | null = null;
  /** Whether the customer asked for less motion: a box then lands where it lands, without opening out or swelling. */
  private readonly calm: MediaQueryList | null;
  /** The lock-on being drawn - the store's own object, so a new tap is a new one - and when it was first drawn. */
  private lock: { of: object; start: number } | null = null;
  /** The track's stretches of the post, kept while the track and the post are the same objects. */
  private stretches: { track: EditTrack; manifest: TrackScene['manifest']; list: TrackStretch[] } | null = null;
  /** The path last worked out, kept while its track, the post, its stretch and the canvas's size are the same. */
  private path: PathPoints | null = null;
  /** The thing to drop on that the finger is over, and when it lit up: what its swell is timed from. */
  private lit: { id: string; start: number } | null = null;

  constructor(
    private readonly store: EditorStore,
    private readonly canvas: HTMLCanvasElement,
    /** A layer being dragged with the sheet shut; see [drawTargets]. */
    private readonly drop: TrackDrop | null = null,
  ) {
    this.ctx = canvas.getContext('2d');
    this.calm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
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

  destroy(): void {
    this.destroyed = true;
    this.frame.width = 0;
    this.frame.height = 0;
    this.frameImage = null;
    this.path = null;
    this.stretches = null;
    this.lock = null;
    this.lit = null;
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || this.destroyed) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const store = this.store;
    if (store.panel.value !== 'track') {
      this.lock = null;
      // With the sheet shut, all there is to draw is a layer being dragged over things it can be pinned to.
      const targets = this.drop?.targets.value;
      if (targets && targets.length > 0) this.drawTargets(ctx, this.viewOf(w, h, ratio), targets, this.drop?.hot.value ?? null);
      else this.lit = null;
      return;
    }
    this.lit = null;
    const view = this.viewOf(w, h, ratio);
    if (store.trackRun.value) {
      if (store.surfaceRunning.value) this.drawSurfaceRun(ctx, view);
      else this.drawRun(ctx, view);
      return;
    }
    if (store.trackChoosing.value) {
      this.drawChoices(ctx, view);
      return;
    }
    const shown = store.trackShown.value;
    // Four corners: a flat surface being aimed, tracked again, or shown.
    if (store.surfaceAiming.value) {
      if (!shown || store.trackAimMoved.value) this.drawSurfaceAim(ctx, view, shown);
      else this.drawShownSurface(ctx, view, shown);
      return;
    }
    if (!shown || store.trackAimMoved.value) {
      this.drawAim(ctx, view, shown);
      return;
    }
    this.drawPath(ctx, shown, view, false);
    const thing = store.trackThing.value;
    if (!thing) return;
    // In the track's colour, unsure or not - the path says where it was unsure, and a box that turned amber
    // and back as the playhead crossed a doubtful stretch would flicker - and red and dashed where it lost
    // the thing, which the path dots in the same red.
    const lost = lostAt(shown, thing.sourceMs);
    this.drawBox(ctx, thing.corners.map(c => ({ x: c.x * w, y: c.y * h })), view, boxStyle(lost ? view.colours.lost : hueOf(shown, view), 6 * ratio, { dashed: lost }));
  }

  /**
   * What a frame is drawn with: the canvas's size, the tokens' colours, the time, and whether to keep still.
   * Only once there is something to draw, so a canvas that only ever clears never reads the tokens.
   */
  private viewOf(w: number, h: number, ratio: number): View {
    return { w, h, ratio, colours: this.colours(), now: performance.now(), calm: !!this.calm?.matches };
  }

  /**
   * The tokens' colours, read off the page once: a style lookup is a style recalculation, and the playhead
   * asks for a frame thirty times a second. Kept only once the canvas is in the document, before which
   * every value read is its fallback.
   */
  private colours(): Palette {
    if (this.palette) return this.palette;
    const style = getComputedStyle(this.canvas);
    const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
    const palette: Palette = {
      accent: read('--ve-accent', '#a6ff2e'),
      hues: FALLBACK_HUES.map((fallback, i) => read(`--ve-track-${i}`, fallback)),
      unsure: read('--ve-track-unsure', '#ffb340'),
      lost: read('--ve-track-lost', '#ff4d6a'),
      font: style.fontFamily || 'system-ui, sans-serif',
    };
    if (this.canvas.isConnected) this.palette = palette;
    return palette;
  }

  /**
   * A box being aimed - a new track's, or a track's being fixed, over its faint path - and the people a tap
   * can aim at while the finder has them. A box a tap put there locks on: a small square at the finger
   * while its fit is worked out, then opening out round the thing, its brackets swelling as it lands.
   */
  private drawAim(ctx: CanvasRenderingContext2D, view: View, fixing: EditTrack | null): void {
    const store = this.store;
    const aim = store.shownAim();
    if (!aim) return;
    const r = view.ratio;
    let corners = aimCorners(aim, view.w, view.h);
    let pulse = 0;
    let settled = true;
    const lock = store.trackLockOn.value;
    // Only while the box is still the one the tap put there: a drag since has it now.
    if (lock && lock.aim === store.trackAim.value) {
      if (this.lock?.of !== lock) this.lock = { of: lock, start: view.now };
      const since = view.now - this.lock.start;
      const square = squareAt(lock.x * view.w, lock.y * view.h, (LOCK_SQUARE_PX * r) / 2);
      if (!lock.fitted) {
        corners = square;
        settled = false;
        if (!view.calm && since < BREATHE_FOR_MS) {
          pulse = 0.5 - 0.5 * Math.cos((2 * Math.PI * since) / BREATHE_MS);
          this.request();
        }
      } else if (!view.calm && since < Math.max(LOCK_MS, PULSE_MS)) {
        if (since < LOCK_MS) corners = between(square, corners, easeOut(since / LOCK_MS));
        if (since < PULSE_MS) pulse = Math.sin((Math.PI * since) / PULSE_MS);
        this.request();
      }
    } else {
      this.lock = null;
    }
    this.drawSpotlight(ctx, corners, view);
    if (store.trackPeople.value === 'ready') this.drawPeople(ctx, view, settled ? aim : null);
    if (fixing) this.drawPath(ctx, fixing, view, true);
    this.drawBox(ctx, corners, view, boxStyle(fixing ? hueOf(fixing, view) : view.colours.accent, 10 * r, { handles: settled, pulse }));
  }

  /**
   * Four corners being put on a flat surface - a new surface's in the accent, a surface's being tracked again
   * in its colour over its faint path: the picture dimmed everywhere but the quad, its edges, a faint grid of
   * the plane inside it, and a handle at each corner to drag.
   */
  private drawSurfaceAim(ctx: CanvasRenderingContext2D, view: View, again: EditTrack | null): void {
    const corners = this.store.shownSurfaceAim();
    if (!corners) return;
    const quad = pointsOf(corners, view.w, view.h);
    ctx.save();
    ctx.fillStyle = SPOTLIGHT;
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.globalCompositeOperation = 'destination-out';
    polygonPath(ctx, quad);
    ctx.fill();
    ctx.restore();
    if (again) this.drawPath(ctx, again, view, true);
    drawPlane(ctx, quad, view, again ? hueOf(again, view) : view.colours.accent, { handles: true, dashed: false });
  }

  /** A surface track's quad at the playhead in its colour, its plane's grid inside - red and dashed where it was lost - over its path. */
  private drawShownSurface(ctx: CanvasRenderingContext2D, view: View, track: EditTrack): void {
    this.drawPath(ctx, track, view, false);
    const thing = this.store.surfaceThing.value;
    if (!thing) return;
    const lost = lostAt(track, thing.sourceMs);
    drawPlane(ctx, pointsOf(thing.corners, view.w, view.h), view, lost ? view.colours.lost : hueOf(track, view), { handles: false, dashed: lost });
  }

  /** A surface run as it reads: the frame being read through the clip's framing, the way the surface's middle has come, and the quad on it. */
  private drawSurfaceRun(ctx: CanvasRenderingContext2D, view: View): void {
    const store = this.store;
    const run = store.trackRun.value!;
    const again = run.trackId ? trackById(store.manifest.value, run.trackId) : null;
    const colour = again ? hueOf(again, view) : view.colours.accent;
    const live = store.surfaceLive.value;
    if (!live) {
      // Before the first frame: the corners as they were put down, so nothing jumps.
      const corners = store.surfaceAim.value;
      if (corners) drawPlane(ctx, pointsOf(corners, view.w, view.h), view, colour, { handles: false, dashed: false });
      return;
    }
    const output = store.output.value;
    const footage = trackedFootage({ clipId: run.clipId, clipKey: run.clipKey, aspect: live.frame.width / live.frame.height }, store.trackScene.value, run.outputMs);
    if (!footage) return;
    const k = view.w / output.width;
    const map = footage.map;
    const at = (u: number, v: number): Point => {
      const out = map.toOutput(u, v);
      return { x: out.x * k, y: out.y * k };
    };
    const picture = this.framePicture(live.frame.width, live.frame.height, live.frame.luma);
    if (picture) {
      ctx.save();
      polygonPath(
        ctx,
        map.outline().map(p => ({ x: p.x * k, y: p.y * k })),
      );
      ctx.clip();
      const o = at(0, 0);
      const ex = at(1, 0);
      const ey = at(0, 1);
      ctx.setTransform((ex.x - o.x) / picture.width, (ex.y - o.y) / picture.width, (ey.x - o.x) / picture.height, (ey.y - o.y) / picture.height, o.x, o.y);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(picture, 0, 0);
      ctx.restore();
    }
    const trail = live.trail;
    if (trail.length > 1) {
      const points = trail.map(p => ({ ...at(p.x, p.y), lost: p.lost }));
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      strokeRuns(ctx, points, colour, view.colours.unsure, 9 * view.ratio, () => 0.16);
      strokeRuns(ctx, points, colour, view.colours.unsure, 3 * view.ratio, i => 0.3 + 0.7 * (i / (points.length - 1)));
      ctx.restore();
    }
    const quad = [0, 1, 2, 3].map(c => at(live.corners[2 * c]!, live.corners[2 * c + 1]!));
    drawPlane(ctx, quad, view, live.lost ? view.colours.unsure : colour, { handles: false, dashed: live.lost });
  }

  /** The picture dimmed everywhere but the box. */
  private drawSpotlight(ctx: CanvasRenderingContext2D, corners: Point[], view: View): void {
    ctx.save();
    ctx.fillStyle = SPOTLIGHT;
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.globalCompositeOperation = 'destination-out';
    roundedPath(ctx, corners, 10 * view.ratio);
    ctx.fill();
    ctx.restore();
  }

  /**
   * The people the finder found at the playhead, lifted out of the dimming and softly outlined, so they read
   * as things to tap. One the box is already round is left to the box.
   */
  private drawPeople(ctx: CanvasRenderingContext2D, view: View, aim: TrackAim | null): void {
    const people = this.store.trackPeopleBoxes.value;
    if (people.length === 0) return;
    const r = view.ratio;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = PERSON_LIFT;
    for (const person of people) {
      if (aim && boxedBy(person, aim)) continue;
      roundedPath(ctx, aimCorners(person, view.w, view.h), 12 * r);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.5 * r;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    for (const person of people) {
      if (aim && boxedBy(person, aim)) continue;
      roundedPath(ctx, aimCorners(person, view.w, view.h), 12 * r);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** While the sheet asks which track to follow: each track whose thing is on screen boxed in its colour, so a chip names something to see. */
  private drawChoices(ctx: CanvasRenderingContext2D, view: View): void {
    const store = this.store;
    const scene = store.trackScene.value;
    const at = store.playheadMs.value;
    for (const track of store.tracks.value) {
      if (!trackStretches(track, scene.manifest).some(stretch => at >= stretch.startMs && at <= stretch.endMs)) continue;
      const thing = trackedThingAt(track, scene, at);
      if (thing) this.drawBox(ctx, thing.corners.map(c => ({ x: c.x * view.w, y: c.y * view.h })), view, boxStyle(hueOf(track, view), 6 * view.ratio));
    }
  }

  /**
   * A layer being dragged with the sheet shut: every thing it can be dropped on boxed faintly in its track's
   * colour with its name in a pill above it, so the customer sees what letting go there would pin the layer
   * to - and the one under the finger bright, "Drop to pin" beside its name, its brackets swelling once as it
   * lights up and not again while the finger stays on it. Drawn last, so it is on top of any it overlaps.
   */
  private drawTargets(ctx: CanvasRenderingContext2D, view: View, targets: readonly DropTarget[], hot: string | null): void {
    if (this.lit?.id !== hot) this.lit = hot ? { id: hot, start: view.now } : null;
    let pulse = 0;
    if (this.lit && !view.calm) {
      const since = view.now - this.lit.start;
      if (since < LIGHT_MS) {
        pulse = Math.sin((Math.PI * since) / LIGHT_MS);
        this.request();
      }
    }
    let lit: DropTarget | null = null;
    for (const target of targets) {
      if (target.trackId === hot) lit = target;
      else this.drawTarget(ctx, view, target, false, 0);
    }
    if (lit) this.drawTarget(ctx, view, lit, true, pulse);
  }

  /** One thing a dragged layer can be dropped on: its box, faint unless the finger is on it, and its name. */
  private drawTarget(ctx: CanvasRenderingContext2D, view: View, target: DropTarget, hot: boolean, pulse: number): void {
    const colour = hueOf(target, view);
    ctx.save();
    if (!hot) ctx.globalAlpha = FAINT;
    this.drawBox(
      ctx,
      target.corners.map(c => ({ x: c.x * view.w, y: c.y * view.h })),
      view,
      boxStyle(colour, 6 * view.ratio, { pulse }),
    );
    ctx.restore();
    this.drawPill(ctx, view, target, colour, hot);
  }

  /**
   * The name over a thing to drop on, in a pill: dark with a dot of the track's colour while it is one of the
   * things on offer, and in the track's colour with "Drop to pin" after the name while the finger is on it.
   * Placed by [pillSpot].
   */
  private drawPill(ctx: CanvasRenderingContext2D, view: View, target: DropTarget, colour: string, hot: boolean): void {
    const r = view.ratio;
    const strong = `600 ${PILL_FONT_PX * r}px ${view.colours.font}`;
    const plain = `500 ${PILL_FONT_PX * r}px ${view.colours.font}`;
    const pad = 8 * r;
    const gap = 6 * r;
    const dot = 3 * r;
    ctx.save();
    ctx.font = strong;
    const nameWidth = ctx.measureText(target.name).width;
    ctx.font = plain;
    const hintWidth = hot ? ctx.measureText(DROP_HINT).width : 0;
    // On offer: a dot of the track's colour, then the name. Under the finger: the name, then what letting go does.
    const lead = hot ? 0 : dot * 2 + gap;
    const width = pad * 2 + lead + nameWidth + (hot ? gap + hintWidth : 0);
    const height = PILL_PX * r;
    const at = pillSpot({ cx: target.cx * view.w, top: target.top * view.h, bottom: target.bottom * view.h }, width, height, view.w, view.h, gap, 4 * r);
    roundedPath(
      ctx,
      [
        { x: at.x, y: at.y },
        { x: at.x + width, y: at.y },
        { x: at.x + width, y: at.y + height },
        { x: at.x, y: at.y + height },
      ],
      height / 2,
    );
    ctx.fillStyle = hot ? colour : PILL_GROUND;
    ctx.fill();
    const middle = at.y + height / 2;
    if (!hot) {
      ctx.beginPath();
      ctx.arc(at.x + pad + dot, middle, dot, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
    }
    ctx.textBaseline = 'middle';
    ctx.font = strong;
    ctx.fillStyle = hot ? PILL_INK : '#fff';
    ctx.fillText(target.name, at.x + pad + lead, middle);
    if (hot) {
      ctx.font = plain;
      ctx.fillStyle = PILL_INK_SOFT;
      ctx.fillText(DROP_HINT, at.x + pad + nameWidth + gap, middle);
    }
    ctx.restore();
  }

  /**
   * The box: a thin outline, brackets at its corners in its colour, a dot at its middle. Being aimed, it has
   * white handles at the corners to size it by; lost, its outline is dashed in its colour. `pulse`, 0..1,
   * swells the brackets and their glow.
   */
  private drawBox(ctx: CanvasRenderingContext2D, corners: Point[], view: View, style: BoxStyle): void {
    const r = view.ratio;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // The outline, quiet: the brackets are what is looked at.
    roundedPath(ctx, corners, style.radius);
    ctx.lineWidth = 1.5 * r;
    ctx.strokeStyle = style.dashed ? style.colour : 'rgba(255, 255, 255, 0.85)';
    if (style.dashed) ctx.setLineDash([6 * r, 5 * r]);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);

    // The brackets, a third of each side and never more than 22px, glowing a little: one path, so the
    // glow is worked out once rather than once a corner.
    ctx.lineWidth = 3.5 * r * (1 + 0.5 * style.pulse);
    ctx.strokeStyle = style.colour;
    ctx.shadowColor = style.colour;
    ctx.shadowBlur = 8 * r * (1 + style.pulse);
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const at = corners[i]!;
      const prev = corners[(i + 3) % 4]!;
      const next = corners[(i + 1) % 4]!;
      const toPrev = towards(at, prev, Math.min(22 * r, distance(at, prev) / 3));
      const toNext = towards(at, next, Math.min(22 * r, distance(at, next) / 3));
      ctx.moveTo(toPrev.x, toPrev.y);
      ctx.lineTo(at.x, at.y);
      ctx.lineTo(toNext.x, toNext.y);
    }
    ctx.stroke();

    // The middle.
    const mid = centre(corners);
    ctx.beginPath();
    ctx.arc(mid.x, mid.y, 4 * r, 0, Math.PI * 2);
    ctx.fillStyle = style.colour;
    ctx.fill();
    ctx.shadowBlur = 0;

    // The handles, on a box that can be sized.
    if (style.handles) {
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 4 * r;
      for (const at of corners) {
        ctx.beginPath();
        ctx.arc(at.x, at.y, 5 * r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * The path the track's thing takes over its stretch of the post at the playhead - the nearest one, where
   * the playhead is between two - coloured by how sure the tracker was: solid up to the playhead, dotted and
   * fainter after it, red and dotted wherever the thing was lost. Fainter still while a fix is being aimed.
   */
  private drawPath(ctx: CanvasRenderingContext2D, track: EditTrack, view: View, faint: boolean): void {
    const path = this.pathOf(track, view);
    if (!path || path.n < 2) return;
    // The first point ahead of the playhead.
    const now = this.store.playheadMs.value;
    let lo = 0;
    let hi = path.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (path.ts[mid]! <= now) lo = mid + 1;
      else hi = mid;
    }
    const split = lo;
    const r = view.ratio;
    const strength = faint ? 0.45 : 0.9;
    const colours = { sure: hueOf(track, view), unsure: view.colours.unsure, lost: view.colours.lost };
    const dots = [1, 6 * r];
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Each half takes in the point either side of the playhead, so the two meet.
    strokeHealth(ctx, path, 0, Math.min(path.n - 1, split), colours, 2.5 * r, strength, false, dots);
    strokeHealth(ctx, path, Math.max(0, split - 1), path.n - 1, colours, 2 * r, strength * 0.6, true, dots);
    ctx.restore();
  }

  /** The points of `track`'s path over its stretch of the post nearest the playhead, worked out once and kept; see [path]. */
  private pathOf(track: EditTrack, view: View): PathPoints | null {
    const store = this.store;
    const scene = store.trackScene.value;
    const stretch = this.stretchOf(track, scene.manifest, store.playheadMs.value);
    if (!stretch) return null;
    const kept = this.path;
    if (kept && kept.track === track && kept.scene === scene && kept.w === view.w && kept.h === view.h && kept.startMs === stretch.startMs && kept.endMs === stretch.endMs) return kept;
    const count = Math.max(2, Math.ceil((stretch.endMs - stretch.startMs) / PATH_STEP_MS) + 1);
    const path: PathPoints = {
      track,
      scene,
      w: view.w,
      h: view.h,
      startMs: stretch.startMs,
      endMs: stretch.endMs,
      xs: new Float32Array(count),
      ys: new Float32Array(count),
      ts: new Float64Array(count),
      health: new Uint8Array(count),
      n: 0,
    };
    for (let k = 0; k < count; k++) {
      const t = Math.min(stretch.endMs, stretch.startMs + k * PATH_STEP_MS);
      const thing = trackedThingAt(track, scene, t);
      if (!thing) continue;
      path.xs[path.n] = thing.cx * view.w;
      path.ys[path.n] = thing.cy * view.h;
      path.ts[path.n] = t;
      path.health[path.n] = healthAt(track, thing.sourceMs);
      path.n++;
    }
    this.path = path;
    return path;
  }

  /** The stretch of the post `track`'s footage plays in at output `now`, or the nearest one; null for a track whose footage has gone. */
  private stretchOf(track: EditTrack, manifest: TrackScene['manifest'], now: number): TrackStretch | null {
    let kept = this.stretches;
    if (!kept || kept.track !== track || kept.manifest !== manifest) {
      kept = { track, manifest, list: trackStretches(track, manifest) };
      this.stretches = kept;
    }
    let best: TrackStretch | null = null;
    let gap = Infinity;
    for (const stretch of kept.list) {
      const off = now < stretch.startMs ? stretch.startMs - now : now > stretch.endMs ? now - stretch.endMs : 0;
      if (off < gap) {
        gap = off;
        best = stretch;
      }
    }
    return best;
  }

  /** A run as it reads: the frame being read through the clip's framing, the way it has come, and the box on it. */
  private drawRun(ctx: CanvasRenderingContext2D, view: View): void {
    const store = this.store;
    const run = store.trackRun.value!;
    // A fix in its track's colour; a new track, which has none yet, in the accent.
    const fixed = run.trackId ? trackById(store.manifest.value, run.trackId) : null;
    const colour = fixed ? hueOf(fixed, view) : view.colours.accent;
    const r = view.ratio;
    const live = store.trackLive.value;
    if (!live) {
      // Before the first frame: the box as it was aimed, so nothing jumps.
      const aim = store.shownAim();
      if (aim) {
        const corners = aimCorners(aim, view.w, view.h);
        this.drawSpotlight(ctx, corners, view);
        this.drawBox(ctx, corners, view, boxStyle(colour, 6 * r));
      }
      return;
    }
    const output = store.output.value;
    const footage = trackedFootage({ clipId: run.clipId, clipKey: run.clipKey, aspect: live.frame.width / live.frame.height }, store.trackScene.value, run.outputMs);
    if (!footage) return;
    const k = view.w / output.width;
    const map = footage.map;
    const at = (u: number, v: number): Point => {
      const out = map.toOutput(u, v);
      return { x: out.x * k, y: out.y * k };
    };

    // The frame, grey, cut to where the clip draws.
    const picture = this.framePicture(live.frame.width, live.frame.height, live.frame.luma);
    if (picture) {
      ctx.save();
      polygonPath(
        ctx,
        map.outline().map(p => ({ x: p.x * k, y: p.y * k })),
      );
      ctx.clip();
      const o = at(0, 0);
      const ex = at(1, 0);
      const ey = at(0, 1);
      ctx.setTransform((ex.x - o.x) / picture.width, (ex.y - o.y) / picture.width, (ey.x - o.x) / picture.height, (ey.y - o.y) / picture.height, o.x, o.y);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(picture, 0, 0);
      ctx.restore();
    }

    // The way it has come, glowing behind the box, its oldest stretch faintest, amber where it was lost.
    // The glow is a wide faint stroke under the line rather than a canvas shadow, which blurs every stroke
    // it is on and, on a phone, cost more than following the thing did.
    const trail = live.trail;
    if (trail.length > 1) {
      const points = trail.map(p => ({ ...at(p.x, p.y), lost: p.lost }));
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      strokeRuns(ctx, points, colour, view.colours.unsure, 9 * r, () => 0.16);
      strokeRuns(ctx, points, colour, view.colours.unsure, 3 * r, i => 0.3 + 0.7 * (i / (points.length - 1)));
      ctx.restore();
    }

    // The box on the frame, turned with the thing only for a layer that turns with it (see `trackedThingAt`).
    const box = live.box;
    const rad = store.trackLayer.value?.follow?.turnWith ? (box.angle * Math.PI) / 180 : 0;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const aspect = live.frame.width / live.frame.height;
    const hw = (box.w * aspect) / 2;
    const hh = box.h / 2;
    const corners = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([x, y]) => at(box.cx + (x! * cos - y! * sin) / aspect, box.cy + x! * sin + y! * cos));
    this.drawBox(ctx, corners, view, live.lost ? boxStyle(view.colours.unsure, 6 * r, { dashed: true }) : boxStyle(colour, 6 * r));
  }

  /** The run's frame as a picture: its luma laid into a grey canvas the size it was read at. */
  private framePicture(width: number, height: number, luma: Uint8Array): HTMLCanvasElement | null {
    const fctx = this.frame.getContext('2d');
    if (!fctx) return null;
    if (this.frame.width !== width || this.frame.height !== height || !this.frameImage) {
      this.frame.width = width;
      this.frame.height = height;
      this.frameImage = fctx.createImageData(width, height);
    }
    // A pixel a write: grey is the same byte three times, under an opaque alpha, whichever way round
    // the platform keeps its bytes.
    const pixels = new Uint32Array(this.frameImage.data.buffer);
    const opaque = LITTLE_ENDIAN ? 0xff000000 : 0x000000ff;
    const shift = LITTLE_ENDIAN ? 0 : 8;
    for (let i = 0; i < luma.length; i++) {
      const v = luma[i]!;
      pixels[i] = (opaque | (((v << 16) | (v << 8) | v) << shift)) >>> 0;
    }
    fctx.putImageData(this.frameImage, 0, 0);
    return this.frame;
  }
}

/** Corners as fractions of the frame (x0, y0, ...) as points on a canvas `w` by `h`. */
function pointsOf(corners: readonly number[], w: number, h: number): Point[] {
  return [0, 1, 2, 3].map(k => ({ x: corners[2 * k]! * w, y: corners[2 * k + 1]! * h }));
}

/** How many cells each way the grid of a surface's plane is drawn in. */
const PLANE_CELLS = 4;

/**
 * A flat surface's quad: a faint grid of its own plane inside - straight lines, since a plane's lines stay
 * straight in perspective, which is what makes it read as a surface and not a box - its edges in white,
 * dashed in `colour` where it was lost, and at each corner a dot in `colour`, a white-ringed handle to drag
 * while it is being put down.
 */
function drawPlane(ctx: CanvasRenderingContext2D, quad: Point[], view: View, colour: string, style: { handles: boolean; dashed: boolean }): void {
  const r = view.ratio;
  const h = squareToQuad(quad.flatMap(p => [p.x, p.y]));
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (h) {
    const at = (u: number, v: number): Point => {
      const w = h[6]! * u + h[7]! * v + h[8]!;
      return { x: (h[0]! * u + h[1]! * v + h[2]!) / w, y: (h[3]! * u + h[4]! * v + h[5]!) / w };
    };
    ctx.beginPath();
    for (let i = 1; i < PLANE_CELLS; i++) {
      const f = i / PLANE_CELLS;
      for (const [a, b] of [
        [at(f, 0), at(f, 1)],
        [at(0, f), at(1, f)],
      ] as const) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    }
    ctx.lineWidth = 1 * r;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.stroke();
  }
  polygonPath(ctx, quad);
  ctx.lineWidth = 1.5 * r;
  ctx.strokeStyle = style.dashed ? colour : 'rgba(255, 255, 255, 0.9)';
  if (style.dashed) ctx.setLineDash([6 * r, 5 * r]);
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
  // The corners, glowing a little in the colour: where the surface is held.
  ctx.shadowColor = colour;
  ctx.shadowBlur = 8 * r;
  ctx.fillStyle = colour;
  for (const p of quad) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, (style.handles ? 7 : 4) * r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (style.handles) {
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2 * r;
    ctx.strokeStyle = '#fff';
    for (const p of quad) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7 * r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Whether this platform keeps a 32-bit word's lowest byte first, which is how a pixel's red lands first. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** How sure `track` was of its thing at SOURCE `sourceMs`: [SURE], [UNSURE] or [LOST]. */
function healthAt(track: EditTrack, sourceMs: number): number {
  if (lostAt(track, sourceMs)) return LOST;
  return sureAt(track, sourceMs) * 100 < UNSURE_BELOW ? UNSURE : SURE;
}

/** The colour `track` is drawn in: its row's, its box's and its followers' marks'. */
function hueOf(track: Pick<EditTrack, 'hue'>, view: View): string {
  const hue = ((Math.round(track.hue) % TRACK_HUES) + TRACK_HUES) % TRACK_HUES;
  return view.colours.hues[hue] ?? view.colours.accent;
}

/**
 * Points `from`..`to` of a path, stroked once per run of one health - the track's own colour where it was
 * sure, amber where unsure, red where it lost the thing - so a path of hundreds of points is a handful of
 * strokes. Lost runs are dotted always; `dotted` dots the rest too, as the stretch ahead of the playhead is.
 */
function strokeHealth(
  ctx: CanvasRenderingContext2D,
  path: PathPoints,
  from: number,
  to: number,
  colours: { sure: string; unsure: string; lost: string },
  width: number,
  alpha: number,
  dotted: boolean,
  dots: number[],
): void {
  if (to - from < 1) return;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  let start = from;
  for (let i = from + 1; i <= to; i++) {
    if (i < to && path.health[i] === path.health[start]) continue;
    // A run takes in the first point of the next, so the colours meet rather than leave a gap.
    const health = path.health[start]!;
    ctx.beginPath();
    ctx.moveTo(path.xs[start]!, path.ys[start]!);
    for (let k = start + 1; k <= i; k++) ctx.lineTo(path.xs[k]!, path.ys[k]!);
    ctx.strokeStyle = health === LOST ? colours.lost : health === UNSURE ? colours.unsure : colours.sure;
    ctx.setLineDash(dotted || health === LOST ? dots : NO_DASH);
    ctx.stroke();
    start = i;
  }
  ctx.setLineDash(NO_DASH);
}

/**
 * A line through `points`, stroked once per run of points of one colour - `colour` where the thing was
 * seen, `lost` where it was not - each run with the alpha `alphaAt` gives its first point, so a line of
 * hundreds of points is a handful of strokes.
 */
function strokeRuns(
  ctx: CanvasRenderingContext2D,
  points: readonly (Point & { lost: boolean })[],
  colour: string,
  lost: string,
  width: number,
  alphaAt: (index: number) => number,
): void {
  if (points.length < 2) return;
  ctx.lineWidth = width;
  // A run ends where the colour changes, and at most every sixteen points so a fade along it shows.
  let start = 0;
  for (let i = 1; i <= points.length; i++) {
    const end = i === points.length || points[i]!.lost !== points[start]!.lost || i - start >= 16;
    if (!end) continue;
    const last = Math.min(i, points.length - 1);
    ctx.beginPath();
    ctx.moveTo(points[start]!.x, points[start]!.y);
    for (let k = start + 1; k <= last; k++) ctx.lineTo(points[k]!.x, points[k]!.y);
    ctx.strokeStyle = points[start]!.lost ? lost : colour;
    ctx.globalAlpha = alphaAt(start);
    ctx.stroke();
    start = last;
    if (i === points.length) break;
  }
}

interface Point {
  x: number;
  y: number;
}

/** The tokens the overlay draws in: see [TrackOverlay.colours]. */
interface Palette {
  accent: string;
  /** `--ve-track-0` to `--ve-track-5`, by [EditTrack.hue]. */
  hues: string[];
  unsure: string;
  lost: string;
  /** The page's type, for the words drawn: the canvas's own font family. */
  font: string;
}

interface View {
  w: number;
  h: number;
  ratio: number;
  colours: Palette;
  /** The frame's time, for what moves: the lock-on, and a thing to drop on lighting up. */
  now: number;
  /** The customer asked for less motion. */
  calm: boolean;
}

/** How [TrackOverlay.drawBox] draws a box. */
interface BoxStyle {
  colour: string;
  radius: number;
  /** Lost: the outline dashed, in the colour. */
  dashed: boolean;
  /** Sizable: white handles at the corners. */
  handles: boolean;
  /** 0..1: how much the brackets swell. */
  pulse: number;
}

function boxStyle(colour: string, radius: number, more: Partial<Omit<BoxStyle, 'colour' | 'radius'>> = {}): BoxStyle {
  return { colour, radius, dashed: more.dashed ?? false, handles: more.handles ?? false, pulse: more.pulse ?? 0 };
}

/** A track's path worked out over one stretch of the post, as the canvas draws it; see [TrackOverlay.pathOf]. */
interface PathPoints {
  track: EditTrack;
  scene: TrackScene;
  w: number;
  h: number;
  startMs: number;
  endMs: number;
  /** For each of the first [n] points: where it is on the canvas, its output ms, and [healthAt]'s code. */
  xs: Float32Array;
  ys: Float32Array;
  ts: Float64Array;
  health: Uint8Array;
  n: number;
}

/** The aim's corners in canvas pixels: top-left, top-right, bottom-right, bottom-left. */
export function aimCorners(aim: TrackAim, w: number, h: number): Point[] {
  const x0 = (aim.cx - aim.w / 2) * w;
  const x1 = (aim.cx + aim.w / 2) * w;
  const y0 = (aim.cy - aim.h / 2) * h;
  const y1 = (aim.cy + aim.h / 2) * h;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** A square `half` either way of (`x`, `y`), its corners in [aimCorners]' order: where a lock-on opens out from. */
export function squareAt(x: number, y: number, half: number): Point[] {
  return [
    { x: x - half, y: y - half },
    { x: x + half, y: y - half },
    { x: x + half, y: y + half },
    { x: x - half, y: y + half },
  ];
}

/**
 * Where a pill `width` by `height` goes over a thing to drop on whose box runs from `top` to `bottom` down a
 * canvas `w` by `h`: centred across on the thing, `gap` above the box - or as far under it, where above would
 * put it within `edge` of the top - and never within `edge` of either side. Its top-left corner, in pixels.
 */
export function pillSpot(box: { cx: number; top: number; bottom: number }, width: number, height: number, w: number, h: number, gap: number, edge: number): Point {
  const above = box.top - gap - height;
  const y = above >= edge ? above : Math.min(h - edge - height, box.bottom + gap);
  const x = Math.max(edge, Math.min(w - edge - width, box.cx - width / 2));
  return { x, y };
}

/** Corners `k` of the way from `from` to `to`, corner by corner. */
export function between(from: readonly Point[], to: readonly Point[], k: number): Point[] {
  return from.map((a, i) => ({ x: a.x + (to[i]!.x - a.x) * k, y: a.y + (to[i]!.y - a.y) * k }));
}

/** Quick to start and gentle to land: a cubic ease-out of `t`, held to 0..1. */
export function easeOut(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return 1 - u * u * u;
}

/** Whether `aim` covers most of `person`: the box is already round them, and their own outline would only double it. */
export function boxedBy(person: TrackPersonBox, aim: TrackAim): boolean {
  const across = Math.min(person.cx + person.w / 2, aim.cx + aim.w / 2) - Math.max(person.cx - person.w / 2, aim.cx - aim.w / 2);
  const down = Math.min(person.cy + person.h / 2, aim.cy + aim.h / 2) - Math.max(person.cy - person.h / 2, aim.cy - aim.h / 2);
  return across > 0 && down > 0 && across * down > 0.6 * person.w * person.h;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function towards(from: Point, to: Point, by: number): Point {
  const d = distance(from, to) || 1;
  return { x: from.x + ((to.x - from.x) * by) / d, y: from.y + ((to.y - from.y) * by) / d };
}

function centre(points: Point[]): Point {
  return { x: points.reduce((s, p) => s + p.x, 0) / points.length, y: points.reduce((s, p) => s + p.y, 0) / points.length };
}

function polygonPath(ctx: CanvasRenderingContext2D, points: Point[]): void {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
}

/** A four-cornered shape with its corners rounded by up to `radius`, turned or not. */
function roundedPath(ctx: CanvasRenderingContext2D, corners: Point[], radius: number): void {
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const at = corners[i]!;
    const prev = corners[(i + 3) % 4]!;
    const next = corners[(i + 1) % 4]!;
    const r = Math.min(radius, distance(at, prev) / 2, distance(at, next) / 2);
    const start = towards(at, prev, r);
    const end = towards(at, next, r);
    if (i === 0) ctx.moveTo(start.x, start.y);
    else ctx.lineTo(start.x, start.y);
    ctx.quadraticCurveTo(at.x, at.y, end.x, end.y);
  }
  ctx.closePath();
}
