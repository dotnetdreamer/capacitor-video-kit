/**
 * The server as a process, speaking MCP over stdin and stdout.
 *
 * This is what an MCP client configuration points at:
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "@capacitor-video-kit/core": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/capacitor-video-kit/mcp/mcp/stdio.js"]
 *     }
 *   }
 * }
 * ```
 *
 * For an app that has turned Zoom off in its editor, add `"--no-zoom"` after the path, or set
 * `CAPACITOR_VIDEO_KIT_MCP_ZOOM=0` in the entry's `env`, and no post on the server holds a zoom -
 * every zoom op is refused, and so is a manifest handed in with one (`tools.ts` says why that is
 * stricter than the editor):
 *
 * ```json
 * "args": ["/absolute/path/to/capacitor-video-kit/mcp/mcp/stdio.js", "--no-zoom"]
 * ```
 *
 * Any other argument stops the process before it starts, and `stdio-options.ts` says why a
 * misspelling is not something to shrug at.
 *
 * NOTHING may be written to stdout but the protocol. A stray `console.log` anywhere under this
 * entry point corrupts the stream and the client drops the connection with a parse error that names
 * the JSON rather than the line that printed over it. So the things this file prints, it prints to
 * stderr, which the client shows as the server's log.
 *
 * The build adds the `#!/usr/bin/env node` line; it is not in the source because it is not
 * TypeScript. `scripts/build-mcp.mjs` is where that happens.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createVideoKitMcpServer } from './server';
import { StdioUsageError, readStdioOptions } from './stdio-options';

/** Replaced by the build with this package's real version. Left as a literal so the source runs. */
const VERSION = '0.0.0-dev';

async function main(): Promise<void> {
  // Read before anything connects, so a bad argument is refused before the client has a server to
  // talk to rather than after it has started sending requests to one.
  const options = readStdioOptions(process.argv.slice(2), process.env);
  const server = createVideoKitMcpServer({ version: VERSION, editing: options.editing });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`@capacitor-video-kit/core MCP server ${VERSION} ready on stdio${options.note}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof StdioUsageError) {
    // The message is the whole story; a stack trace under it would only bury it. 2 is the usual
    // exit status for a command line that was wrong, as against 1 for a server that broke.
    process.stderr.write(`@capacitor-video-kit/core MCP server refused to start: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`@capacitor-video-kit/core MCP server failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
