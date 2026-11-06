import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TRACKER_SOURCE_SHA256, TRACKER_WORKER_SOURCE } from '../src/editor/object-tracker-worker';

/**
 * The worker's copy of the tracker is the tracker as it is now.
 *
 * `src/editor/object-tracker-worker.ts` is generated from `src/editor/object-tracker.ts` by
 * `scripts/build-tracker-worker.mjs`, and committed. The build regenerates it before compiling, but a
 * test run, a watch build and an editor all read the committed file, so a change to the tracker that
 * was never regenerated would leave the worker - which follows most runs - following things the old way
 * while every test of the tracker passed. Here the file is regenerated in memory and held to the one
 * committed.
 *
 * WHEN THIS FAILS: run `node scripts/build-tracker-worker.mjs` and commit what it writes.
 *
 * It sits in `build/` for the reason `element-members.unit.test.ts` does: it reads files with `node:fs`,
 * and the generator it runs loads the TypeScript compiler, neither of which the editor's own program has
 * any business with.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STALE = 'src/editor/object-tracker-worker.ts is stale: run `node scripts/build-tracker-worker.mjs` and commit what it writes';

/** What the generator exports: it is plain JavaScript, which Node runs in the build, so it is typed here. */
interface Generator {
  trackerHash(trackerText: string): string;
  workerSource(trackerText: string): string;
  trackerWorkerFile(trackerText: string): string;
}

function generator(): Promise<Generator> {
  return import(/* @vite-ignore */ pathToFileURL(join(ROOT, 'scripts', 'build-tracker-worker.mjs')).href) as Promise<Generator>;
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('the tracker worker source', () => {
  it('was made from the tracker as it is now', async () => {
    const { trackerHash } = await generator();
    expect(TRACKER_SOURCE_SHA256, STALE).toBe(trackerHash(read('src/editor/object-tracker.ts')));
  });

  it('is what the generator writes, to the character, and its string is the worker script', async () => {
    const { trackerWorkerFile, workerSource } = await generator();
    const tracker = read('src/editor/object-tracker.ts');
    // The checkout may have turned its line ends to CRLF; the generator writes LF, and so compares in LF.
    expect(read('src/editor/object-tracker-worker.ts').replace(/\r\n/g, '\n'), STALE).toBe(trackerWorkerFile(tracker));
    expect(TRACKER_WORKER_SOURCE, STALE).toBe(workerSource(tracker));
  });
});
