import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createJuanMcpServer } from "../src/mcpFactory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "mcp-server.js");
const testDirectory = path.join(root, "test"); // No .env: external calls stay disabled.
const expectedTools = ["search_airports", "search_flights", "search_cheapest_dates", "compare_flight_providers", "search_hotels", "compare_hotels", "search_activities", "get_exchange_rate", "calculate_totals", "calculate_pto", "calculate_rewards", "estimate_trip_cost", "compare_trip_costs", "recommend_trip_options", "get_traveler_profile", "update_traveler_profile", "record_traveler_profile_fact", "extract_trip_intent", "get_trip_intent", "set_trip_intent", "clear_trip_intent", "save_trip_intent", "research_trip_options", "get_trip", "update_trip", "reset_trip"];

function verifyToolList(listed) {
  const names = listed.tools.map((tool) => tool.name);
  assert.equal(names.length, 26, "the factory must preserve all 26 MCP tools");
  for (const name of expectedTools) assert.ok(names.includes(name), `missing MCP tool: ${name}`);
  for (const tool of listed.tools) assert.ok(tool.inputSchema && typeof tool.inputSchema === "object", `missing input schema: ${tool.name}`);
  assert.equal(names.some((name) => /book|purchas|payment|checkout|reserv|cancel/i.test(name)), false, "research-only server must not expose booking/payment tools");
  return names;
}

// Instantiation is intentionally transport-free; this verifies the reusable factory boundary.
const factoryServer = createJuanMcpServer();
assert.ok(factoryServer, "factory must return a configured MCP server");
const [factoryClientTransport, factoryServerTransport] = InMemoryTransport.createLinkedPair();
const factoryClient = new Client({ name: "juan-whey-factory-smoke", version: "1.0.0" });
await Promise.all([factoryServer.connect(factoryServerTransport), factoryClient.connect(factoryClientTransport)]);
const factoryTools = await factoryClient.listTools();
verifyToolList(factoryTools);
const factoryTotals = await factoryClient.callTool({ name: "calculate_totals", arguments: { items: [{ label: "flight", amount: 250 }] } });
assert.equal(JSON.parse(factoryTotals.content[0].text).gross, 250);
await factoryClient.close();

const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: testDirectory, env: { PATH: process.env.PATH || "", NODE_ENV: "test" }, stderr: "pipe" });
const client = new Client({ name: "juan-whey-mcp-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = verifyToolList(listed);

  const totalsResult = await client.callTool({ name: "calculate_totals", arguments: { items: [{ label: "flight", amount: 250 }] } });
  assert.equal(totalsResult.isError, undefined);
  assert.equal(JSON.parse(totalsResult.content[0].text).gross, 250);

  let malformedRejected = false;
  try {
    const malformed = await client.callTool({ name: "calculate_totals", arguments: {} });
    malformedRejected = malformed.isError === true;
  } catch { malformedRejected = true; }
  assert.equal(malformedRejected, true, "malformed MCP input must be rejected safely");

  const missingCredential = await client.callTool({ name: "search_flights", arguments: { origin: "PVD", destination: "MIA", departureDate: "2026-11-19" } });
  assert.equal(missingCredential.isError, true);
  const errorText = missingCredential.content.map((item) => item.text || "").join("\n");
  assert.match(errorText, /Missing SERPAPI_API_KEY/);
  assert.equal(/api[_-]?key\s*[:=]\s*\S+/i.test(errorText), false, "MCP response must not contain a credential value");
  console.log(`MCP factory and stdio smoke test passed: ${names.length} tools discovered and deterministic invocation round-tripped.`);
} finally {
  await transport.close();
}
