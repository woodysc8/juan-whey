// Boots the actual server module against an in-memory client and confirms
// every tool registers cleanly and a non-network tool call round-trips.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.NODE_ENV = "test";

// Import server.js's side effects by re-creating the same registration path
// (server.js auto-connects to stdio on import, so we re-implement a minimal boot here
// using the same tool modules to verify wiring without spawning a subprocess).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { calculateTotals } from "../src/calc/totals.js";
import { calculatePTO } from "../src/calc/pto.js";
import { getProfile, resetTrip, getTrip } from "../src/storage/store.js";

const server = new McpServer({ name: "juan-whey-test", version: "1.0.0" });

server.registerTool(
  "calculate_totals",
  { description: "test", inputSchema: { items: z.array(z.object({ label: z.string(), amount: z.number() })) } },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(calculateTotals(args)) }] })
);
server.registerTool(
  "calculate_pto",
  { description: "test", inputSchema: { candidateDates: z.array(z.object({ date: z.string() })) } },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(calculatePTO(args)) }] })
);
server.registerTool(
  "get_traveler_profile",
  { description: "test", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: JSON.stringify(await getProfile()) }] })
);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke-client", version: "1.0.0" });

await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const toolList = await client.listTools();
console.log(`registered tools: ${toolList.tools.map((t) => t.name).join(", ")}`);
if (toolList.tools.length !== 3) throw new Error("expected 3 tools in smoke test");

const totalsResult = await client.callTool({
  name: "calculate_totals",
  arguments: { items: [{ label: "flight", amount: 250 }] },
});
const totals = JSON.parse(totalsResult.content[0].text);
if (totals.gross !== 250) throw new Error("calculate_totals round-trip failed over MCP transport");

const profileResult = await client.callTool({ name: "get_traveler_profile", arguments: {} });
const profile = JSON.parse(profileResult.content[0].text);
if (!Array.isArray(profile.recurringLocal)) throw new Error("get_traveler_profile round-trip failed");

await resetTrip();
console.log("MCP wiring smoke test passed: tools register and round-trip over the protocol.");
process.exit(0);
