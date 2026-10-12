/**
 * The colour each subject is shown in while the Focus sheet is open: its outline on the preview and
 * its chip on the sheet, so the customer can tell which chip is which person. Ids run from 1 and the
 * colours repeat past the eighth, which no track has (`MAX_SUBJECTS`). Bright on purpose - they are
 * drawn over footage of any colour, with a dark edge around the numbers.
 */
const SUBJECT_COLOURS: readonly (readonly [number, number, number])[] = [
  [255, 210, 63],
  [61, 194, 255],
  [255, 92, 200],
  [46, 230, 166],
  [255, 138, 61],
  [155, 92, 255],
  [166, 255, 46],
  [255, 59, 92],
];

/** Subject `id`'s colour as 0..255 RGB. */
export function subjectRgb(id: number): readonly [number, number, number] {
  return SUBJECT_COLOURS[(Math.max(1, Math.round(id)) - 1) % SUBJECT_COLOURS.length]!;
}

/** Subject `id`'s colour as a CSS colour. */
export function subjectColour(id: number): string {
  const [r, g, b] = subjectRgb(id);
  return `rgb(${r}, ${g}, ${b})`;
}
