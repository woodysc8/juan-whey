import { createRemoteJWKSet, jwtVerify } from "jose";

export class AuthenticationError extends Error {
  constructor(statusCode, message, { wwwAuthenticate } = {}) {
    super(message);
    this.name = "AuthenticationError";
    this.statusCode = statusCode;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

function csv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function requireAbsoluteHttpsUrl(value, name) {
  const raw = String(value || "").trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") throw new Error("not https");
    // OIDC issuer matching is exact. Do not normalize a trailing slash here.
    return raw;
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL.`);
  }
}

/**
 * Reads the resource-server settings needed to authenticate a public MCP
 * endpoint. This intentionally does not discover providers or accept secrets.
 */
export function loadOidcAuthConfig(env = process.env) {
  const issuer = requireAbsoluteHttpsUrl(env.MCP_AUTH_ISSUER, "MCP_AUTH_ISSUER");
  const jwksUrl = requireAbsoluteHttpsUrl(env.MCP_AUTH_JWKS_URL, "MCP_AUTH_JWKS_URL");
  const audience = String(env.MCP_AUTH_AUDIENCE || "").trim();
  const requiredScopes = csv(env.MCP_AUTH_REQUIRED_SCOPES);
  const allowedSubjects = csv(env.MCP_AUTH_ALLOWED_SUBJECTS);
  if (!audience) throw new Error("MCP_AUTH_AUDIENCE is required when MCP_AUTH_REQUIRED=true.");
  if (!requiredScopes.length && !allowedSubjects.length) {
    throw new Error("Configure MCP_AUTH_REQUIRED_SCOPES or MCP_AUTH_ALLOWED_SUBJECTS when MCP_AUTH_REQUIRED=true.");
  }
  return { issuer, audience, jwksUrl, requiredScopes, allowedSubjects };
}

function extractBearerToken(authorization) {
  if (!authorization) {
    throw new AuthenticationError(401, "Authentication is required.", { wwwAuthenticate: "Bearer" });
  }
  const match = /^Bearer ([^\s]+)$/.exec(String(authorization));
  if (!match || match[1].split(".").length !== 3) {
    throw new AuthenticationError(401, "Invalid bearer token.", { wwwAuthenticate: 'Bearer error="invalid_token"' });
  }
  return match[1];
}

function tokenScopes(payload) {
  const scopes = [];
  if (typeof payload.scope === "string") scopes.push(...payload.scope.split(/\s+/));
  if (Array.isArray(payload.scp)) scopes.push(...payload.scp.filter((scope) => typeof scope === "string"));
  else if (typeof payload.scp === "string") scopes.push(...payload.scp.split(/\s+/));
  return new Set(scopes.filter(Boolean));
}

/**
 * Creates an OAuth/OIDC resource-server validator. `keySet` is injectable for
 * deterministic tests; production uses the configured remote JWKS endpoint.
 */
export function createOidcTokenValidator(authConfig, { keySet } = {}) {
  const requiredScopes = authConfig?.requiredScopes || [];
  const allowedSubjects = authConfig?.allowedSubjects || [];
  if (!authConfig?.issuer || !authConfig?.audience || !authConfig?.jwksUrl || !Array.isArray(requiredScopes) || !Array.isArray(allowedSubjects) || (!requiredScopes.length && !allowedSubjects.length)) {
    throw new Error("OAuth/OIDC authentication configuration is incomplete.");
  }
  const jwks = keySet || createRemoteJWKSet(new URL(authConfig.jwksUrl));
  return async function validateAuthorizationHeader(authorization) {
    const token = extractBearerToken(authorization);
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: authConfig.issuer,
        audience: authConfig.audience,
        requiredClaims: ["exp"],
      }));
    } catch {
      // Do not reveal signature, issuer, audience, or temporal validation details.
      throw new AuthenticationError(401, "Invalid bearer token.", { wwwAuthenticate: 'Bearer error="invalid_token"' });
    }
    if (allowedSubjects.length && !allowedSubjects.includes(String(payload.sub || ""))) {
      throw new AuthenticationError(403, "Token subject is not allowed.", { wwwAuthenticate: "Bearer error=\"insufficient_scope\"" });
    }
    const granted = tokenScopes(payload);
    if (!requiredScopes.every((scope) => granted.has(scope))) {
      throw new AuthenticationError(403, "Required scope is missing.", {
        wwwAuthenticate: `Bearer error="insufficient_scope", scope="${requiredScopes.join(" ")}"`,
      });
    }
    return payload;
  };
}
