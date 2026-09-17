import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * No component may declare a member an element already has.
 *
 * Under `dist-custom-elements` - the build every host application in this repository loads - a
 * component class IS its element: the generated `defineCustomElement` hands the class itself to
 * `customElements.define`, so every field and method it declares lands on the element and REPLACES
 * whatever `HTMLElement` had by that name.
 *
 * This is written as a source check rather than as a component test because the two builds disagree
 * about it and only one of them can be tested here. The lazy build used by `stencil-test` wraps the
 * instance in a proxy element, so `elm.remove` there is still `HTMLElement.prototype.remove` and a
 * component that shadows it behaves perfectly in every test in this package while failing in every
 * application. The class declaration is the one place the two builds share, so it is where this is
 * checked.
 *
 * It was `ve-layout-sheet`'s `remove`, the handler behind the layout sheet's Remove button. Stencil's
 * vdom takes a sheet off the screen with `elm.remove()`, so confirming the Layout sheet - or leaving
 * it any other way - called that handler instead: the second video was thrown off the post, silently,
 * and the sheet stayed in the document because nothing had actually removed it.
 *
 * The names come from `lib.dom.d.ts` rather than from a list kept here, so a member the platform adds
 * later (`moveBefore` is the recent one) is covered without anybody remembering to add it.
 */

/**
 * The components, which are the classes that become elements. Nothing else in the package does.
 *
 * This file sits in `build/` rather than beside them because it reads them: `src/tsconfig.json` is
 * what Stencil compiles the editor with, so a test in there that imports `node:fs` would be asking
 * for Node's types in the editor's own program, and would be emitted into `dist/collection`.
 */
const COMPONENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components');

/** Every source file under `src/components`, tests aside. What is a component is decided below. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(path) && !path.includes('.test.')) out.push(path);
  }
  return out;
}

/**
 * Every member name an element carries, read from TypeScript's own DOM library: `HTMLElement` and
 * everything it inherits, down through `Element`, `Node` and `EventTarget` and across the mixins
 * (`GlobalEventHandlers`, `ARIAMixin`, `ChildNode`, ...) that carry `onclick`, `role` and `remove`.
 */
function elementMembers(): Set<string> {
  const libDom = join(dirname(ts.getDefaultLibFilePath({})), 'lib.dom.d.ts');
  const source = ts.createSourceFile(libDom, readFileSync(libDom, 'utf8'), ts.ScriptTarget.Latest, true);

  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  source.forEachChild(node => {
    if (ts.isInterfaceDeclaration(node)) interfaces.set(node.name.text, node);
  });

  const names = new Set<string>();
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const declaration = interfaces.get(name);
    if (!declaration) return;
    for (const member of declaration.members) {
      if (member.name && ts.isIdentifier(member.name)) names.add(member.name.text);
    }
    for (const clause of declaration.heritageClauses ?? []) {
      for (const type of clause.types) {
        if (ts.isIdentifier(type.expression)) walk(type.expression.text);
      }
    }
  };
  walk('HTMLElement');
  return names;
}

/** A `@Component({...})` class, which is the only kind of class that becomes an element. */
function isComponent(node: ts.ClassDeclaration): boolean {
  return (ts.getDecorators(node) ?? []).some(decorator => {
    const call = decorator.expression;
    return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'Component';
  });
}

/** What a component declares: fields, methods and accessors, by the name they are reached through. */
function declaredMembers(file: string): { className: string; member: string }[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: { className: string; member: string }[] = [];
  source.forEachChild(node => {
    if (!ts.isClassDeclaration(node) || !node.name || !isComponent(node)) return;
    for (const member of node.members) {
      if (ts.isConstructorDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue;
      // Static members sit on the class rather than on the element, so they shadow nothing.
      const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
      if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) continue;
      found.push({ className: node.name.text, member: member.name.text });
    }
  });
  return found;
}

describe('a component class is its element', () => {
  const files = sourceFiles(COMPONENTS_DIR);
  const components = files.flatMap(file => declaredMembers(file).map(found => found.className));

  it('finds the components to check', () => {
    // Every tag in the package, so a glob that stopped matching fails here instead of passing
    // twenty components it never opened.
    expect(new Set(components).size).toBeGreaterThan(15);
  });

  it('declares no member that would replace one of the element’s own', () => {
    const dom = elementMembers();
    // Stencil's own hooks, which every component may declare: they are the framework's names for
    // this class, not the element's, and none of them is on `HTMLElement`.
    expect(dom.has('connectedCallback')).toBe(false);
    expect(dom.has('render')).toBe(false);
    // The two that started this, so a lib.dom.d.ts that stopped being readable fails here rather
    // than quietly passing every component.
    expect(dom.has('remove')).toBe(true);
    expect(dom.has('scrollTo')).toBe(true);

    const clashes: string[] = [];
    for (const file of files) {
      for (const { className, member } of declaredMembers(file)) {
        if (dom.has(member)) clashes.push(`${relative(COMPONENTS_DIR, file)}: ${className}.${member}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('reads the DOM library it checks against', () => {
    expect(existsSync(join(dirname(ts.getDefaultLibFilePath({})), 'lib.dom.d.ts'))).toBe(true);
  });
});
