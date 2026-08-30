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
      assert.deepEqual(body.tools[0].allowed_tools, [{ tools: config.allowedTools }]);
      return { ok: true, json: async () => ({ id: "interaction-1", status: "completed", output_text: "Here are options." }) };
    },
  });
  assert.deepEqual(result, { interactionId: "interaction-1", outputText: "Here are options.", status: "completed", previousInteractionId: "interaction-1" });
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
