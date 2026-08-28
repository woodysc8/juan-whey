// Thin wrapper around the Amadeus for Developers "test" (free-tier) API.
// Handles OAuth2 client-credentials auth + token caching. No LLM involved anywhere in this file.

const BASE_URL = process.env.AMADEUS_BASE_URL || "https://test.api.amadeus.com";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) {
    return cachedToken;
  }

  const clientId = process.env.AMADEUS_CLIENT_ID;
  const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET. Copy .env.example to .env and fill in your free Amadeus for Developers keys (https://developers.amadeus.com)."
    );
  }

  const resp = await fetch(`${BASE_URL}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Amadeus auth failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken;
}

/**
 * GET a signed Amadeus endpoint. `params` is a plain object of query params.
 * Returns parsed JSON body. Throws with the Amadeus error payload on failure.
 */
export async function amadeusGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg =
      body?.errors?.map((e) => e.detail || e.title).join("; ") ||
      `HTTP ${resp.status}`;
    const err = new Error(`Amadeus request failed: ${msg}`);
    err.status = resp.status;
    err.body = body;
    throw err;
  }
  return body;
}
