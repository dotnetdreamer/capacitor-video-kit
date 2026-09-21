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
 *       "args": ["/absolute/path/to/@capacitor-video-kit/core/mcp/mcp/stdio.js"]
 *     }
 *   }
 * }
 * ```
 *
 * NOTHING may be written to stdout but the protocol. A stray `console.log` anywhere under this
 * entry point corrupts the stream and the client drops the connection with a parse error that names
 * the JSON rather than the line that printed over it. So the one thing this file prints, it prints
 * to stderr, which the client shows as the server's log.
 *
 * The build adds the `#!/usr/bin/env node` line; it is not in the source because it is not
 * TypeScript. `scripts/build-mcp.mjs` is where that happens.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createVideoKitMcpServer } from './server';

/** Replaced by the build with this package's real version. Left as a literal so the source runs. */
const VERSION = '0.0.0-dev';

async function main(): Promise<void> {
  const server = createVideoKitMcpServer({ version: VERSION });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`@capacitor-video-kit/core MCP server ${VERSION} ready on stdio\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`@capacitor-video-kit/core MCP server failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
