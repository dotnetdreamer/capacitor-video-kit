import type { EditorPanel } from '../../state/editor.types';

/**
 * The two answers the shell needs that are pure functions of one value: which of the three
 * arrangements the screen is in, and the clock in the transport row.
 *
 * They sit beside the component rather than inside it so that they can be tested without a DOM, and
 * because [PANEL_LAYOUT] is the one table in this package that is silently wrong when it is
 * incomplete: a sheet in the wrong column pushes the video off the screen, and nothing throws.
 */

/**
 * How tall a sheet is allowed to be, and therefore what stays on screen above it.
 *
 * `compact` keeps the preview, the transport and a slim timeline; `tall` takes the screen and the
 * sheet is the only thing on it. Eleven of the fourteen are compact, and the three that are not are the
 * ones with a keyboard or a scrolling list in them.
 *
 * A `Record` rather than the set of compact panels the Angular shell kept, because a `Record` over
 * [EditorPanel] cannot be left incomplete: a thirteenth panel added to that union fails the build
 * here instead of opening into whichever arrangement the set's fallback happened to be.
 */
export const PANEL_LAYOUT: Readonly<Record<EditorPanel, 'compact' | 'tall'>> = {
  filters: 'compact',
  adjust: 'compact',
  crop: 'compact',
  layout: 'compact',
  quality: 'compact',
  effects: 'compact',
  speed: 'compact',
  volume: 'compact',
  opacity: 'compact',
  voiceover: 'compact',
  /* Compact so the dot being dressed stays on the slim timeline above it. */
  transition: 'compact',
  /* The keyboard sits under this one and the sheet has to clear it. */
  text: 'tall',
  /* A scrolling grid of several hundred tiles, with a search field and a category bar. */
  stickers: 'tall',
  /* A scrolling list of kept sounds, which is as long as the customer has made it. */
  sound: 'tall',
};

/** Which of the three arrangements the screen is in. Nothing open is the whole editor. */
export function shellLayout(panel: EditorPanel | null): 'main' | 'compact' | 'tall' {
  return panel ? PANEL_LAYOUT[panel] : 'main';
}

/**
 * `00:07`, TikTok's clock.
 *
 * Rounded DOWN rather than to nearest, so the label never claims a second that has not been reached:
 * at 6.6 seconds the video is still inside its seventh second and a clock reading 00:07 beside a
 * playhead that has not got there is what makes a trim look off by one.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
