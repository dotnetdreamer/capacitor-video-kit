import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FLOW, flowPasses, interpolationBody, type FlowPassName } from '../src/video-composer/web/optical-flow';

/**
 * ONE optical flow, two engines: the web painter's (`optical-flow.ts`, run by `optical-flow-gl.ts`) and
 * Android's (`OpticalFlow.kt`, run by `FlowInterpolator.kt`) have to be the same algorithm with the same
 * constants, or the same post slows down differently on a phone and in a browser. The shaders make that
 * checkable: they are GLSL ES 1.00, which both contexts compile, so the Kotlin copy can be - and is held
 * here to be - the TypeScript's text, line for line. The settings are held field for field, and the two
 * orchestrations are held to running the passes in the same order.
 *
 * WHEN THIS FAILS because a pass or a setting changed in optical-flow.ts: the failure prints the
 * expected text. Copy it into `OpticalFlowShaders` (or the value into `OpticalFlow.FLOW`) and run the
 * Android unit tests, which pin the Kotlin maths to the same numbers as `optical-flow.unit.test.ts`.
 *
 * It sits in `build/` for the reason `element-members.unit.test.ts` does: it reads files with `node:fs`,
 * which the editor's own program has no business importing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ANDROID = join(here, '..', 'android', 'src', 'main', 'java', 'net', 'dotnetdreamer', 'videokit', 'videocomposer');
const kotlin = readFileSync(join(ANDROID, 'OpticalFlow.kt'), 'utf8').replace(/\r\n/g, '\n');
const interpolator = readFileSync(join(ANDROID, 'FlowInterpolator.kt'), 'utf8').replace(/\r\n/g, '\n');
const web = readFileSync(join(here, '..', 'src', 'video-composer', 'web', 'optical-flow-gl.ts'), 'utf8').replace(/\r\n/g, '\n');

/** The Kotlin constant each pass is kept in. */
const KOTLIN_NAMES: Record<FlowPassName, string> = {
  luma: 'LUMA',
  down: 'DOWN',
  exposure: 'EXPOSURE',
  gradient: 'GRADIENT',
  lucasKanade: 'LUCAS_KANADE',
  median: 'MEDIAN',
  consistency: 'CONSISTENCY',
  fill: 'FILL',
  trust: 'TRUST',
  visibility: 'VISIBILITY',
};

/** A raw string `const val NAME = """..."""` out of the Kotlin file. */
function kotlinString(name: string): string | null {
  const match = new RegExp(`const val ${name} = """([\\s\\S]*?)"""`).exec(kotlin);
  return match ? match[1]! : null;
}

/**
 * GLSL as the compiler sees it for this comparison: each line trimmed and the blank ones dropped. Both
 * are exactly what whitespace means to GLSL - a preprocessor line may be indented - so two sources equal
 * here compile to the same program.
 */
function lines(source: string): string[] {
  return source
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

describe('the Android engine’s optical flow is the web engine’s', () => {
  it('finds every shader it is meant to compare, so an empty match cannot pass', () => {
    for (const name of [...Object.values(KOTLIN_NAMES), 'INTERPOLATION_BODY']) expect(kotlinString(name), name).not.toBeNull();
  });

  for (const [pass, source] of Object.entries(flowPasses()) as [FlowPassName, string][]) {
    it(`runs the ${pass} pass from the same text`, () => {
      expect(lines(kotlinString(KOTLIN_NAMES[pass]) ?? ''), `OpticalFlowShaders.${KOTLIN_NAMES[pass]} should be:\n${source}`).toEqual(lines(source));
    });
  }

  it('draws each missing frame from the same text', () => {
    const body = interpolationBody();
    expect(lines(kotlinString('INTERPOLATION_BODY') ?? ''), `OpticalFlowShaders.INTERPOLATION_BODY should be:\n${body}`).toEqual(lines(body));
  });

  it('holds every setting at the same value', () => {
    // With the newline the last setting's line needs to match like the others.
    const block = `${/val FLOW = FlowSettings\(([\s\S]*?)\n {4}\)/.exec(kotlin)?.[1] ?? ''}\n`;
    const values: Record<string, string> = {};
    for (const [, key, value] of block.matchAll(/(\w+) = ([^\n]+?),?\n/g)) values[key!] = value!.trim();
    for (const [key, value] of Object.entries(FLOW)) {
      const actual = values[key];
      expect(actual, `OpticalFlow.FLOW.${key}`).toBeDefined();
      // Kotlin writes 1.0 where JavaScript writes 1; the number is what has to agree.
      if (typeof value === 'number') expect(Number(actual), `OpticalFlow.FLOW.${key}`).toBe(value);
      else if (Array.isArray(value)) expect(actual, `OpticalFlow.FLOW.${key}`).toBe(`listOf(${value.join(', ')})`);
      else expect(actual, `OpticalFlow.FLOW.${key}`).toBe(String(value));
    }
    expect(Object.keys(values).sort()).toEqual(Object.keys(FLOW).sort());
  });

  it('runs the same passes in the same order, into the same targets, from the same inputs', () => {
    const webCalls = webPassCalls();
    const androidCalls = androidPassCalls();
    expect(webCalls.length).toBeGreaterThan(8);
    expect(androidCalls).toEqual(webCalls);
  });

  it('walks the pyramid the same way', () => {
    expect(androidLoops()).toEqual(webLoops());
    expect(webLoops()).toContain('level from levels - 1 down to 0');
  });
});

/*
 * The two orchestrations, read as text and brought to one spelling, so they can be compared call for
 * call. Each engine names things its own way - `scratch.pyramid[0]!.texture` on the web is
 * `s.pyramid[0].texId` on Android, a sampler's name is its position in `SAMPLERS` on the web and is
 * written out on Android - and nothing else is allowed to differ.
 */

interface PassCall {
  pass: string;
  target: string;
  inputs: string[];
  samplers: string[];
  uniforms: string[];
}

/** The text of the bracketed group opening at `open` (which must be the opening bracket). */
function group(text: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced at ${open}`);
}

/** `a, b(c, d), [e]` into its top-level parts. */
function split(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of list) {
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

/** One engine's name for a texture, in the shared spelling. */
function texture(expression: string): string {
  return expression
    .replace(/\s+/g, '')
    .replace(/this\.resultTarget\(result\.flow\)/g, 'result')
    .replace(/this\.resultTarget\(result\.visibility\)/g, 'visibility')
    .replace(/\b(scratch|s)\./g, '')
    .replace(/!+/g, '')
    .replace(/\.(texture|texId)\b/g, '')
    .replace(/\?:/g, '??')
    .replace(/^\((.*)\)$/, '$1');
}

function webPassCalls(): PassCall[] {
  const body = web.slice(web.indexOf('  estimate('));
  const samplers: Record<string, string[]> = {};
  for (const [, name, list] of web.matchAll(/^ {2}(\w+): \[([^\]]*)\],$/gm)) samplers[name!] = split(list!).map(n => n.replace(/'/g, ''));
  return [...body.matchAll(/this\.pass\('/g)].map(match => {
    const args = split(group(body, match.index! + 'this.pass'.length));
    const pass = args[0]!.replace(/'/g, '');
    return {
      pass,
      target: texture(args[1]!),
      inputs: split(group(args[2]!, 0)).map(texture),
      samplers: samplers[pass] ?? [],
      uniforms: [...(args[3] ?? '').matchAll(/(u_\w+):/g)].map(m => m[1]!).sort(),
    };
  });
}

function androidPassCalls(): PassCall[] {
  const body = interpolator.slice(interpolator.indexOf('private fun run('));
  return [...body.matchAll(/pass\(\s*gpu\./g)].map(match => {
    const open = match.index! + 'pass'.length;
    const args = split(group(body, open));
    // The uniforms are set in the lambda after the call, when there is one.
    const after = body.slice(open + group(body, open).length + 2);
    const lambda = /^\s*\{/.test(after) ? group(after, after.indexOf('{')) : '';
    const entries = split(group(args[2]!, args[2]!.indexOf('(')));
    return {
      pass: args[0]!.replace(/^gpu\./, ''),
      target: texture(args[1]!),
      inputs: entries.map(entry => texture(entry.replace(/^"u_\w+"\s+to\s+/, ''))),
      samplers: entries.map(entry => /^"(u_\w+)"/.exec(entry)![1]!),
      uniforms: [...lambda.matchAll(/set\w*Uniform\("(u_\w+)"/g)].map(m => m[1]!).sort(),
    };
  });
}

/** The loop headers of the orchestration, as `variable from a (up to|down to) b`. */
function webLoops(): string[] {
  const body = web.slice(web.indexOf('  estimate('), web.indexOf('  release('));
  return [...body.matchAll(/for \(let (\w+) = ([^;]+); \1 (<|>=) ([^;]+); \1(\+\+|--)\)/g)].map(
    ([, name, from, , to, step]) => `${name} from ${from!.trim()} ${step === '++' ? 'up to' : 'down to'} ${to!.trim()}`,
  );
}

function androidLoops(): string[] {
  const body = interpolator.slice(interpolator.indexOf('private fun run('), interpolator.indexOf('private inline fun pass('));
  return [...body.matchAll(/for \((\w+) in (.+?) (until|downTo) (.+?)\)/g)].map(
    ([, name, from, kind, to]) => `${name} from ${from!.trim()} ${kind === 'until' ? 'up to' : 'down to'} ${to!.trim()}`,
  );
}
