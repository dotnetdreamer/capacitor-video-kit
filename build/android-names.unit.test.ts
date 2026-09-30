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
