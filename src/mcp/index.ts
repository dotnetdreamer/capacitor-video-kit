/**
 * `@capacitor-video-kit/core/mcp`: this package's editor core as an MCP server.
 *
 * An agent that can call these tools can build and change a post - lay out the base track, trim and
 * split it, put a second video over it, add text, stickers, photos and effects, place music and
 * voiceover, choose the frame - and hand the result to the app to render. The manifest it produces
 * is the same document the editor's own UI produces, because the tools call the same functions the
 * UI's buttons call.
 *
 * Two ways in:
 *
 * ```sh
 * # As a process, over stdio, which is what an MCP client configuration wants:
 * node node_modules/@capacitor-video-kit/core/mcp/mcp/stdio.js
 * ```
 *
 * ```ts
 * // Or inside something that already runs, with a transport of its own:
 * import { createVideoKitMcpServer } from '@capacitor-video-kit/core/mcp';
 *
 * const server = createVideoKitMcpServer({ version: '1.3.0' });
 * await server.connect(myTransport);
 * ```
 *
 * An app that has turned Zoom off in its editor turns it off here with the same setting - over
 * stdio with `--no-zoom`, in code with `createVideoKitMcpServer({ editing: { zoom: false } })` -
 * and no post on its server holds a zoom: every zoom op is refused, and so is a manifest handed in
 * with a zoom in it. That is stricter than the editor, which still shows a zoom an old draft
 * carries, and `tools.ts` says why and has the whole of what it changes. Refusing the manifest is
 * the tools' part, not `applyEditOps`'s, so a host that builds a tool of its own on `applyEditOps`
 * refuses such a manifest itself, with `refuseZooms`.
 *
 * This entry point is the only one in the package that needs `@modelcontextprotocol/sdk`, which is
 * an OPTIONAL peer dependency. Nothing else here reaches it, `src/mcp` is compiled by a tsconfig of
 * its own that the package build only runs when it is asked to, and a mobile app that never imports
 * this path never sees any of it. `README.md` has the whole of what to leave out and how.
 *
 * `tools.ts` is worth reading before the rest: it says what these tools do, what they deliberately
 * do not do - they do not render, and why that is a real line rather than a first cut - and how the
 * manifest store works.
 */
export { createVideoKitMcpServer, SERVER_NAME, type VideoKitMcpServerOptions } from './server';
export {
  createTools,
  refuseZooms,
  ToolError,
  OP_REFERENCE,
  type JsonSchema,
  type ToolDefinition,
  type ToolResult,
  type VideoKitToolsOptions,
} from './tools';
export {
  applyEditOps,
  EditOpError,
  OP_NAMES,
  ZOOM_OPS,
  opNamesFor,
  type EditOp,
  type EditOpsOptions,
  type McpEditingOptions,
} from './ops';
export { summariseManifest, type SummaryOptions } from './summary';
