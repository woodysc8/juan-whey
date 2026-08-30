"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { callGemini, createApp, loadConfig } = require("../server.js");

const config = {
  geminiApiKey: "test-key-not-a-real-secret",
  model: "gemini-test-model",
  juanMcpUrl: "https://juan-whey.onrender.com/mcp",
  juanMcpAudience: "https://juan-whey.onrender.com/mcp",
  allowedTools: ["calculate_totals", "get_trip_intent"],
  allowedOrigins: [],
  port: 0,
};

test("configuration requires an explicit MCP tool allowlist", () => {
  assert.throws(() => loadConfig({ GEMINI_API_KEY: "test", GEMINI_MODEL: "model", JUAN_MCP_ALLOWED_TOOLS: "" }), /JUAN_MCP_ALLOWED_TOOLS/);
  assert.throws(() => loadConfig({ GEMINI_API_KEY: "test", GEMINI_MODEL: "model", JUAN_MCP_ALLOWED_TOOLS: "calculate_totals", GOOGLE_APPLICATION_CREDENTIALS: "key.json" }), /GOOGLE_APPLICATION_CREDENTIALS/);
});

test("Gemini request contains a fresh server-side MCP token and explicit allowlist", async () => {
  const googleAuth = { getIdTokenClient: async (audience) => {
    assert.equal(audience, config.juanMcpAudience);
    return { getRequestHeaders: async () => ({ Authorization: "Bearer synthetic-id-token" }) };
  } };
  const result = await callGemini({
    config,
    googleAuth,
    message: "Find a flight",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(options.headers["x-goog-api-key"], config.geminiApiKey);
      assert.equal(body.tools[0].headers.Authorization, "Bearer synthetic-id-token");
      assert.deepEqual(body.tools[0].allowed_tools, { mode: "auto", tools: config.allowedTools });
      return { ok: true, json: async () => ({ id: "interaction-1", status: "completed", output_text: "Here are options." }) };
    },
  });
  assert.deepEqual(result, { interactionId: "interaction-1", outputText: "Here are options.", status: "completed", previousInteractionId: "interaction-1" });
});

test("Gemini upstream failure logs safe status and details without credentials", async () => {
  const logs = [];
  const googleAuth = { getIdTokenClient: async () => ({ getRequestHeaders: async () => ({ Authorization: "Bearer sensitive-mcp-token" }) }) };
  let upstreamError;
  try {
    await callGemini({ config, googleAuth, message: "test", fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "bad request", api_key: "must-not-log" } }) }) });
  } catch (error) { upstreamError = error; }
  assert.equal(upstreamError.status, 400);
  assert.match(upstreamError.details, /\[REDACTED\]/);

  const app = createApp({ config, geminiCall: async () => { throw upstreamError; }, logger: { error(message) { logs.push(message); } } });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "test" }) });
    assert.equal(response.status, 502);
    assert.match(logs.join("\n"), /HTTP 400/);
    assert.equal(logs.join("\n").includes("must-not-log"), false);
    assert.equal(logs.join("\n").includes("sensitive-mcp-token"), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("generic chat errors log safe diagnostics without credentials", async () => {
  const logs = [];
  const error = new Error("metadata token failed for Bearer sensitive-mcp-token and AIza12345678901234567890");
  error.name = "FetchError";
  error.cause = new Error("socket closed while using Bearer another-sensitive-token");
  const app = createApp({ config, geminiCall: async () => { throw error; }, logger: { error(message) { logs.push(message); } } });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "test" }) });
    assert.equal(response.status, 502);
    const output = logs.join("\n");
    assert.match(output, /FetchError: metadata token failed/);
    assert.match(output, /error stack:/);
    assert.match(output, /error cause: Error: socket closed/);
    assert.equal(output.includes("sensitive-mcp-token"), false);
    assert.equal(output.includes("another-sensitive-token"), false);
    assert.equal(output.includes("AIza12345678901234567890"), false);
  } finally {
    await new Promise((resolve, reject) => server.close((closeError) => closeError ? reject(closeError) : resolve()));
  }
});

test("health and chat endpoints validate requests without provider calls", async () => {
  const app = createApp({ config, geminiCall: async ({ message }) => ({ interactionId: "interaction-2", outputText: message, status: "completed", previousInteractionId: "interaction-2" }), logger: { error() {} } });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const invalid = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.equal(invalid.status, 400);

    const chat = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Hello Señor" }) });
    assert.equal(chat.status, 200);
    assert.equal((await chat.json()).outputText, "Hello Señor");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
