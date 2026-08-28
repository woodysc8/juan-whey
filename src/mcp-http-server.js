#!/usr/bin/env node
import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createJuanMcpServer } from "./mcpFactory.js";

const DEFAULTS = { maxBodyBytes: 1_000_000, maxConcurrentRequests: 10, maxSessions: 10, requestTimeoutMs: 30_000 };

function csv(value) { return String(value || "").split(",").map((item) => item.trim()).filter(Boolean); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function isLoopback(host) { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(host).toLowerCase()); }
function hostName(header) { try { return new URL(`http://${header}`).hostname.toLowerCase(); } catch { return ""; } }
function jsonError(response, status, message) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}
function safeLog(logger, event) { logger?.info?.(`[juan-mcp-http] ${event}`); }
function containsRawRequest(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsRawRequest);
  if (value.includeRaw === true) return true;
  return Object.values(value).some(containsRawRequest);
}

async function readJsonBody(request, maxBytes) {
  const advertisedLength = Number(request.headers["content-length"]);
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    const error = new Error("Request body too large."); error.statusCode = 413; throw error;
  }
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) { const error = new Error("Request body too large."); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { const error = new Error("Malformed JSON-RPC request."); error.statusCode = 400; throw error; }
}

/** Read explicit HTTP configuration. Non-local unauthenticated binding is rejected. */
export function loadMcpHttpConfig(env = process.env) {
  const host = String(env.MCP_HTTP_HOST || "").trim();
  const port = Number(env.MCP_HTTP_PORT);
  const publicBaseUrl = String(env.MCP_PUBLIC_BASE_URL || "").trim();
  const allowedOrigins = csv(env.MCP_ALLOWED_ORIGINS);
  const allowedHosts = csv(env.MCP_ALLOWED_HOSTS);
  const authRequired = String(env.MCP_AUTH_REQUIRED || "").trim().toLowerCase();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !publicBaseUrl || !allowedOrigins.length || !allowedHosts.length || !["true", "false"].includes(authRequired)) {
    throw new Error("MCP HTTP configuration requires MCP_HTTP_HOST, MCP_HTTP_PORT, MCP_PUBLIC_BASE_URL, MCP_ALLOWED_ORIGINS, MCP_ALLOWED_HOSTS, and MCP_AUTH_REQUIRED.");
  }
  try { new URL(publicBaseUrl); } catch { throw new Error("MCP_PUBLIC_BASE_URL must be an absolute URL."); }
  if (allowedOrigins.includes("*") || allowedHosts.includes("*")) throw new Error("MCP HTTP allowlists must be explicit; '*' is not permitted.");
  if (authRequired === "false" && !isLoopback(host)) throw new Error("Refusing to bind an unauthenticated MCP HTTP server to a non-loopback host.");
  return {
    host, port, publicBaseUrl, allowedOrigins, allowedHosts, authRequired: authRequired === "true",
    maxBodyBytes: positiveInteger(env.MCP_HTTP_MAX_BODY_BYTES, DEFAULTS.maxBodyBytes),
    maxConcurrentRequests: positiveInteger(env.MCP_HTTP_MAX_CONCURRENT_REQUESTS, DEFAULTS.maxConcurrentRequests),
    maxSessions: positiveInteger(env.MCP_HTTP_MAX_SESSIONS, DEFAULTS.maxSessions),
    requestTimeoutMs: positiveInteger(env.MCP_HTTP_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
  };
}

/**
 * Creates a stateful Streamable HTTP adapter around the existing MCP factory.
 * It does not add or duplicate Juan tool logic.
 */
export function createJuanMcpHttpServer({ config = loadMcpHttpConfig(), createMcpServer = createJuanMcpServer, logger = console } = {}) {
  const sessions = new Map();
  let activeRequests = 0;
  async function closeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.closing) return;
    session.closing = true; sessions.delete(sessionId);
    await Promise.allSettled([session.transport.close(), session.server.close()]);
  }
  function requestIsAllowed(request, response) {
    const receivedHost = String(request.headers.host || "");
    const receivedHostName = hostName(receivedHost);
    const allowedHost = config.allowedHosts.includes(receivedHost) || config.allowedHosts.map((item) => hostName(item) || item.toLowerCase()).includes(receivedHostName);
    if (!allowedHost) { safeLog(logger, "rejected disallowed host"); jsonError(response, 403, "Host is not allowed."); return false; }
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.includes(String(origin))) { safeLog(logger, "rejected disallowed origin"); jsonError(response, 403, "Origin is not allowed."); return false; }
    if (config.authRequired) {
      const authorization = request.headers.authorization;
      if (!authorization) { safeLog(logger, "rejected missing authentication"); response.setHeader("www-authenticate", "Bearer"); jsonError(response, 401, "Authentication is required."); return false; }
      // No issuer/JWKS validator is configured in this repository. Do not accept unverified tokens.
      safeLog(logger, "rejected unconfigured token validation"); jsonError(response, 503, "OAuth/OIDC token validation is not configured."); return false;
    }
    return true;
  }
  const httpServer = createServer(async (request, response) => {
    const path = new URL(request.url || "/", "http://localhost").pathname;
    if (path !== "/mcp") { jsonError(response, 404, "Not found."); return; }
    if (!requestIsAllowed(request, response)) return;
    if (activeRequests >= config.maxConcurrentRequests) { safeLog(logger, "rejected concurrency limit"); jsonError(response, 429, "Too many concurrent MCP requests."); return; }
    activeRequests += 1;
    const timeout = setTimeout(() => {
      if (!response.headersSent) jsonError(response, 504, "MCP request timed out.");
      request.destroy();
    }, config.requestTimeoutMs);
    try {
      const method = request.method || "GET";
      const body = method === "POST" ? await readJsonBody(request, config.maxBodyBytes) : undefined;
      if (containsRawRequest(body)) { jsonError(response, 403, "Raw provider responses are disabled for remote MCP."); return; }
      const sessionId = typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : null;
      let session = sessionId ? sessions.get(sessionId) : null;
      if (!session) {
        if (method !== "POST" || body?.method !== "initialize" || sessionId) { jsonError(response, 400, "A valid MCP initialization request is required."); return; }
        if (sessions.size >= config.maxSessions) { safeLog(logger, "rejected session limit"); jsonError(response, 429, "Too many active MCP sessions."); return; }
        const server = createMcpServer();
        let initializedId = null;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
          onsessioninitialized: (id) => { initializedId = id; sessions.set(id, { server, transport, closing: false }); },
        });
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
        if (!initializedId) await Promise.allSettled([transport.close(), server.close()]);
        return;
      }
      await session.transport.handleRequest(request, response, body);
      if (method === "DELETE" && sessionId) await closeSession(sessionId);
    } catch (error) {
      const status = error.statusCode === 413 ? 413 : error.statusCode === 400 ? 400 : 500;
      safeLog(logger, `handled request failure (${status})`);
      jsonError(response, status, status === 413 ? "Request body too large." : status === 400 ? "Malformed MCP request." : "Internal MCP server error.");
    } finally { clearTimeout(timeout); activeRequests -= 1; }
  });
  return {
    config, sessions, httpServer,
    async listen() { await new Promise((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(config.port, config.host, () => { httpServer.off("error", reject); resolve(); }); }); return httpServer.address(); },
    async close() { for (const id of [...sessions.keys()]) await closeSession(id); await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())); },
  };
}

export async function startJuanMcpHttpServer() {
  const runtime = createJuanMcpHttpServer();
  const address = await runtime.listen();
  safeLog(console, `listening on ${typeof address === "object" ? `${address.address}:${address.port}` : address}/mcp`);
  return runtime;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startJuanMcpHttpServer().catch((error) => { console.error(`[juan-mcp-http] startup failed: ${error.message}`); process.exitCode = 1; });
}
