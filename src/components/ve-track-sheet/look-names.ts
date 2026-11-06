import type { TrackLook } from '../../editor';
import type { EditorIconName } from '../../icons/icons';

/**
 * What each look a track can put on its thing is called, and the glyph it is drawn with: its tool on the
 * track's row, its chip on the Track sheet, and the mark beside the track's name on the timeline. Offered in
 * `TRACK_LOOKS`'s order everywhere.
 *
 * Here rather than beside the sheet, because a Stencil component's module may export nothing but the
 * component.
 */
export const TRACK_LOOK_NAMES: Readonly<Record<TrackLook['kind'], { label: string; icon: EditorIconName }>> = {
  // An eye shut: what a blur on a face is for.
  blur: { label: 'Blur', icon: 'eye-off-outline' },
  spotlight: { label: 'Spotlight', icon: 'sunny-outline' },
  pop: { label: 'Colour pop', icon: 'color-palette-outline' },
};
