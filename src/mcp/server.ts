// U2: the MCP server object. The factory registers the five tools and does
// nothing else — no transport, no process wiring — so tests can connect a
// client through an in-memory transport while main.ts owns the stdio binding
// (the pattern the herdr plugin uses: create, then connect).
//
// Start-lenient (KTD5): a host that launches the server without
// INTERLOCK_PANE still gets a tools/list; every call fails with the missing
// variable named. The server never exits on config problems — hosts kill
// servers silently, and a silent death reads as a broken host, not a broken
// setup.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TOOL_SPECS } from "./tools.js";
import type { McpConfig } from "./config.js";

export function createInterlockMcpServer(config: McpConfig | null, problems: string[], version: string): McpServer {
  const server = new McpServer({ name: "interlock", version });
  for (const spec of TOOL_SPECS) {
    server.registerTool(spec.name, { description: spec.description, inputSchema: spec.schema }, async (args: Record<string, unknown>) => {
      if (config === null) return { isError: true, content: [{ type: "text", text: problems.join("; ") }] };
      return spec.handler(config)(args);
    });
  }
  return server;
}

