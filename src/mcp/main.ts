#!/usr/bin/env node
// U2/U3: the `interlock-mcp` bin. Reads the pane binding from the host env,
// starts the server leniently, and binds stdio — the transport every target
// host (Codex, Claude Code, OMP) supports without extra plugins.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readMcpConfig } from "./config.js";
import { createInterlockMcpServer } from "./server.js";

const { config, problems } = readMcpConfig(process.env);
for (const problem of problems) process.stderr.write("interlock-mcp: " + problem + "\n");

const server = createInterlockMcpServer(config, problems, process.env.INTERLOCK_MCP_VERSION ?? "0.0.0");
await server.connect(new StdioServerTransport());
