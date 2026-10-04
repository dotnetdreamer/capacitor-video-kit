import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every name the editor gives a control has to reach Android's accessibility tree, because that is
 * where TalkBack reads it and where the Maestro flows find the control by it.
 *
 * Chrome's Android layer does not put every name in the same place. A name made of an element's own
 * text is the node's text, whatever the role. A name from `aria-label` becomes the content
 * description only on the roles Chromium lets a label stand in for their text: button, switch,
 * radio, checkbox, tab, link, menu item and image among them (`SupportsNamingWithChildContent` and
 * `ComputeAndroidNameTo` in Chromium). On any other role the label goes to Android's supplemental
 * description, which uiautomator and Maestro do not read, and on WebView 151 on Android 17 those
 * controls arrived with no name at all:
 *
 * - `aria-pressed` makes a `<button>` a toggle button and `aria-haspopup` a pop-up button, and
 *   neither is on that list. The volume sheet's Mute, the voiceover sheet's Record voiceover, a
 *   sound's Play and the text sheet's Font were ToggleButtons with no text and no description.
 * - A `<div>` or `<span>` with no role is a generic, which ARIA does not allow a name on at all.
 *   The voiceover take on the timeline and the sound sheet's "On this post" tick had no name.
 *
 * The fixes this asks for are the two the kit uses: a toggle is named by its own text (a hidden
 * copy in `.sheet__hidden-name` when it shows only an icon), and a labelled div or span is given
 * the role of what it is.
 *
 * Some controls stay on the supplemental description on purpose, and the last block below holds
 * them there: the slider, the progress bars, the timeline's "Video length" separator and the text
 * fields. Their names are not lost for Google's TalkBack, which reads the supplemental description.
 * On WebView 153 with TalkBack 17 (the emulator, 2026-09-30) the volume sheet's sliders were
 * "80%. Volume. Slider" and "1.0s. Fade out duration. Slider", and the text sheet's field "Enter
 * text. Editing. Text. Edit box"; the progress bars and the separator take the same path in
 * Chromium's source. Only uiautomator cannot see them, and no markup moves a slider's or a field's
 * name into the node's text without costing the listener something (see the Host in ve-slider.tsx
 * and the field in ve-text-sheet.tsx), so the Maestro flows reach those two by where they are and
 * by the field's own focus instead. Samsung's own TalkBack on 153 has not been tried, and is the
 * open risk: if it skips the supplemental description, these controls have no name there.
 *
 * Written as a source check, like element-members.unit.test.ts beside it, because the rule is about
 * the markup a component writes in every state it can be in, and most of those states are never on
 * screen in a component test. The component tests pin the named controls themselves.
 */

const COMPONENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components');

/** The component sources, tests aside. Only `.tsx` files hold markup. */
function markupFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...markupFiles(path));
    else if (path.endsWith('.tsx') && !path.includes('.test.')) out.push(path);
  }
  return out;
}

/**
 * One element as it is written. An attribute maps to its value when that is a plain string, and to
 * `null` when it is an expression, whose value is only known when the component runs.
 */
interface Written {
  readonly where: string;
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string | null>;
}

function elementsIn(file: string): Written[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Written[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = new Map<string, string | null>();
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const value = attr.initializer;
        attrs.set(attr.name.getText(source), value && ts.isStringLiteral(value) ? value.text : null);
      }
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      out.push({ where: `${relative(COMPONENTS_DIR, file)}:${line}`, tag: node.tagName.getText(source), attrs });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The attributes that turn a button into a role Android's WebView will not name from a label. */
const STATE_ON_A_BUTTON = ['aria-pressed', 'aria-haspopup', 'aria-expanded'];

/** The elements whose role is generic when none is written: a label on one of these is no name. */
const GENERIC_TAGS = new Set(['div', 'span']);

/**
 * The one element written with a label and a button state on it, and why that is safe. A toolbar
 * tile is labelled only while it is "coming soon", and `soonTile` never makes a tile that toggles
 * or opens a menu, so the two never meet on screen. Checked below to still be there, so this list
 * cannot go on excusing an element that has since changed.
 */
const EXCUSED: readonly { file: string; is: (el: Written) => boolean }[] = [{ file: 've-toolbar/ve-toolbar.tsx', is: el => el.tag === 'button' && el.attrs.has('data-tile') }];

function excused(el: Written): boolean {
  return EXCUSED.some(entry => el.where.startsWith(`${entry.file}:`) && entry.is(el));
}

describe('every name reaches Android', () => {
  const elements = markupFiles(COMPONENTS_DIR).flatMap(elementsIn);
  const labelled = elements.filter(el => el.attrs.has('aria-label'));

  it('finds the labels to check', () => {
    // Most of the editor's icon buttons, so a parse that stopped finding JSX fails here instead of
    // passing a package it never read.
    expect(labelled.length).toBeGreaterThan(40);
    expect(elements.filter(el => el.attrs.has('aria-pressed')).length).toBeGreaterThan(10);
  });

  it('never labels a toggle or a menu button, whose label Android drops', () => {
    const found = labelled
      .filter(el => STATE_ON_A_BUTTON.some(name => el.attrs.has(name)))
      // A role written beside the state is the role Android sees, and "button" is still the toggle.
      .filter(el => !el.attrs.has('role') || el.attrs.get('role') === 'button')
      .filter(el => !excused(el))
      .map(el => el.where);
    expect(found).toEqual([]);
  });

  it('puts aria-checked only on a role that has a checked state', () => {
    // A plain `<button>` has no checked state, so the attribute is dropped and the choice is lost.
    // The kit's checked controls are `role="switch"` and `role="radio"`, and both take a label.
    const found = elements.filter(el => el.attrs.has('aria-checked') && !el.attrs.has('role')).map(el => el.where);
    expect(found).toEqual([]);
  });

  it('never labels a div or a span that has no role', () => {
    const found = labelled.filter(el => GENERIC_TAGS.has(el.tag) && !el.attrs.has('role')).map(el => el.where);
    expect(found).toEqual([]);
  });

  it('still needs every excuse it makes', () => {
    for (const entry of EXCUSED) {
      const still = labelled.filter(el => el.where.startsWith(`${entry.file}:`) && entry.is(el) && STATE_ON_A_BUTTON.some(name => el.attrs.has(name)));
      expect(still, entry.file).toHaveLength(1);
    }
  });
});

describe('a hidden name stays hidden', () => {
  const CLASS = 'sheet__hidden-name';
  const sheetCss = readFileSync(join(COMPONENTS_DIR, 'sheet-common.css'), 'utf8');

  it('is defined where the sheets share their rules', () => {
    expect(sheetCss).toMatch(new RegExp(`\\.${CLASS}\\s*\\{[^}]*clip-path: inset\\(50%\\)`));
  });

  it('is only used by a component that loads that stylesheet', () => {
    // Without the rule the hidden copy is ordinary text, and the button prints its own name beside
    // its icon. A shadow root cannot inherit a rule, so each user has to list the file itself.
    const users = markupFiles(COMPONENTS_DIR).filter(file => readFileSync(file, 'utf8').includes(`class="${CLASS}"`));
    expect(users.length).toBeGreaterThan(3);
    const missing = users.filter(file => !readFileSync(file, 'utf8').includes(`'../sheet-common.css'`)).map(file => relative(COMPONENTS_DIR, file));
    expect(missing).toEqual([]);
  });
});

/**
 * The roles whose name Chromium keeps in the supplemental description, where Google's TalkBack reads
 * it and uiautomator does not, and which are meant to stay there (see the header, and its Samsung
 * caveat). `meter` is not in the kit yet; it is here so that the first one is held to the same
 * rules.
 */
const RANGE_ROLES = new Set(['slider', 'progressbar', 'meter', 'separator']);

/** A text field's node text is what has been typed, so its name is never there either. */
const FIELD_TAGS = new Set(['textarea', 'input']);

describe('a range control or a text field keeps its name where TalkBack reads it', () => {
  const elements = markupFiles(COMPONENTS_DIR).flatMap(elementsIn);
  const ranges = elements.filter(el => RANGE_ROLES.has(el.attrs.get('role') ?? ''));
  const fields = elements.filter(el => FIELD_TAGS.has(el.tag));

  it('finds the controls to check', () => {
    // The slider, the progress bar, the spinner, the export still and the timeline's end; the text
    // sheet's field and the sheet frame's search.
    expect(ranges.length).toBeGreaterThanOrEqual(5);
    expect(fields.length).toBeGreaterThanOrEqual(2);
  });

  it('names every range control by aria-label', () => {
    // The route that was measured. `aria-labelledby` reads the same only while the element it points
    // at is rendered: pointed at one that was not, the slider was heard as "50%. Slider".
    const found = ranges.filter(el => !el.attrs.has('aria-label')).map(el => el.where);
    expect(found).toEqual([]);
  });

  it('never gives one a title', () => {
    // A title changes nothing in Android's tree beside a label, loses a slider's name in place of
    // one (Chromium drops a name from `title` on a range control with `aria-valuetext`), and is a
    // tooltip in every desktop browser.
    const found = [...ranges, ...fields].filter(el => el.attrs.has('title')).map(el => el.where);
    expect(found).toEqual([]);
  });

  it('keeps the slider saying its value in words, beside its label', () => {
    // Without `aria-valuetext` TalkBack reads the raw number - "50.0" - rather than what the sheet
    // formats. It is also why a `title` can never stand in for the label: Chromium drops a name
    // taken from `title` on a range control that has one.
    const slider = ranges.filter(el => el.where.startsWith('ve-slider/ve-slider.tsx:'));
    expect(slider.map(el => el.tag)).toEqual(['Host']);
    expect(slider[0].attrs.get('role')).toBe('slider');
    expect(slider[0].attrs.has('aria-label')).toBe(true);
    expect(slider[0].attrs.has('aria-valuetext')).toBe(true);
  });

  it('names the text sheet’s field "Text", with "Enter text" as its placeholder', () => {
    // What Google's TalkBack reads, as "Enter text. Editing. Text. Edit box". The flows do not look
    // for either on Android; they type into the field the sheet focuses as it opens.
    const field = fields.filter(el => el.tag === 'textarea' && el.where.startsWith('ve-text-sheet/'));
    expect(field).toHaveLength(1);
    expect(field[0].attrs.get('aria-label')).toBe('Text');
    expect(field[0].attrs.get('placeholder')).toBe('Enter text');
  });
});
