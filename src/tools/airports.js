const SERPAPI_URL = "https://serpapi.com/search.json";
const DEFAULT_TIMEOUT_MS = 30_000;

function requestedTypes(subType) {
  return new Set(String(subType || "AIRPORT,CITY").split(",").map((type) => type.trim().toUpperCase()).filter(Boolean));
}

function normalizeSuggestions(suggestions, types) {
  const byCode = new Map();
  for (const suggestion of suggestions || []) {
    const suggestionType = String(suggestion?.type || "").toUpperCase();
    const airports = Array.isArray(suggestion?.airports) ? suggestion.airports : [];
    for (const airport of airports) {
      const iataCode = typeof airport?.id === "string" ? airport.id.toUpperCase() : null;
      if (!iataCode || !/^[A-Z]{3}$/.test(iataCode) || !types.has("AIRPORT") || byCode.has(iataCode)) continue;
      byCode.set(iataCode, {
        name: airport.name || null,
        iataCode,
        type: "AIRPORT",
        cityName: airport.city || (suggestionType === "CITY" ? suggestion.name || null : null),
        countryName: airport.country || suggestion.country || null,
      });
    }

    // Google Flights can also return a direct airport suggestion rather than an
    // enclosing city/region suggestion with an airports array.
    const iataCode = typeof suggestion?.id === "string" ? suggestion.id.toUpperCase() : null;
    if (suggestionType === "AIRPORT" && types.has("AIRPORT") && iataCode && /^[A-Z]{3}$/.test(iataCode) && !byCode.has(iataCode)) {
      byCode.set(iataCode, {
        name: suggestion.name || null,
        iataCode,
        type: "AIRPORT",
        cityName: suggestion.city || null,
        countryName: suggestion.country || null,
      });
    }
  }
  return [...byCode.values()].slice(0, 10);
}

// Resolve a free-text place name through the existing SerpApi Google Flights
// integration. This is research-only autocomplete; it does not book travel.
export async function searchAirports({ keyword, subType = "AIRPORT,CITY" }) {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new Error("Missing SERPAPI_API_KEY for airport autocomplete.");

  const query = String(keyword || "").trim();
  if (!query) return { query, results: [] };
  const parameters = new URLSearchParams({ engine: "google_flights_autocomplete", q: query, hl: "en", gl: "us", api_key: apiKey });
  const controller = new AbortController();
  const timeoutMs = Number(process.env.SERPAPI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${SERPAPI_URL}?${parameters}`, { signal: controller.signal });
  } catch (error) {
    const reason = error.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error.message;
    throw new Error(`SerpApi airport autocomplete failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`SerpApi airport autocomplete failed (${response.status}): ${data?.error || data?.message || `HTTP ${response.status}`}`);
  if (data?.error) throw new Error(`SerpApi airport autocomplete failed: ${data.error}`);
  if (!Array.isArray(data?.suggestions)) throw new Error("SerpApi returned malformed airport autocomplete results.");

  return { query, results: normalizeSuggestions(data.suggestions, requestedTypes(subType)) };
}
