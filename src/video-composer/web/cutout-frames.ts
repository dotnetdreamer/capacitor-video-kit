import { outlineSigma } from '../../editor/cutout-pixels';
import { matteAt, type MatteTrack } from '../../editor/matte-track';
import type { ComposeCutout } from '../definitions';

import type { CutoutDraw } from './cutout-gl';

/** Tells one reader's grids from another's in a [CutoutDraw.matteKey]. */
let readers = 0;

/**
 * One clip's cutout read frame by frame: what the painter is handed for the clip at any source time -
 * the contract's steps 1 and 2 ([matteAt]) and the look - shared by the web render and the editor's
 * preview, so the two draw a cutout from the same numbers.
 *
 * The grid is filled into one of two arrays of the reader's own, in turn, rather than a new one a
 * frame, for `FocusFrames`' reason: a playing preview asks sixty times a second, and a synthesised
 * frame asks for two at once, each of which the painter uploads before the next call can come.
 */
export class CutoutFrames {
  private readonly grids: [Uint8Array, Uint8Array];
  private turn = 0;
  private readonly id = ++readers;
  private readonly outline: CutoutDraw['outline'];

  constructor(
    readonly track: MatteTrack,
    readonly cutout: ComposeCutout,
  ) {
    const cells = track.width * track.height;
    this.grids = [new Uint8Array(cells), new Uint8Array(cells)];
    const line = cutout.outline;
    if (line && line.width > 0) {
      const sigma = outlineSigma(line.width, track.width, track.height);
      this.outline = { color: line.color, sigma, spread: 0.04 / Math.max(1, sigma) };
    } else {
      this.outline = null;
    }
  }

  /**
   * The cutout at source time `sourceMs` of the clip's file. Throws `MatteTrackError` for a frame of
   * the track that does not decode.
   */
  at(sourceMs: number): CutoutDraw {
    const grid = this.grids[this.turn]!;
    this.turn ^= 1;
    matteAt(this.track, sourceMs, grid);
    // The same frames and the same distance between them are the same grid, so a paused preview
    // drawing one frame again uploads nothing.
    const span = this.track.span(sourceMs);
    return {
      matte: grid,
      matteWidth: this.track.width,
      matteHeight: this.track.height,
      matteKey: `${this.id}:${span.from}:${span.to}:${Math.round(span.weight * 1000)}`,
      soft: this.cutout.soft ?? 0,
      shift: this.cutout.shift ?? 0,
      fill: this.cutout.fill ?? null,
      outline: this.outline,
    };
  }
}
