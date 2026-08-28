import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createJuanMcpHttpServer, loadMcpHttpConfig } from "../src/mcp-http-server.js";

function config(overrides = {}) {
  return {
    host: "127.0.0.1", port: 0, publicBaseUrl: "http://127.0.0.1",
    allowedOrigins: ["http://allowed.test"], allowedHosts: ["127.0.0.1", "allowed.test"], authRequired: false,
    maxBodyBytes: 1_000_000, maxConcurrentRequests: 10, maxSessions: 10, requestTimeoutMs: 5_000,
    ...overrides,
  };
}
function request(port, { method = "POST", host = "allowed.test", origin, authorization, body = "{}" } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host, "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    if (origin) headers.Origin = origin;
    if (authorization) headers.Authorization = authorization;
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method, headers }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end(body);
  });
}
async function start(overrides = {}) {
  const logs = [];
  const runtime = createJuanMcpHttpServer({ config: config(overrides), logger: { info: (message) => logs.push(message) } });
  const address = await runtime.listen();
  return { runtime, logs, port: address.port };
}

assert.deepEqual(loadMcpHttpConfig({ MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "3010", MCP_PUBLIC_BASE_URL: "http://127.0.0.1:3010", MCP_ALLOWED_ORIGINS: "http://localhost:3010", MCP_ALLOWED_HOSTS: "127.0.0.1,localhost", MCP_AUTH_REQUIRED: "false" }).host, "127.0.0.1");
assert.throws(() => loadMcpHttpConfig({ MCP_HTTP_HOST: "0.0.0.0", MCP_HTTP_PORT: "3010", MCP_PUBLIC_BASE_URL: "https://example.test", MCP_ALLOWED_ORIGINS: "https://example.test", MCP_ALLOWED_HOSTS: "example.test", MCP_AUTH_REQUIRED: "false" }), /Refusing to bind/);

const first = await start();
try {
  const url = new URL(`http://127.0.0.1:${first.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "juan-http-test", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 26);
  const totals = await client.callTool({ name: "calculate_totals", arguments: { items: [{ label: "flight", amount: 250 }] } });
  assert.equal(JSON.parse(totals.content[0].text).gross, 250);

  const secondTransport = new StreamableHTTPClientTransport(url);
  const secondClient = new Client({ name: "juan-http-test-two", version: "1.0.0" });
  await secondClient.connect(secondTransport);
  assert.equal(first.runtime.sessions.size, 2, "each HTTP MCP session must receive its own factory server/transport");
  await secondClient.close();
  await client.close();

  assert.equal((await request(first.port, { body: "{" })).status, 400);
  assert.equal((await request(first.port, { host: "attacker.test" })).status, 403);
  assert.equal((await request(first.port, { origin: "https://attacker.test" })).status, 403);
  assert.equal((await request(first.port, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_flights", arguments: { includeRaw: true } } }) })).status, 403);
} finally { await first.runtime.close(); }

const limited = await start({ maxBodyBytes: 10 });
try { assert.equal((await request(limited.port, { body: "01234567890" })).status, 413); }
finally { await limited.runtime.close(); }

const protectedRuntime = await start({ authRequired: true });
try {
  assert.equal((await request(protectedRuntime.port)).status, 401);
  assert.equal((await request(protectedRuntime.port, { authorization: "Bearer test-sensitive-token" })).status, 503);
  assert.equal(protectedRuntime.logs.join("\n").includes("test-sensitive-token"), false, "logs must not contain bearer tokens");
} finally { await protectedRuntime.runtime.close(); }

console.log("MCP Streamable HTTP smoke test passed: initialization, tool calls, safety boundaries, and session isolation verified.");
