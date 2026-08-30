"use strict";

require("dotenv/config");

const express = require("express");
const { GoogleAuth } = require("google-auth-library");

const DEFAULT_JUAN_MCP_URL = "https://juan-whey.onrender.com/mcp";
const DEFAULT_PORT = 8080;
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_REQUEST_BYTES = "32kb";
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

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

async function getMcpIdToken(googleAuth, audience) {
  const client = await googleAuth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  const authorization = headers.Authorization || headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new Error("Cloud Run service identity did not provide an ID token.");
  }
  return authorization.slice("Bearer ".length);
}

async function callGemini({ config, googleAuth, message, previousInteractionId, fetchImpl = fetch }) {
  const mcpToken = await getMcpIdToken(googleAuth, config.juanMcpAudience);
  const body = {
    model: config.model,
    input: message,
    tools: [{
      type: "mcp_server",
      name: "juan_mcp",
      url: config.juanMcpUrl,
      headers: { Authorization: `Bearer ${mcpToken}` },
      allowed_tools: [{ tools: config.allowedTools }],
    }],
  };
  if (previousInteractionId) body.previous_interaction_id = previousInteractionId;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60_000);
  try {
    const result = await fetchImpl(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": config.geminiApiKey },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!result.ok) throw new Error(`Gemini request failed with HTTP ${result.status}.`);
    const payload = await result.json();
    const interaction = payload.interaction || payload;
    return {
      interactionId: interaction.id || null,
      outputText: extractOutputText(interaction),
      status: interaction.status || null,
      previousInteractionId: interaction.id || previousInteractionId || null,
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
      const result = await geminiCall({ config, googleAuth, message: message.trim(), previousInteractionId: previousInteractionId?.trim() });
      return response.status(200).json(result);
    } catch {
      logger?.error?.("[juan-gemini-backend] chat request failed");
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

module.exports = { DEFAULT_JUAN_MCP_URL, createApp, extractOutputText, getMcpIdToken, loadConfig, callGemini };
