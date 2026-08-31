"use strict";

require("dotenv/config");

const express = require("express");
const { GoogleAuth } = require("google-auth-library");
const { JUAN_SYSTEM_INSTRUCTION } = require("./travelerProfile");

const DEFAULT_JUAN_MCP_URL = "https://juan-whey.onrender.com/mcp";
const DEFAULT_PORT = 8080;
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_REQUEST_BYTES = "32kb";
const MAX_MCP_ACTION_CYCLES = 4;
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

class GeminiUpstreamError extends Error {
  constructor(status, details) {
    super(`Gemini request failed with HTTP ${status}.`);
    this.status = status;
    this.details = details;
  }
}

class GeminiToolLoopError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeminiToolLoopError";
  }
}

function csv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function absoluteHttpsUrl(value, name) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:") throw new Error("not https");
    return url.toString();
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL.`);
  }
}

function loadConfig(env = process.env) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is not supported; use the Cloud Run service identity.");
  }
  const geminiApiKey = String(env.GEMINI_API_KEY || "").trim();
  const model = String(env.GEMINI_MODEL || "").trim();
  const juanMcpUrl = absoluteHttpsUrl(env.JUAN_MCP_URL || DEFAULT_JUAN_MCP_URL, "JUAN_MCP_URL");
  const juanMcpAudience = absoluteHttpsUrl(env.JUAN_MCP_AUDIENCE || DEFAULT_JUAN_MCP_URL, "JUAN_MCP_AUDIENCE");
  const allowedTools = [...new Set(csv(env.JUAN_MCP_ALLOWED_TOOLS))];
  const allowedOrigins = [...new Set(csv(env.JUAN_UI_ALLOWED_ORIGINS))];
  const port = Number(env.PORT || DEFAULT_PORT);

  if (!geminiApiKey || !model || !allowedTools.length) {
    throw new Error("Configuration requires GEMINI_API_KEY, GEMINI_MODEL, and JUAN_MCP_ALLOWED_TOOLS.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");

  return { geminiApiKey, model, juanMcpUrl, juanMcpAudience, allowedTools, allowedOrigins, port };
}

function addRestrictedCors(app, allowedOrigins) {
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (request.method === "OPTIONS") {
      if (!origin || !allowedOrigins.includes(origin)) return response.sendStatus(403);
      return response.sendStatus(204);
    }
    return next();
  });
}

function extractOutputText(interaction) {
  if (typeof interaction.output_text === "string") return interaction.output_text;
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  for (const step of [...steps].reverse()) {
    if (step?.type !== "model_output") continue;
    const content = Array.isArray(step.content) ? step.content : [];
    const text = content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("");
    if (text) return text;
  }
  return null;
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
    .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[REDACTED]");
}

function safeErrorText(value) {
  return redactSensitiveText(value).slice(0, 8_000);
}

function isSensitiveFieldName(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "key" || normalized === "apikey" || normalized.includes("authorization") || normalized.includes("token") || normalized.includes("secret") || normalized.includes("credential") || normalized.includes("bearer") || normalized.includes("password") || normalized.includes("cookie") || normalized.includes("privatekey");
}

function sanitizeUpstreamValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeUpstreamValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSensitiveFieldName(key) ? "[REDACTED]" : sanitizeUpstreamValue(item)]));
  }
  return typeof value === "string" ? redactSensitiveText(value) : value;
}

function collectMcpToolCalls(value, calls = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectMcpToolCalls(item, calls);
    return calls;
  }
  if (!value || typeof value !== "object") return calls;
  if (value.type === "mcp_server_tool_call") {
    calls.push({ serverName: value.server_name ?? value.serverName ?? null, name: value.name ?? null, arguments: value.arguments ?? null });
  }
  for (const item of Object.values(value)) collectMcpToolCalls(item, calls);
  return calls;
}

function extractMcpToolCalls(interaction) {
  const calls = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.type === "mcp_server_tool_call") {
      calls.push({
        callId: value.id ?? value.call_id ?? null,
        serverName: value.server_name ?? value.serverName ?? null,
        name: value.name ?? null,
        arguments: value.arguments ?? {},
      });
      return;
    }
    for (const item of Object.values(value)) visit(item);
  };

  for (const step of Array.isArray(interaction?.steps) ? interaction.steps : []) visit(step);
  return calls;
}

function safeToolFailureResult(call, message) {
  return {
    type: "mcp_server_tool_result",
    call_id: call.callId,
    server_name: call.serverName || "juan_mcp",
    name: call.name || "unknown_tool",
    result: {
      content: [{ type: "text", text: message }],
      isError: true,
    },
  };
}

function isAllowedMcpToolCall(call, allowedTools) {
  return typeof call.callId === "string"
    && call.callId.length > 0
    && call.serverName === "juan_mcp"
    && typeof call.name === "string"
    && allowedTools.includes(call.name)
    && call.arguments
    && typeof call.arguments === "object"
    && !Array.isArray(call.arguments);
}

async function createMcpToolClient({ url, token }) {
  // The backend is CommonJS while the MCP SDK is ESM-first; its supported CJS
  // exports keep the transport implementation behind this narrow adapter.
  const { Client } = require("@modelcontextprotocol/sdk/client");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "juan-gemini-backend", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function executeMcpToolCalls({ config, mcpToken, calls, createClient = createMcpToolClient }) {
  let client;
  const results = [];
  try {
    client = await createClient({ url: config.juanMcpUrl, token: mcpToken });
  } catch {
    return calls.map((call) => safeToolFailureResult(call, "Juan could not reach the travel research service."));
  }

  try {
    for (const call of calls) {
      if (!isAllowedMcpToolCall(call, config.allowedTools)) {
        results.push(safeToolFailureResult(call, "This MCP tool request is not permitted."));
        continue;
      }
      try {
        const result = await client.callTool({ name: call.name, arguments: call.arguments });
        results.push({
          type: "mcp_server_tool_result",
          call_id: call.callId,
          server_name: call.serverName,
          name: call.name,
          result,
        });
      } catch {
        results.push(safeToolFailureResult(call, "Juan could not complete that travel research tool call."));
      }
    }
  } finally {
    await client.close().catch(() => {});
  }
  return results;
}

function logRequiresActionDiagnostics(interaction, logger) {
  if (interaction?.status !== "requires_action") return;
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  const requiresActionSteps = steps.filter((step) => step?.type === "requires_action");
  const diagnostic = sanitizeUpstreamValue({
    interactionId: interaction.id || null,
    interactionStatus: interaction.status,
    stepTypes: steps.map((step) => step?.type || null),
    requiresActionSteps,
    mcpToolCalls: collectMcpToolCalls(requiresActionSteps),
  });
  logger?.info?.(`[juan-gemini-backend] Gemini interaction requires action: ${JSON.stringify(diagnostic)}`);
}

async function safeGeminiErrorDetails(result) {
  const text = (await result.text()).slice(0, 4_000);
  if (!text) return "No response body.";
  try { return JSON.stringify(sanitizeUpstreamValue(JSON.parse(text))); }
  catch { return redactSensitiveText(text); }
}

async function getMcpIdToken(googleAuth, audience) {
  const client = await googleAuth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  // google-auth-library returns a Web Headers instance here, not a plain object.
  const authorization = typeof headers?.get === "function"
    ? headers.get("authorization")
    : headers?.Authorization || headers?.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new Error("Cloud Run service identity did not provide an ID token.");
  }
  return authorization.slice("Bearer ".length);
}

function createGeminiRequestBody({ config, mcpToken, input, previousInteractionId }) {
  const body = {
    model: config.model,
    input,
    system_instruction: JUAN_SYSTEM_INSTRUCTION,
    tools: [{
      type: "mcp_server",
      name: "juan_mcp",
      url: config.juanMcpUrl,
      headers: { Authorization: `Bearer ${mcpToken}` },
      allowed_tools: [{ mode: "auto", tools: config.allowedTools }],
    }],
  };
  if (previousInteractionId) body.previous_interaction_id = previousInteractionId;
  return body;
}

async function postGeminiInteraction({ config, mcpToken, input, previousInteractionId, fetchImpl, signal }) {
  const body = createGeminiRequestBody({ config, mcpToken, input, previousInteractionId });
  const result = await fetchImpl(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": config.geminiApiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!result.ok) throw new GeminiUpstreamError(result.status, await safeGeminiErrorDetails(result));
  const payload = await result.json();
  return payload.interaction || payload;
}

async function callGemini({ config, googleAuth, message, previousInteractionId, fetchImpl = fetch, logger = console, mcpToolExecutor = executeMcpToolCalls, maxActionCycles = MAX_MCP_ACTION_CYCLES }) {
  const mcpToken = await getMcpIdToken(googleAuth, config.juanMcpAudience);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60_000);
  try {
    let interaction = await postGeminiInteraction({
      config, mcpToken, input: message, previousInteractionId, fetchImpl, signal: abort.signal,
    });
    let actionCycles = 0;

    while (interaction?.status === "requires_action") {
      logRequiresActionDiagnostics(interaction, logger);
      if (actionCycles >= maxActionCycles) {
        throw new GeminiToolLoopError("Juan reached the maximum number of travel research action cycles.");
      }
      const calls = extractMcpToolCalls(interaction);
      if (!calls.length) {
        throw new GeminiToolLoopError("Gemini requested an unsupported action instead of a Juan MCP tool call.");
      }
      actionCycles += 1;
      const results = await mcpToolExecutor({ config, mcpToken, calls });
      if (!Array.isArray(results) || results.length !== calls.length) {
        throw new GeminiToolLoopError("Juan could not safely prepare the MCP tool results.");
      }
      interaction = await postGeminiInteraction({
        config,
        mcpToken,
        input: results,
        previousInteractionId: interaction.id || previousInteractionId,
        fetchImpl,
        signal: abort.signal,
      });
    }
    return {
      interactionId: interaction?.id || null,
      outputText: extractOutputText(interaction || {}),
      status: interaction?.status || null,
      previousInteractionId: interaction?.id || previousInteractionId || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function createApp({ config = loadConfig(), googleAuth = new GoogleAuth(), geminiCall = callGemini, logger = console } = {}) {
  const app = express();
  app.disable("x-powered-by");
  addRestrictedCors(app, config.allowedOrigins);
  app.use(express.json({ limit: MAX_REQUEST_BYTES, strict: true }));

  app.get("/health", (_request, response) => response.status(200).json({ ok: true, service: "juan-gemini-backend" }));
  app.post("/api/chat", async (request, response) => {
    const { message, previousInteractionId } = request.body || {};
    if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
      return response.status(400).json({ error: "message must be a non-empty string no longer than 12000 characters." });
    }
    if (previousInteractionId !== undefined && (typeof previousInteractionId !== "string" || !previousInteractionId.trim())) {
      return response.status(400).json({ error: "previousInteractionId must be a non-empty string when supplied." });
    }
    try {
      const result = await geminiCall({ config, googleAuth, message: message.trim(), previousInteractionId: previousInteractionId?.trim(), logger });
      return response.status(200).json(result);
    } catch (error) {
      if (error instanceof GeminiUpstreamError) {
        logger?.error?.(`[juan-gemini-backend] Gemini upstream failed (HTTP ${error.status}): ${error.details}`);
      } else {
        const name = safeErrorText(error?.name || "Error");
        const message = safeErrorText(error?.message || "Unknown error");
        logger?.error?.(`[juan-gemini-backend] chat request failed: ${name}: ${message}`);
        if (error?.stack) logger?.error?.(`[juan-gemini-backend] error stack: ${safeErrorText(error.stack)}`);
        if (error?.cause) {
          const causeName = safeErrorText(error.cause.name || "Error");
          const causeMessage = safeErrorText(error.cause.message || "Unknown error");
          logger?.error?.(`[juan-gemini-backend] error cause: ${causeName}: ${causeMessage}`);
        }
      }
      return response.status(502).json({ error: "Unable to complete the Gemini request." });
    }
  });
  app.use((error, _request, response, _next) => {
    if (error?.type === "entity.parse.failed" || error?.status === 413) {
      return response.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? "Request body is too large." : "Malformed JSON request." });
    }
    logger?.error?.("[juan-gemini-backend] request handling failed");
    return response.status(500).json({ error: "Internal server error." });
  });
  return app;
}

function start() {
  const config = loadConfig();
  const app = createApp({ config });
  return app.listen(config.port, () => console.info(`[juan-gemini-backend] listening on port ${config.port}`));
}

if (require.main === module) {
  try { start(); }
  catch (error) {
    console.error(`[juan-gemini-backend] startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_JUAN_MCP_URL,
  MAX_MCP_ACTION_CYCLES,
  GeminiUpstreamError,
  GeminiToolLoopError,
  callGemini,
  createApp,
  createGeminiRequestBody,
  createMcpToolClient,
  executeMcpToolCalls,
  extractMcpToolCalls,
  extractOutputText,
  getMcpIdToken,
  loadConfig,
  safeGeminiErrorDetails,
};
