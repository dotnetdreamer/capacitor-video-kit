/**
 * Builds the MCP server, or says why it did not, and never fails a build that did not ask for one.
 *
 * The server is the one optional part of this package. Everything else here is what a mobile app
 * installs to edit and post video; the server is for an agent driving that same editor core from
 * outside, and an app that has no use for it should not pay for it. `@modelcontextprotocol/sdk`
 * brings around 190 packages with it, so "should not pay for it" is not a figure of speech.
 *
 * WHAT DECIDES, in order:
 *
 *   CHOISY_VIDEO_KIT_MCP=0     never build it. Also 'false', 'off', 'no'.
 *   CHOISY_VIDEO_KIT_MCP=1     always build it, and FAIL if the SDK is not installed, because a
 *                              build that was told to produce the server and quietly did not is
 *                              how a missing server is discovered by the client instead.
 *   unset                      build it if the SDK resolves, and skip with a note if it does not.
 *
 * The unset case is the one that matters for an app. `@modelcontextprotocol/sdk` is an OPTIONAL
 * peer dependency, so an app that does not ask for it does not install it, this script finds
 * nothing, and the build finishes with `mcp/` never created. Nothing else in the package refers to
 * it, so nothing else notices. The app that DOES want the server installs the SDK and gets it with
 * no flag to remember.
 *
 * A build that skips leaves no `mcp/` behind, which is also what `package.json`'s `files` and
 * `exports` are written for: `files` names a directory that may not exist, which npm is happy to
 * pack nothing from, and the `./mcp` export names a path that only answers when it is there.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(packageDir, 'mcp');
const require = createRequire(import.meta.url);

const flag = (process.env['CHOISY_VIDEO_KIT_MCP'] ?? '').trim().toLowerCase();
const OFF = ['0', 'false', 'off', 'no'];
const ON = ['1', 'true', 'on', 'yes'];

if (OFF.includes(flag)) {
  // Removed rather than left, so that turning the flag off and rebuilding cannot leave yesterday's
  // server in the tree to be published beside today's plugin.
  rmSync(outDir, { recursive: true, force: true });
  console.log('build-mcp: skipped, CHOISY_VIDEO_KIT_MCP is off');
  process.exit(0);
}

const sdk = hasSdk();
if (!sdk) {
  if (ON.includes(flag)) {
    console.error(
      'build-mcp: CHOISY_VIDEO_KIT_MCP asked for the MCP server, but @modelcontextprotocol/sdk is not\n' +
        '           installed. It is an optional peer dependency: `npm install @modelcontextprotocol/sdk`.',
    );
    process.exit(1);
  }
  rmSync(outDir, { recursive: true, force: true });
  console.log('build-mcp: skipped, @modelcontextprotocol/sdk is not installed (set CHOISY_VIDEO_KIT_MCP=1 to require it)');
  process.exit(0);
}

/* ---------------------------------------------------------------------------------------------- */

rmSync(outDir, { recursive: true, force: true });

run('npx', ['tsc', '-p', 'tsconfig.mcp.json']);
/* The same extensionless-specifier problem the plugin half has, in the same `tsc` output. */
run('node', ['scripts/finish-build.mjs', 'mcp']);

/*
 * This tree is ESM and the package root declares no `type`, so without this marker Node reads every
 * file in it as CommonJS and refuses the first `export`. `module-type.mjs` states the whole of why.
 */
writeFileSync(join(outDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

/*
 * The two things the stdio entry point cannot carry in its own source: a shebang, which is not
 * TypeScript, and the package's real version, which would be a lie in a file that is also run
 * straight from source during development.
 */
const version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
const entry = join(outDir, 'mcp', 'stdio.js');
if (!existsSync(entry)) throw new Error(`build-mcp: tsc did not produce ${entry}`);

const source = readFileSync(entry, 'utf8');
const versioned = source.replace(/const VERSION = '[^']*';/, `const VERSION = ${JSON.stringify(version)};`);
if (versioned === source) throw new Error('build-mcp: the VERSION line in stdio.ts has moved; this script no longer finds it');
writeFileSync(entry, `#!/usr/bin/env node\n${versioned}`);
chmodSync(entry, 0o755);

console.log(`build-mcp: built mcp/ for version ${version}`);

/* ---------------------------------------------------------------------------------------------- */

/** Resolvable from here, which is the only question: this is where the compile will look too. */
function hasSdk() {
  try {
    require.resolve('@modelcontextprotocol/sdk/package.json');
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    throw new Error(`build-mcp: \`${command} ${args.join(' ')}\` exited with ${result.status ?? result.signal}`);
  }
}
