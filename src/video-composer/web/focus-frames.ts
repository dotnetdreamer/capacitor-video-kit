import { focusLevels, focusMask, type SubjectTrack } from '../../editor/subject-track';
import type { ComposeFocus } from '../definitions';

import type { FocusDraw } from './focus-gl';

/** Tells one reader's masks from another's in a [FocusDraw.maskKey]. */
let readers = 0;

/**
 * One clip's focus read frame by frame: what the painter is handed for the clip at any source time -
 * the contract's steps 1 to 3 ([focusLevels], [focusMask]) and the look - shared by the web render
 * and the editor's preview, so the two draw a focus from the same numbers.
 *
 * The cell grid is filled into one of two arrays of the reader's own, in turn, rather than a new one
 * a frame: a playing preview asks sixty times a second, and a synthesised frame asks for two at once,
 * each of which the painter uploads before the next call for the same layer can come.
 */
export class FocusFrames {
  private readonly levels = new Float32Array(256);
  private readonly grids: [Uint8Array, Uint8Array];
  private turn = 0;
  private readonly id = ++readers;

  constructor(
    readonly track: SubjectTrack,
    readonly focus: ComposeFocus,
  ) {
    const cells = track.width * track.height;
    this.grids = [new Uint8Array(cells), new Uint8Array(cells)];
  }

  /**
   * The focus at source time `sourceMs` of the clip's file. Throws `SubjectTrackError` for a frame of
   * the track that does not decode.
   */
  at(sourceMs: number): FocusDraw {
    const focus = this.focus;
    focusLevels(focus, sourceMs, this.levels);
    const grid = this.grids[this.turn]!;
    this.turn ^= 1;
    focusMask(this.track, this.levels, sourceMs, focus.invert === true, grid);
    // The same frames, the same distance between them and the same levels are the same grid, so a
    // paused preview drawing one frame again uploads nothing.
    const span = this.track.span(sourceMs);
    let key = `${this.id}:${span.from}:${span.to}:${Math.round(span.weight * 1000)}`;
    for (const subject of focus.subjects) key += `:${Math.round(this.levels[subject.id]! * 1000)}`;
    return {
      mask: grid,
      maskWidth: this.track.width,
      maskHeight: this.track.height,
      maskKey: key,
      blur: focus.blur,
      mono: focus.mono ?? 0,
      dim: focus.dim ?? 0,
    };
  }
}
