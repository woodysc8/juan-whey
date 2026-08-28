import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createJuanMcpHttpServer, loadMcpHttpConfig } from "../src/mcp-http-server.js";
import { createOidcTokenValidator, loadOidcAuthConfig } from "../src/auth/oidc.js";

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
async function start(overrides = {}, options = {}) {
  const logs = [];
  const runtime = createJuanMcpHttpServer({ config: config(overrides), logger: { info: (message) => logs.push(message) }, ...options });
  const address = await runtime.listen();
  return { runtime, logs, port: address.port };
}

assert.deepEqual(loadMcpHttpConfig({ MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "3010", MCP_PUBLIC_BASE_URL: "http://127.0.0.1:3010", MCP_ALLOWED_ORIGINS: "http://localhost:3010", MCP_ALLOWED_HOSTS: "127.0.0.1,localhost", MCP_AUTH_REQUIRED: "false" }).host, "127.0.0.1");
assert.throws(() => loadMcpHttpConfig({ MCP_HTTP_HOST: "0.0.0.0", MCP_HTTP_PORT: "3010", MCP_PUBLIC_BASE_URL: "https://example.test", MCP_ALLOWED_ORIGINS: "https://example.test", MCP_ALLOWED_HOSTS: "example.test", MCP_AUTH_REQUIRED: "false" }), /Refusing to bind/);
assert.equal(loadMcpHttpConfig({ MCP_HTTP_HOST: "127.0.0.1", PORT: "4567", MCP_PUBLIC_BASE_URL: "http://127.0.0.1:4567", MCP_ALLOWED_ORIGINS: "http://localhost:4567", MCP_ALLOWED_HOSTS: "127.0.0.1,localhost", MCP_AUTH_REQUIRED: "false" }).port, 4567, "PORT is the Render fallback");
assert.equal(loadMcpHttpConfig({ MCP_HTTP_HOST: "127.0.0.1", MCP_PUBLIC_BASE_URL: "http://127.0.0.1:3100", MCP_ALLOWED_ORIGINS: "http://localhost:3100", MCP_ALLOWED_HOSTS: "127.0.0.1,localhost", MCP_AUTH_REQUIRED: "false" }).port, 3100, "local port defaults safely");
assert.throws(() => loadMcpHttpConfig({ MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "3010", MCP_PUBLIC_BASE_URL: "http://127.0.0.1:3010", MCP_ALLOWED_ORIGINS: "http://localhost:3010", MCP_ALLOWED_HOSTS: "127.0.0.1,localhost", MCP_AUTH_REQUIRED: "true" }), /MCP_AUTH_ISSUER/, "required auth configuration fails closed");

const issuer = "https://issuer.example.test";
const audience = "juan-whey-mcp";
const requiredScopes = ["juan.mcp"];
const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = "test-key";
const authConfig = { issuer, audience, jwksUrl: "https://issuer.example.test/jwks", requiredScopes, allowedSubjects: [] };
const validator = createOidcTokenValidator(authConfig, { keySet: createLocalJWKSet({ keys: [publicJwk] }) });
async function token({ tokenIssuer = issuer, tokenAudience = audience, expiration = "5m", scope = "juan.mcp", subject } = {}) {
  const jwt = new SignJWT(scope === undefined ? {} : { scope })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(tokenIssuer).setAudience(tokenAudience).setIssuedAt();
  if (subject) jwt.setSubject(subject);
  if (expiration !== null) jwt.setExpirationTime(expiration);
  return jwt.sign(privateKey);
}
const validToken = await token();
assert.equal((await validator(`Bearer ${validToken}`)).iss, issuer, "valid token is accepted");
await assert.rejects(() => validator(), (error) => error.statusCode === 401, "missing token is rejected");
await assert.rejects(() => validator("Bearer not-a-jwt"), (error) => error.statusCode === 401, "malformed token is rejected");
const wrongKey = await generateKeyPair("RS256");
const invalidSignature = await new SignJWT({ scope: "juan.mcp" }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(wrongKey.privateKey);
await assert.rejects(() => validator(`Bearer ${invalidSignature}`), (error) => error.statusCode === 401, "invalid signature is rejected");
const wrongIssuerToken = await token({ tokenIssuer: "https://wrong-issuer.example.test" });
const wrongAudienceToken = await token({ tokenAudience: "wrong-audience" });
const expiredToken = await token({ expiration: "-1s" });
const noExpirationToken = await token({ expiration: null });
const missingScopeToken = await token({ scope: "other.scope" });
const scopedToken = await token({ scope: "other.scope juan.mcp" });
await assert.rejects(() => validator(`Bearer ${wrongIssuerToken}`), (error) => error.statusCode === 401, "wrong issuer is rejected");
await assert.rejects(() => validator(`Bearer ${wrongAudienceToken}`), (error) => error.statusCode === 401, "wrong audience is rejected");
await assert.rejects(() => validator(`Bearer ${expiredToken}`), (error) => error.statusCode === 401, "expired token is rejected");
await assert.rejects(() => validator(`Bearer ${noExpirationToken}`), (error) => error.statusCode === 401, "token without expiration is rejected");
await assert.rejects(() => validator(`Bearer ${missingScopeToken}`), (error) => error.statusCode === 403, "missing required scope is rejected");
assert.equal((await validator(`Bearer ${scopedToken}`)).aud, audience, "required scope is accepted");
assert.deepEqual(loadOidcAuthConfig({ MCP_AUTH_ISSUER: issuer, MCP_AUTH_AUDIENCE: audience, MCP_AUTH_JWKS_URL: "https://issuer.example.test/jwks", MCP_AUTH_REQUIRED_SCOPES: "juan.mcp, profile.read" }).requiredScopes, ["juan.mcp", "profile.read"]);
assert.throws(() => loadOidcAuthConfig({ MCP_AUTH_ISSUER: issuer, MCP_AUTH_AUDIENCE: audience, MCP_AUTH_JWKS_URL: "https://issuer.example.test/jwks", MCP_AUTH_REQUIRED_SCOPES: "", MCP_AUTH_ALLOWED_SUBJECTS: "" }), /REQUIRED_SCOPES or MCP_AUTH_ALLOWED_SUBJECTS/, "no authorization restriction fails closed");

const trustedGoogleSubject = "112010400000000710080";
const googleServiceAccountConfig = {
  issuer: "https://accounts.google.com",
  audience: "https://juan-whey.example.test/mcp",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  requiredScopes: [],
  allowedSubjects: [trustedGoogleSubject],
};
const googleServiceAccountValidator = createOidcTokenValidator(googleServiceAccountConfig, { keySet: createLocalJWKSet({ keys: [publicJwk] }) });
const trustedGoogleStyleToken = await token({ tokenIssuer: googleServiceAccountConfig.issuer, tokenAudience: googleServiceAccountConfig.audience, scope: undefined, subject: trustedGoogleSubject });
const untrustedGoogleStyleToken = await token({ tokenIssuer: googleServiceAccountConfig.issuer, tokenAudience: googleServiceAccountConfig.audience, scope: undefined, subject: "different-service-account" });
assert.equal((await googleServiceAccountValidator(`Bearer ${trustedGoogleStyleToken}`)).sub, trustedGoogleSubject, "scope-less Google-style token with allowed subject is accepted");
await assert.rejects(() => googleServiceAccountValidator(`Bearer ${untrustedGoogleStyleToken}`), (error) => error.statusCode === 403, "unauthorized token subject is rejected");
assert.deepEqual(loadOidcAuthConfig({ MCP_AUTH_ISSUER: googleServiceAccountConfig.issuer, MCP_AUTH_AUDIENCE: googleServiceAccountConfig.audience, MCP_AUTH_JWKS_URL: googleServiceAccountConfig.jwksUrl, MCP_AUTH_REQUIRED_SCOPES: "", MCP_AUTH_ALLOWED_SUBJECTS: trustedGoogleSubject }).allowedSubjects, [trustedGoogleSubject], "subject allowlist config loads");

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

const protectedRuntime = await start({ authRequired: true, auth: authConfig }, { authValidator: validator });
try {
  assert.equal((await request(protectedRuntime.port)).status, 401);
  assert.equal((await request(protectedRuntime.port, { authorization: "Bearer test-sensitive-token" })).status, 401);
  assert.equal((await request(protectedRuntime.port, { authorization: `Bearer ${missingScopeToken}` })).status, 403);
  const protectedTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${protectedRuntime.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${validToken}` } } });
  const protectedClient = new Client({ name: "juan-protected-http-test", version: "1.0.0" });
  await protectedClient.connect(protectedTransport);
  const protectedTotals = await protectedClient.callTool({ name: "calculate_totals", arguments: { items: [{ label: "hotel", amount: 125 }] } });
  assert.equal(JSON.parse(protectedTotals.content[0].text).gross, 125, "valid authenticated request reaches MCP tools");
  await protectedClient.close();
  assert.equal(protectedRuntime.logs.join("\n").includes(validToken), false, "logs must not contain bearer tokens");
} finally { await protectedRuntime.runtime.close(); }

const misconfiguredRuntime = await start({ authRequired: true });
try { assert.equal((await request(misconfiguredRuntime.port, { authorization: "Bearer test-sensitive-token" })).status, 503); }
finally { await misconfiguredRuntime.runtime.close(); }

console.log("MCP Streamable HTTP smoke test passed: initialization, tool calls, safety boundaries, and session isolation verified.");
