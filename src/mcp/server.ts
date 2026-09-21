/**
 * The tool table from `tools.ts`, put on the wire.
 *
 * This is the ONLY file in the package that imports `@modelcontextprotocol/sdk`, which is what lets
 * the SDK be an optional dependency rather than a real one. A host that installs this package to
 * edit video - which is every mobile app that uses it - never resolves this module, never installs
 * the SDK, and can be built with `src/mcp` left out of the compile altogether.
 *
 * There is nothing here but plumbing, on purpose. The protocol layer is the part most likely to
 * move under us as the SDK versions go by, and keeping it to one thin file means a version bump is
 * read once rather than chased through forty tool definitions.
 *
 * The low-level `Server` is used rather than `McpServer`. `McpServer.registerTool` takes its input
 * schemas as Zod, and the schemas here are hand written JSON Schema: this package already has a
 * validator for the one thing worth validating - `normaliseManifest`, which is what the editor
 * itself trusts - and a second, parallel set of rules written in Zod would be a second opinion
 * about what a manifest is. Two opinions is one too many, and the one in Zod would be the one that
 * went stale.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ToolError, createTools, type ToolDefinition } from './tools';

/** What the client sees this server called. The version is the package's, filled in by the build. */
export const SERVER_NAME = '@capacitor-video-kit/core';

export interface VideoKitMcpServerOptions {
  /** Reported to the client on connect. Defaults to the version this was built from. */
  version?: string;
  /** For a host that wants to add tools of its own, or to take some away. Defaults to all five. */
  tools?: ToolDefinition[];
}

/**
 * Builds the server, with its own store of manifests, ready for a transport.
 *
 * Not connected: the caller chooses the transport. `stdio.ts` is the one this package ships, and a
 * host embedding the server in something it already runs will have its own.
 */
export function createVideoKitMcpServer(options: VideoKitMcpServerOptions = {}): Server {
  const tools = options.tools ?? createTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    { name: SERVER_NAME, version: options.version ?? '0.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'This server builds and edits the video EditManifest that @capacitor-video-kit/core renders. A manifest ' +
        'is the whole of an edit: the clips and their trims, the video layers over them, the text, ' +
        'stickers, photos and effects drawn on top, the music and voiceover, and the frame it all ' +
        'renders at.\n\n' +
        'Start with manifest_create, change it with manifest_edit, and read it back with ' +
        'manifest_inspect. Every tool returns a manifestId, so the manifest itself only has to be ' +
        'passed when it came from somewhere else. catalog_list is where the filter, effect, layout and ' +
        'text style ids come from, and where each edit op’s parameters are written down.\n\n' +
        'This server does not render. Turning a manifest into a video needs a canvas - every text ' +
        'layer is measured with its real font and every layer is drawn to a PNG - so it happens on the ' +
        'device, in the app. What is produced here is handed to the editor component or straight to ' +
        'toComposeSpec, and renders identically to an edit made by hand.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object' },
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return failure(`no tool "${request.params.name}". This server has: ${[...byName.keys()].join(', ')}`);
    }
    try {
      return tool.run((request.params.arguments ?? {}) as Record<string, unknown>);
    } catch (error) {
      /*
       * Answered as a tool error rather than thrown as a protocol one. Everything that reaches here
       * is the agent's own input being wrong - an id that is not on the post, an op that cannot be
       * made - and the messages in `ops.ts` are written to be read by whoever will fix it. A thrown
       * protocol error would reach the client as a failed request instead, with the message buried,
       * and the agent would have nothing to correct.
       */
      if (error instanceof ToolError || error instanceof Error) return failure(error.message);
      return failure(String(error));
    }
  });

  return server;
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
