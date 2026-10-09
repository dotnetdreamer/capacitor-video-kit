/**
 * One tab in a sheet's head.
 *
 * It lives in a `.ts` of its own rather than beside the component that draws it because four sheets
 * name this type and a `.tsx` is a component module: `src/components.d.ts` is generated with an
 * import for every type a `@Prop` mentions, so a `SheetTab` declared in `ve-sheet.tsx` would put an
 * import of a custom element's source file into the generated types, and from there into all three
 * framework wrappers, which then carry a component they never render.
 *
 * The frame draws a tab and reports which one was pressed. Everything a tab means - whether it
 * filters a grid, switches a panel or clears a search - belongs to the sheet that listed it.
 */
export interface SheetTab {
  /** What `veTab` carries back, and what the sheet compares `activeTab` against. */
  readonly id: string;

  /** What is printed on the tab. */
  readonly label: string;
}

/**
 * One step of a sheet being dragged by its grabber or its head, which `veSheetDrag` carries. Here
 * rather than in `ve-sheet.tsx` for the reason [SheetTab] is.
 *
 * The frame only reports the finger. How tall that makes the sheet, and where it settles, is the
 * shell's: it is the one that knows the column the sheet sits in.
 */
export interface SheetDrag {
  /**
   * `start` once the finger has moved far enough up or down to be a drag, `move` after that, and
   * `end` when it lifts. `cancel` is the browser taking the touch back, which is nothing the
   * customer chose: the sheet goes back to where it was.
   */
  readonly phase: 'start' | 'move' | 'end' | 'cancel';

  /** How far the finger is from where it went down, in CSS pixels. Down is positive. */
  readonly dy: number;

  /** How fast it was moving over its last few events, in CSS pixels a millisecond. Down is positive. */
  readonly velocity: number;
}
