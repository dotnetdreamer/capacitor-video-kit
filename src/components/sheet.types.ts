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
