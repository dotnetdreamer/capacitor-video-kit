import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FLOW, OFF_FRAME, flowPasses, interpolationBody, type FlowPassName } from '../src/video-composer/web/optical-flow';

/**
 * ONE optical flow, three engines: the web painter's (`optical-flow.ts`, run by `optical-flow-gl.ts`),
 * Android's (`OpticalFlow.kt`, run by `FlowInterpolator.kt`) and iOS's (`OpticalFlow.swift`, run in Metal
 * by `FlowEstimator.swift`) have to be the same algorithm with the same constants, or the same post slows
 * down differently on a phone and in a browser. The shaders make that checkable for the first two: they
 * are GLSL ES 1.00, which both contexts compile, so the Kotlin copy can be - and is held here to be - the
 * TypeScript's text, line for line. The settings are held field for field, and the two orchestrations are
 * held to running the passes in the same order.
 *
 * Metal compiles no GLSL, so the iOS kernels cannot be held as text; what is held is what they are
 * written from and how they are run. Every constant they splice in comes out of `OpticalFlow.FLOW` or is
 * `OpticalFlow.OFF_FRAME`, both in `OpticalFlow.swift`, both read here as text and held to the
 * TypeScript's `FLOW` field for field and `OFF_FRAME`, exactly as the Kotlin copy is held. The Swift
 * orchestration (`FlowEstimator.encode` in `FlowEstimator.swift`) is read as text and held to the web's
 * call for call - pass, target, inputs, the uniforms each pass sets and the expression each is set from,
 * and the pyramid loops - with each kernel's samplers read off its signature in `OpticalFlowShaders.swift`.
 * (Android's uniforms are held by name only.) The kernels' arithmetic is held numerically, not against
 * the web engine's output: the Swift maths to the same numbers as `optical-flow.unit.test.ts` by
 * `OpticalFlowTests.swift`, and the Metal kernels by `FlowEstimatorTests.swift`, which runs the scenes and
 * the assertions of `painter-optical-flow.cmp.test.ts` on the GPU - orientation, a moving square drawn
 * once, the cross-fade where nothing moves and across a cut. What the two engines draw for the same post
 * is compared by the benchmark (`scripts/slow-motion-bench`), not here.
 *
 * WHEN THIS FAILS because a pass or a setting changed in optical-flow.ts: the failure prints the
 * expected text. Copy it into `OpticalFlowShaders` (or the value into `OpticalFlow.FLOW`) and run the
 * Android unit tests, which pin the Kotlin maths to the same numbers as `optical-flow.unit.test.ts`. For
 * iOS, paste the line it prints into `OpticalFlow.FLOW` in `OpticalFlow.swift` - a new setting also needs
 * its field in `FlowSettings` there, in the same place, and every kernel that should use it - and run the
 * iOS unit tests (`OpticalFlowTests`).
 *
 * It sits in `build/` for the reason `element-members.unit.test.ts` does: it reads files with `node:fs`,
 * which the editor's own program has no business importing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ANDROID = join(here, '..', 'android', 'src', 'main', 'java', 'net', 'dotnetdreamer', 'videokit', 'videocomposer');
const kotlin = readFileSync(join(ANDROID, 'OpticalFlow.kt'), 'utf8').replace(/\r\n/g, '\n');
const interpolator = readFileSync(join(ANDROID, 'FlowInterpolator.kt'), 'utf8').replace(/\r\n/g, '\n');
const web = readFileSync(join(here, '..', 'src', 'video-composer', 'web', 'optical-flow-gl.ts'), 'utf8').replace(/\r\n/g, '\n');
const IOS = join(here, '..', 'ios', 'Sources', 'CapacitorVideoKitCore');
const swift = readFileSync(join(IOS, 'OpticalFlow.swift'), 'utf8').replace(/\r\n/g, '\n');
const estimator = readFileSync(join(IOS, 'FlowEstimator.swift'), 'utf8').replace(/\r\n/g, '\n');
const shaders = readFileSync(join(IOS, 'OpticalFlowShaders.swift'), 'utf8').replace(/\r\n/g, '\n');

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

/**
 * `static let FLOW = FlowSettings(` ... `)` out of the Swift file, as `name: value` pairs. The opening
 * line is matched at the start of a line, four spaces in, so the words quoted in a comment are not it;
 * the block is kept one `name: value,` per line for this reader, and a line that does not start with a
 * name - a comment, which the Swift file keeps out of the block anyway - is not a setting.
 */
function swiftSettings(): Record<string, string> {
  const block = /^ {4}static let FLOW = FlowSettings\(([\s\S]*?)\n {4}\)/m.exec(swift)?.[1] ?? '';
  const values: Record<string, string> = {};
  for (const [, key, value] of block.matchAll(/^\s*(\w+):\s*(.+?),?\s*$/gm)) values[key!] = value!.trim();
  return values;
}

/** A setting as Swift writes it: `1` is a valid Double there, so the TypeScript's own spelling will do. */
function swiftValue(value: unknown): string {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

/** The whole block, for a failure that is not one value: what `OpticalFlow.FLOW` should be. */
function swiftBlock(): string {
  const lines = Object.entries(FLOW).map(([key, value]) => `        ${key}: ${swiftValue(value)}`);
  return `    static let FLOW = FlowSettings(\n${lines.join(',\n')}\n    )`;
}

describe('the iOS engine’s optical flow is the web engine’s', () => {
  it('finds the settings it is meant to compare, so an empty match cannot pass', () => {
    expect(Object.keys(swiftSettings()).length, `no FLOW block in OpticalFlow.swift; it should be:\n${swiftBlock()}`).toBeGreaterThan(0);
  });

  it('holds every setting at the same value', () => {
    const values = swiftSettings();
    const keys = Object.keys(FLOW);
    for (const [key, value] of Object.entries(FLOW)) {
      const actual = values[key];
      // No comma after the last argument: the kit's package is swift-tools 5.9, and a compiler that old
      // refuses one.
      const comma = key === keys[keys.length - 1] ? '' : ',';
      const paste = `OpticalFlow.FLOW.${key} in OpticalFlow.swift should read:\n        ${key}: ${swiftValue(value)}${comma}`;
      expect(actual, paste).toBeDefined();
      // Swift writes 1.0 where JavaScript writes 1, and may group digits with underscores; the number is
      // what has to agree.
      if (typeof value === 'number') expect(Number(actual!.replace(/_/g, '')), paste).toBe(value);
      else if (Array.isArray(value)) expect(actual, paste).toBe(swiftValue(value));
      else expect(actual, paste).toBe(String(value));
    }
    expect(Object.keys(values).sort(), `OpticalFlow.FLOW in OpticalFlow.swift should be:\n${swiftBlock()}`).toEqual(Object.keys(FLOW).sort());
  });

  it('runs the same passes in the same order, into the same targets, from the same inputs', () => {
    const webCalls = webPassCalls();
    const iosCalls = iosPassCalls();
    expect(iosCalls.length, 'no pass(.name, into: ...) calls found in FlowEstimator.encode').toBeGreaterThan(8);
    expect(iosCalls).toEqual(webCalls);
  });

  it('sets each pass’s uniforms from the same expressions', () => {
    const web = webUniformValues();
    const ios = iosUniformValues();
    expect(ios.length).toBe(web.length);
    // Something to compare, so a reader that found nothing cannot pass.
    expect(web.filter(values => Object.keys(values).length > 0).length).toBeGreaterThanOrEqual(3);
    for (const [index, values] of ios.entries()) expect(values, `pass call ${index} (${webPassCalls()[index]?.pass})`).toEqual(web[index]);
  });

  it('walks the pyramid the same way', () => {
    expect(iosLoops()).toEqual(webLoops());
  });

  it('holds OFF_FRAME, the one constant the kernels splice in from outside FLOW', () => {
    const match = /^\s*static let OFF_FRAME: Double = (.+)$/m.exec(swift);
    expect(match, 'no `static let OFF_FRAME: Double =` in OpticalFlow.swift').not.toBeNull();
    expect(Number(match![1]!.trim().replace(/_/g, '')), `OpticalFlow.OFF_FRAME in OpticalFlow.swift should be ${OFF_FRAME}`).toBe(OFF_FRAME);
    // And it is the value the consistency kernel is written with, not a literal of its own.
    expect(shaders).toContain('f(OpticalFlow.OFF_FRAME)');
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
    .replace(/^result\.flow$/, 'result')
    .replace(/^result\.visibility$/, 'visibility')
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

/** The body of `FlowEstimator.encode` in FlowEstimator.swift: the one function that runs every pass of a pair. */
function iosEncode(): string {
  const start = estimator.indexOf('private func encode(');
  expect(start, 'no `private func encode(` in FlowEstimator.swift').toBeGreaterThan(-1);
  return group(estimator, estimator.indexOf('{', start));
}

/**
 * Each pass's samplers, in the texture slots they are bound to: the `texture2d<float> u_name [[texture(n)]]`
 * arguments of its kernel, `flow_<pass>`, in OpticalFlowShaders.swift. `FlowEstimator.pass` binds its inputs to
 * slots 0, 1, ... in the order it is handed them, so this is what the web's `SAMPLERS` is on iOS.
 */
function iosSamplers(pass: string): string[] {
  const start = shaders.indexOf(`kernel void flow_${pass}(`);
  if (start < 0) return [];
  const signature = shaders.slice(start, shaders.indexOf('FLOW_TARGET', start));
  return [...signature.matchAll(/texture2d<float> (u_\w+) \[\[texture\((\d+)\)\]\]/g)]
    .sort((a, b) => Number(a[2]) - Number(b[2]))
    .map(m => m[1]!);
}

/**
 * The Swift orchestration's calls in the shared spelling: `pass(.luma, into: scratch.pyramid[0], inputs: [frameA,
 * frameB], PassUniforms(taps: taps, grade: grade))`. A `PassUniforms` argument label is the uniform it sets with
 * `u_` in front - `grade` is the one that sets two, the matrix and its offset, as the web's `FlowGrade` does -
 * and `u_size`, which every engine sets for every pass from the target, is left out on all three sides.
 */
function iosPassCalls(): PassCall[] {
  const body = iosEncode();
  return [...body.matchAll(/\bpass\(\./g)].map(match => {
    const args = split(group(body, match.index! + 'pass'.length));
    const pass = args[0]!.replace(/^\./, '');
    const inputs = args[2]!.replace(/^inputs:\s*/, '');
    // The top-level labels only: a value may itself be a call with labelled arguments.
    const labels = args[3] ? split(group(args[3], args[3].indexOf('('))).map(entry => /^(\w+):/.exec(entry)?.[1] ?? entry) : [];
    return {
      pass,
      target: texture(args[1]!.replace(/^into:\s*/, '')),
      inputs: split(group(inputs, inputs.indexOf('['))).map(texture),
      samplers: iosSamplers(pass),
      uniforms: labels.flatMap(label => (label === 'grade' ? ['u_matrix', 'u_offset'] : [`u_${label}`])).sort(),
    };
  });
}

/**
 * The Swift loop headers in the web's words: `stride(from: a, to: b, by: 1)` and `a..<b` count up to `b`,
 * `stride(from: a, through: b, by: -1)` down to it. Any other shape is written out as it stands, so it cannot
 * match.
 */
function iosLoops(): string[] {
  return [...iosEncode().matchAll(/for (\w+) in (.+?) \{/g)].map(([, name, range]) => {
    const stride = /^stride\(from: (.+?), (to|through): (.+?), by: (-?\d+)\)$/.exec(range!);
    if (stride) {
      const [, from, kind, to, by] = stride;
      if (kind === 'to' && by === '1') return `${name} from ${from} up to ${to}`;
      if (kind === 'through' && by === '-1') return `${name} from ${from} down to ${to}`;
      return `${name} from ${from} ${kind} ${to} by ${by}`;
    }
    const open = /^(.+?)\.\.<(.+)$/.exec(range!);
    return open ? `${name} from ${open[1]} up to ${open[2]}` : `${name} in ${range}`;
  });
}

/*
 * The uniform VALUES, iOS against the web: for every pass call, each uniform the call sets and the
 * expression it is set from, broken into its components and brought to one spelling. The spellings that
 * differ and mean the same are mapped away - `===`/`null` and `==`/`nil`, the web's non-null `!`, `this.`,
 * `scratch.` and `OpticalFlow.` in front of a name, Swift's argument labels and `Float(...)` conversions,
 * and a vector written `[a, b]` or `SIMD2(a, b)` - and nothing else is: a pass set from a different
 * expression, `fresh: 1` for `estimate == nil ? 1 : 0` or a texel size taken from the target instead of
 * the source, fails here.
 */

type UniformValues = Record<string, string[]>;

/** `name(x)` as `(x)` everywhere in `text`: a conversion, which changes the type and not the value. */
function unwrap(text: string, name: string): string {
  for (let at = text.search(new RegExp(`\\b${name}\\(`)); at >= 0; at = text.search(new RegExp(`\\b${name}\\(`))) {
    const open = at + name.length;
    const inner = group(text, open);
    text = `${text.slice(0, at)}(${inner})${text.slice(open + inner.length + 2)}`;
  }
  return text;
}

/** One component of a uniform's value in the shared spelling. */
function uniformExpression(expression: string): string {
  let text = unwrap(expression, 'Float')
    .replace(/\s+/g, '')
    .replace(/===/g, '==')
    .replace(/\bnull\b/g, 'nil')
    .replace(/!(?!=)/g, '')
    .replace(/\b(this|scratch|OpticalFlow)\./g, '')
    .replace(/([(,])\w+:/g, '$1');
  for (let before = ''; before !== text; ) {
    before = text;
    // Brackets around a single name, and around the whole expression, say nothing.
    text = text.replace(/(?<![\w.\]])\(([\w.]+)\)/g, '$1');
    if (text.startsWith('(') && group(text, 0).length === text.length - 2) text = text.slice(1, -1);
  }
  return text;
}

/** A uniform's value as its components: `[a, b]` and `SIMD2(a, b)` are two, anything else is one. */
function components(value: string): string[] {
  const text = value.trim();
  const vector = /^(\[|SIMD\d\()/.exec(text);
  if (vector) {
    const open = vector[1] === '[' ? 0 : text.indexOf('(');
    const inner = group(text, open);
    if (open + inner.length + 2 === text.length) return split(inner).map(uniformExpression);
  }
  return [uniformExpression(text)];
}

function webUniformValues(): UniformValues[] {
  const body = web.slice(web.indexOf('  estimate('));
  return [...body.matchAll(/this\.pass\('/g)].map(match => {
    const args = split(group(body, match.index! + 'this.pass'.length));
    const values: UniformValues = {};
    if (args[3]) {
      for (const entry of split(group(args[3], args[3].indexOf('{')))) {
        const [, name, value] = /^(u_\w+):\s*([\s\S]+)$/.exec(entry)!;
        values[name!] = components(value!);
      }
    }
    return values;
  });
}

/** The same off `PassUniforms(label: value, ...)`: `label` is the uniform with `u_` in front, and `grade` is two. */
function iosUniformValues(): UniformValues[] {
  const body = iosEncode();
  return [...body.matchAll(/\bpass\(\./g)].map(match => {
    const args = split(group(body, match.index! + 'pass'.length));
    const values: UniformValues = {};
    if (args[3]) {
      for (const entry of split(group(args[3], args[3].indexOf('(')))) {
        const [, label, value] = /^(\w+):\s*([\s\S]+)$/.exec(entry)!;
        if (label === 'grade') {
          values.u_matrix = components(`${value}.matrix`);
          values.u_offset = components(`${value}.offset`);
        } else values[`u_${label}`] = components(value!);
      }
    }
    return values;
  });
}
