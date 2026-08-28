#!/usr/bin/env node
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJuanMcpServer } from "./mcpFactory.js";

export { createJuanMcpServer } from "./mcpFactory.js";

const server = createJuanMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
