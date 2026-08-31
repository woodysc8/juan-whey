"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { MAX_MCP_ACTION_CYCLES, callGemini, createApp, executeMcpToolCalls, getMcpIdToken, loadConfig } = require("../server.js");
const { JUAN_TRAVELER_PROFILE, buildJuanSystemInstruction } = require("../travelerProfile.js");

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

test("Cloud Run ID token client uses the Google Auth Headers contract", async () => {
  const googleAuth = { getIdTokenClient: async (audience) => {
    assert.equal(audience, config.juanMcpAudience);
    return { getRequestHeaders: async () => new Headers({ authorization: "Bearer synthetic-id-token" }) };
  } };

  assert.equal(await getMcpIdToken(googleAuth, config.juanMcpAudience), "synthetic-id-token");
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
      assert.match(body.system_instruction, /"name":"Sam"/);
      assert.match(body.system_instruction, /Address Sam as señor/);
      assert.equal(body.tools[0].headers.Authorization, "Bearer synthetic-id-token");
      assert.equal(Array.isArray(body.tools[0].allowed_tools), true);
      assert.deepEqual(body.tools[0].allowed_tools, [{ mode: "auto", tools: config.allowedTools }]);
      for (const allowedTool of body.tools[0].allowed_tools) {
        assert.equal(typeof allowedTool, "object");
        assert.deepEqual(allowedTool.tools, config.allowedTools);
      }
      return { ok: true, json: async () => ({ id: "interaction-1", status: "completed", output_text: "Here are options." }) };
    },
  });
  assert.deepEqual(result, { interactionId: "interaction-1", outputText: "Here are options.", status: "completed", previousInteractionId: "interaction-1" });
});

test("traveler profile is compact, avoids profile MCP calls, and defines research boundaries", () => {
  const instruction = buildJuanSystemInstruction();
  assert.equal(JUAN_TRAVELER_PROFILE.departure_airports.preferred[0], "BOS");
  assert.deepEqual(JUAN_TRAVELER_PROFILE.departure_airports.acceptable, ["PVD", "BDL", "NYC"]);
  assert.equal(JUAN_TRAVELER_PROFILE.rewards.bilt_member, true);
  assert.equal("dates" in JUAN_TRAVELER_PROFILE, false);
  assert.equal("destination" in JUAN_TRAVELER_PROFILE, false);
  assert.equal("current_prices" in JUAN_TRAVELER_PROFILE, false);
  assert.ok(Buffer.byteLength(instruction, "utf8") < 3_000, "profile context stays compact per interaction");
  assert.equal(instruction.includes("get_traveler_profile"), false, "stable facts are injected, not retrieved through MCP");
  assert.match(instruction, /Explicit trip instructions override profile defaults/);
  assert.match(instruction, /current external research/);
  assert.match(instruction, /proactively research a small set of promising destinations/);
  assert.match(instruction, /not current facts/);
  assert.doesNotMatch(JSON.stringify(JUAN_TRAVELER_PROFILE), /amadeus/i);
});

function completedInteraction(id = "interaction-completed", outputText = "Here are options.") {
  return { id, status: "completed", output_text: outputText };
}

function requiresActionInteraction(id, calls) {
  return {
    id,
    status: "requires_action",
    steps: [{
      type: "requires_action",
      required_action: { type: "tool_calls", tool_calls: calls },
    }],
  };
}

function mcpCall(id, name = "calculate_totals", argumentsValue = { numbers: [1, 2] }) {
  return { type: "mcp_server_tool_call", id, server_name: "juan_mcp", name, arguments: argumentsValue };
}

function functionCall(id, name = "calculate_totals", argumentsValue = { numbers: [1, 2] }) {
  return { type: "function_call", id, name, arguments: argumentsValue };
}

function mockGoogleAuth() {
  return { getIdTokenClient: async () => ({ getRequestHeaders: async () => ({ Authorization: "Bearer synthetic-id-token" }) }) };
}

function successfulToolExecutor(callsSeen) {
  return async ({ calls }) => {
    callsSeen.push(...calls);
    return calls.map((call) => call.resultType === "function_result"
      ? {
        type: "function_result",
        call_id: call.callId,
        name: call.name,
        result: JSON.stringify({ content: [{ type: "text", text: `result for ${call.name}` }] }),
      }
      : {
        type: "mcp_server_tool_result",
        call_id: call.callId,
        server_name: call.serverName,
        name: call.name,
        result: { content: [{ type: "text", text: `result for ${call.name}` }] },
      });
  };
}

test("requires_action diagnostics retain MCP call context without credentials", async () => {
  const logs = [];
  const callsSeen = [];
  const googleAuth = mockGoogleAuth();
  let requestCount = 0;
  const result = await callGemini({
    config,
    googleAuth,
    message: "Find a flight",
    logger: { info(message) { logs.push(message); } },
    mcpToolExecutor: successfulToolExecutor(callsSeen),
    fetchImpl: async (_url, options) => ({
      ok: true,
      json: async () => {
        requestCount += 1;
        if (requestCount === 1) return {
          id: "interaction-requires-action",
          status: "requires_action",
          steps: [
            { type: "model_output", content: [] },
            {
              type: "requires_action",
              required_action: {
                type: "tool_calls",
                tool_calls: [{
                type: "mcp_server_tool_call",
                id: "call-sensitive",
                server_name: "juan_mcp",
                name: "search_airports",
                arguments: {
                  keyword: "Miami",
                  authorization: "Bearer sensitive-mcp-token",
                  apiKey: "AIza12345678901234567890",
                  mcpBearer: "another-sensitive-token",
                },
              }],
            },
            },
          ],
        };
        const body = JSON.parse(options.body);
        assert.equal(body.previous_interaction_id, "interaction-requires-action");
        assert.equal(body.input[0].type, "mcp_server_tool_result");
        return completedInteraction("interaction-after-tool");
      },
    }),
  });
  assert.equal(result.status, "completed");
  assert.equal(callsSeen.length, 1);
  const output = logs.join("\n");
  assert.match(output, /interaction-requires-action/);
  assert.match(output, /requires_action/);
  assert.match(output, /model_output/);
  assert.match(output, /search_airports/);
  assert.match(output, /Miami/);
  assert.match(output, /\[REDACTED\]/);
  assert.equal(output.includes("sensitive-mcp-token"), false);
  assert.equal(output.includes("another-sensitive-token"), false);
  assert.equal(output.includes("AIza12345678901234567890"), false);
});

test("Gemini completes normally without MCP tool execution", async () => {
  let executorCalled = false;
  const result = await callGemini({
    config,
    googleAuth: mockGoogleAuth(),
    message: "Hello",
    mcpToolExecutor: async () => { executorCalled = true; return []; },
    fetchImpl: async () => ({ ok: true, json: async () => completedInteraction("normal", "Hello señor.") }),
  });
  assert.equal(executorCalled, false);
  assert.equal(result.status, "completed");
  assert.equal(result.outputText, "Hello señor.");
});

test("Gemini function_call supplies an MCP result and continues to completion", async () => {
  const callsSeen = [];
  const requests = [];
  const responses = [
    { id: "interaction-1", status: "requires_action", steps: [{ type: "thought", content: [] }, functionCall("call-1")] },
    completedInteraction("interaction-2", "The total is $3."),
  ];
  const result = await callGemini({
    config,
    googleAuth: mockGoogleAuth(),
    message: "Add numbers",
    mcpToolExecutor: successfulToolExecutor(callsSeen),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => responses.shift() };
    },
  });
  assert.equal(callsSeen.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].previous_interaction_id, "interaction-1");
  assert.deepEqual(requests[1].input[0], {
    type: "function_result",
    call_id: "call-1",
    name: "calculate_totals",
    result: JSON.stringify({ content: [{ type: "text", text: "result for calculate_totals" }] }),
  });
  assert.equal(result.outputText, "The total is $3.");
});

test("multiple Gemini function_call steps are executed before continuation", async () => {
  const callsSeen = [];
  const requests = [];
  const responses = [
    { id: "interaction-multi", status: "requires_action", steps: [functionCall("call-1"), functionCall("call-2", "get_trip_intent", {})] },
    completedInteraction("interaction-multi-finished"),
  ];
  await callGemini({
    config,
    googleAuth: mockGoogleAuth(),
    message: "Research",
    mcpToolExecutor: successfulToolExecutor(callsSeen),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => responses.shift() };
    },
  });
  assert.equal(callsSeen.length, 2);
  assert.equal(requests[1].input.length, 2);
  assert.deepEqual(requests[1].input.map((item) => item.call_id), ["call-1", "call-2"]);
});

test("Gemini follows a function_call action cycle with another MCP continuation", async () => {
  const callsSeen = [];
  const requests = [];
  const responses = [
    { id: "interaction-first", status: "requires_action", steps: [functionCall("call-first")] },
    { id: "interaction-second", status: "requires_action", steps: [functionCall("call-second", "get_trip_intent", {})] },
    completedInteraction("interaction-final", "Finished researching."),
  ];
  const result = await callGemini({
    config,
    googleAuth: mockGoogleAuth(),
    message: "Research twice",
    mcpToolExecutor: successfulToolExecutor(callsSeen),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => responses.shift() };
    },
  });
  assert.equal(callsSeen.length, 2);
  assert.equal(requests[1].previous_interaction_id, "interaction-first");
  assert.equal(requests[2].previous_interaction_id, "interaction-second");
  assert.equal(result.status, "completed");
});

test("MCP tool failures return Gemini function_result error steps", async () => {
  const requests = [];
  const responses = [
    { id: "interaction-failed-tool", status: "requires_action", steps: [functionCall("call-failed")] },
    completedInteraction("interaction-recovered", "That search failed, so I need another option."),
  ];
  const result = await callGemini({
    config,
    googleAuth: mockGoogleAuth(),
    message: "Research",
    mcpToolExecutor: async ({ calls }) => calls.map((call) => ({
      type: "function_result",
      call_id: call.callId,
      name: call.name,
      result: JSON.stringify({ error: "Tool execution failed." }),
      is_error: true,
    })),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => responses.shift() };
    },
  });
  assert.equal(requests[1].input[0].is_error, true);
  assert.equal(result.status, "completed");
});

test("MCP client tool failures become safe result steps without leaking the token", async () => {
  const result = await executeMcpToolCalls({
    config,
    mcpToken: "sensitive-mcp-token",
    calls: [{ callId: "call-failed-client", serverName: "juan_mcp", name: "calculate_totals", arguments: { numbers: [1, 2] }, resultType: "function_result" }],
    createClient: async ({ token }) => {
      assert.equal(token, "sensitive-mcp-token");
      return {
        callTool: async () => { throw new Error("upstream unavailable: sensitive-mcp-token"); },
        close: async () => {},
      };
    },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].is_error, true);
  assert.equal(result[0].result.includes("sensitive-mcp-token"), false);
});

test("non-allowlisted Gemini function calls are not sent to the MCP client", async () => {
  let clientCreated = false;
  let toolCalled = false;
  const results = await executeMcpToolCalls({
    config,
    mcpToken: "synthetic-id-token",
    calls: [{ callId: "call-not-allowed", serverName: "juan_mcp", name: "delete_everything", arguments: {}, resultType: "function_result" }],
    createClient: async () => {
      clientCreated = true;
      return { callTool: async () => { toolCalled = true; }, close: async () => {} };
    },
  });
  assert.equal(clientCreated, true, "a client connection may be opened once per action cycle");
  assert.equal(toolCalled, false);
  assert.equal(results[0].is_error, true);
  assert.match(results[0].result, /not permitted/);
});

test("malformed Gemini function calls fail safely before MCP execution", async () => {
  let executorCalled = false;
  await assert.rejects(() => callGemini({
    config,
    googleAuth: mockGoogleAuth(),
    message: "Bad call",
    mcpToolExecutor: async () => { executorCalled = true; return []; },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ id: "interaction-malformed", status: "requires_action", steps: [{ type: "function_call", id: "", name: "calculate_totals", arguments: [] }] }),
    }),
  }), /malformed MCP function call/);
  assert.equal(executorCalled, false);
});

test("MCP action cycles are bounded", async () => {
  let requestCount = 0;
  await assert.rejects(() => callGemini({
    config,
    googleAuth: mockGoogleAuth(),
    message: "Loop",
    maxActionCycles: 2,
    mcpToolExecutor: successfulToolExecutor([]),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ id: `interaction-${++requestCount}`, status: "requires_action", steps: [functionCall(`call-${requestCount}`)] }),
    }),
  }), /maximum number of travel research action cycles/);
  assert.equal(requestCount, 3, "the limit is checked before executing an additional cycle");
  assert.ok(MAX_MCP_ACTION_CYCLES >= 1);
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
