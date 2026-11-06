/**
 * Writes `src/editor/object-tracker-worker.ts`: the object tracker (`src/editor/object-tracker.ts`) as
 * the source of a worker script, which `src/state/track-session.ts` starts from a Blob URL so a tracking
 * run follows its frames off the page's own thread and the screen stays smooth while it does.
 *
 * Generated source rather than a worker file, because no way of shipping a worker file survives a host
 * app's build. Stencil's `*.worker.ts` and `new Worker(new URL('...', import.meta.url))` both name a file
 * that an esbuild-based Angular build never emits, and Stencil's custom-elements output points at one
 * that nothing copies; a string travels inside the module that imports it. Nor is the string the
 * tracker's `Function.prototype.toString()` at run time: a host's minifier renames the helpers the class
 * calls, and the worker would be handed a class calling functions it does not have.
 *
 * The tracker imports nothing, so it transpiles on its own: TypeScript's `transpileModule`, to a plain
 * ES2020 script, with its `export` keywords cut first and the message loop below appended. This fails
 * the build if the tracker ever imports something or exports anything but a declaration, since the
 * worker would then not be the whole tracker. The file also records the SHA-256 of the tracker text it
 * was made from, and `build/object-tracker-worker.unit.test.ts` regenerates it in memory and fails while
 * the committed file is not what this would write.
 *
 * It runs first in `build:plugin`, before either TypeScript build reads the file, and by hand after a
 * change to the tracker:
 *
 *   node scripts/build-tracker-worker.mjs
 *
 * It writes only when the text changes, with the line ends the tracker's own file has.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

import ts from 'typescript';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TRACKER_FILE = join(packageDir, 'src', 'editor', 'object-tracker.ts');
export const WORKER_FILE = join(packageDir, 'src', 'editor', 'object-tracker-worker.ts');

/**
 * The worker's message loop, after the tracker: one tracker per run, kept by the run's id. `start` and
 * `step` are answered with the frame's state, numbered within the run from 0, or with what stopped the
 * tracker: `{ run, seq, state, data }` or `{ run, seq, error }`. `data` is the frame's own pixels, handed
 * back for the page to fill with the next frame rather than make a new array for each. `end` lets a run's
 * tracker go. Only `self` is read, so the loop runs the same in a worker and in a test's
 * `new Function('self', ...)`; the block keeps its names out of the tracker's.
 */
const LOOP = `
{
  const runs = new Map();
  self.onmessage = event => {
    const message = event.data;
    if (message.op === 'end') {
      runs.delete(message.run);
      return;
    }
    let run = runs.get(message.run);
    if (message.op === 'start') {
      run = { tracker: new ObjectTracker(), seq: 0 };
      runs.set(message.run, run);
    } else if (run) {
      run.seq++;
    }
    const seq = run ? run.seq : -1;
    try {
      if (!run) throw new Error('a run was stepped before it started');
      const frame = message.frame;
      const state = message.op === 'start' ? run.tracker.start(frame, message.box) : run.tracker.step(frame);
      self.postMessage({ run: message.run, seq, state, data: frame.data }, [frame.data.buffer]);
    } catch (error) {
      self.postMessage({ run: message.run, seq, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
`;

/** `text` as this script reads it: no byte order mark, LF line ends, whatever the checkout wrote. */
function normalise(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/** The SHA-256 of the tracker's text, as hex: what the generated file says it was made from. */
export function trackerHash(trackerText) {
  return createHash('sha256').update(normalise(trackerText), 'utf8').digest('hex');
}

/**
 * The tracker's text with the `export` keyword cut from its declarations. Anything else that makes it a
 * module - an import, `export { ... }`, a default export - is refused, with where it is.
 */
function withoutExports(text) {
  const file = ts.createSourceFile('object-tracker.ts', text, ts.ScriptTarget.Latest, true);
  const where = node => `src/editor/object-tracker.ts:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const cuts = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      throw new Error(`${where(statement)}: the tracker's worker is the tracker alone, so the tracker can import nothing and export only its declarations`);
    }
    for (const modifier of (ts.canHaveModifiers(statement) && ts.getModifiers(statement)) || []) {
      if (modifier.kind === ts.SyntaxKind.DefaultKeyword) throw new Error(`${where(statement)}: the tracker's worker has no default export to give`);
      if (modifier.kind === ts.SyntaxKind.ExportKeyword) cuts.push([modifier.getStart(file), modifier.getEnd()]);
    }
  }
  let out = text;
  // From the end, so the earlier positions still hold.
  for (const [start, end] of cuts.reverse()) out = out.slice(0, start) + out.slice(end).replace(/^[ \t]+/, '');
  return out;
}

/** The worker script for `trackerText`: the tracker as a plain ES2020 script, its loop after it. */
export function workerSource(trackerText) {
  const { outputText, diagnostics } = ts.transpileModule(`${withoutExports(normalise(trackerText))}\n${LOOP}`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      // Strict, as the module the page runs it as is.
      alwaysStrict: true,
      removeComments: true,
      newLine: ts.NewLineKind.LineFeed,
    },
    fileName: 'object-tracker.ts',
    reportDiagnostics: true,
  });
  if (diagnostics?.length) {
    throw new Error(ts.formatDiagnostics(diagnostics, { getCanonicalFileName: name => name, getCurrentDirectory: () => packageDir, getNewLine: () => '\n' }));
  }
  // A worker made from a Blob runs a classic script: one Node's parser will not take as one would fail
  // to load on every phone, and the run would fall back to the page's thread without a word.
  new Script(outputText, { filename: 'object-tracker-worker.js' });
  if (/\b(require\s*\(|exports\b|import\s*\()/.test(outputText) || !/\bclass ObjectTracker\b/.test(outputText)) {
    throw new Error('the transpiled tracker is not a plain script holding ObjectTracker');
  }
  return outputText;
}

/**
 * `text` as a string literal the way this package's Prettier prints one (`.prettierrc.json` has
 * `singleQuote`), so formatting the generated file changes nothing: single quotes unless the text holds
 * more of those than double quotes, and only the enclosing quote escaped.
 */
function literal(text) {
  const json = JSON.stringify(text);
  if (text.split("'").length > text.split('"').length) return json;
  return `'${json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
}

/** The whole of `src/editor/object-tracker-worker.ts` for `trackerText`, LF line ends. */
export function trackerWorkerFile(trackerText) {
  return [
    '/*',
    ' * GENERATED by scripts/build-tracker-worker.mjs from src/editor/object-tracker.ts: do not edit. After a',
    ' * change to the tracker, regenerate it with `node scripts/build-tracker-worker.mjs` (the build runs it',
    ' * first anyway); build/object-tracker-worker.unit.test.ts fails while it is stale.',
    ' *',
    " * The tracker as a worker script, which src/state/track-session.ts starts from a Blob URL so a run follows",
    " * its frames off the page's own thread. Why a string, and not a worker file, is in the script.",
    ' */',
    '',
    '/** The SHA-256 of object-tracker.ts, line ends as LF, that [TRACKER_WORKER_SOURCE] was made from. */',
    `export const TRACKER_SOURCE_SHA256 = '${trackerHash(trackerText)}';`,
    '',
    '/** The worker script: the tracker as a plain ES2020 script, its exports cut, and its message loop after it. */',
    'export const TRACKER_WORKER_SOURCE =',
    `  ${literal(workerSource(trackerText))};`,
    '',
  ].join('\n');
}

/** Whether Node was started on this file, rather than a test importing it. */
function runAsScript() {
  const started = process.argv[1];
  if (!started) return false;
  try {
    return realpathSync(started) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) {
  const tracker = readFileSync(TRACKER_FILE, 'utf8');
  const text = trackerWorkerFile(tracker);
  let before = null;
  try {
    before = normalise(readFileSync(WORKER_FILE, 'utf8'));
  } catch {
    // Not written yet.
  }
  const name = relative(packageDir, WORKER_FILE).replace(/\\/g, '/');
  if (before === text) {
    console.log(`build-tracker-worker: ${name} is up to date`);
  } else {
    writeFileSync(WORKER_FILE, tracker.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
    console.log(`build-tracker-worker: wrote ${name}`);
  }
}
