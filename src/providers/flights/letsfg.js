const BASE_URL = "https://letsfg.co";
const DEFAULT_TIMEOUT_MS = 90_000;
const POLL_MS = 2_000;
const cabinClasses = { economy: "M", premium_economy: "W", "premium-economy": "W", business: "C", first: "F" };

function cabinClassCode(cabinClass) {
  if (cabinClass === undefined || cabinClass === null) return "M";
  const code = cabinClasses[String(cabinClass).toLowerCase()];
  if (!code) throw new Error(`Unsupported cabinClass '${cabinClass}'. Use economy, premium_economy, business, or first.`);
  return code;
}
function airport(code) { return code ? { name: null, code, time: null } : null; }
function normalizeSegment(segment) {
  return { airline: segment.airline || segment.carrier || null, flightNumber: segment.flight_no || segment.flightNumber || null, origin: airport(segment.origin), destination: airport(segment.destination), departureTime: segment.departure || null, arrivalTime: segment.arrival || null, durationMinutes: segment.duration_seconds ? Math.round(segment.duration_seconds / 60) : segment.duration_minutes ?? null, aircraft: segment.aircraft || null, travelClass: segment.cabin_class || null, amenities: segment.amenities || [] };
}

export function normalizeLetsFgOption(offer, currency, searchId) {
  const outbound = offer.outbound || offer.itinerary || {};
  const segments = (outbound.segments || offer.segments || []).map(normalizeSegment);
  const first = segments[0]; const last = segments.at(-1);
  const durationSeconds = outbound.total_duration_seconds ?? offer.total_duration_seconds;
  const stops = outbound.stopovers ?? offer.stopovers ?? Math.max(0, segments.length - 1);
  return {
    id: `letsfg:${offer.id || offer.offer_id || "unknown"}`,
    provider: "letsfg", source: "LetsFG free agent search",
    price: { total: Number(offer.price ?? offer.total_price), currency: offer.currency || currency || null },
    airlines: offer.airlines || [...new Set(segments.map((segment) => segment.airline).filter(Boolean))],
    flightNumbers: segments.map((segment) => segment.flightNumber).filter(Boolean),
    origin: first?.origin || airport(outbound.origin) || null, destination: last?.destination || airport(outbound.destination) || null,
    departureTime: first?.departureTime || outbound.departure || null, arrivalTime: last?.arrivalTime || outbound.arrival || null,
    totalDurationMinutes: durationSeconds ? Math.round(durationSeconds / 60) : outbound.total_duration_minutes ?? null,
    stops, layovers: outbound.layovers || [], baggage: offer.baggage || offer.conditions?.baggage || [],
    fareNotes: offer.conditions || null, emissions: offer.emissions || offer.carbon_emissions || null,
    itineraries: [{ segments, totalDurationMinutes: durationSeconds ? Math.round(durationSeconds / 60) : null }],
    booking: { searchId: searchId || null, providerOfferId: offer.id || offer.offer_id || null, researchOnly: true },
  };
}

function safeErrorMessage(data, fallback) { return data?.error || data?.message || fallback; }
async function json(response) { return response.json().catch(() => null); }

export async function searchFlights({ origin, destination, departureDate, returnDate, adults = 1, cabinClass = "economy", nonStop = false, currencyCode = "USD", max = 10, includeRaw = false, fetchImpl = fetch, baseUrl = BASE_URL }) {
  const token = process.env.LETSFG_BEARER_TOKEN;
  if (!token) throw new Error("Missing LETSFG_BEARER_TOKEN for the LetsFG free agent flight provider. Run LetsFG auth manually and configure its bearer token; do not use LETSFG_API_KEY here.");
  const controller = new AbortController();
  const timeoutMs = Number(process.env.LETSFG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const body = { origin, destination, date_from: departureDate, return_from: returnDate || undefined, adults, cabin_class: cabinClassCode(cabinClass), max_stopovers: nonStop ? 0 : 2, currency: currencyCode, limit: max, sort: "price" };
  const deadline = Date.now() + timeoutMs;
  try {
    const start = await fetchImpl(`${baseUrl}/api/search`, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const startData = await json(start);
    if (!start.ok) throw new Error(`LetsFG flight search failed (${start.status}): ${safeErrorMessage(startData, `HTTP ${start.status}`)}`);
    let result = startData;
    const searchId = result?.search_id || result?.id || null;
    while (searchId && (!Array.isArray(result.offers) || result.status === "searching" || result.split_ticket_pending || result.gf_enrich_pending) && Date.now() < deadline) {
      const poll = await fetchImpl(`${baseUrl}/api/results/${encodeURIComponent(searchId)}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      result = await json(poll);
      if (!poll.ok) throw new Error(`LetsFG result polling failed (${poll.status}): ${safeErrorMessage(result, `HTTP ${poll.status}`)}`);
      if (Array.isArray(result?.offers) && result.status !== "searching" && !result.split_ticket_pending && !result.gf_enrich_pending) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (searchId && Date.now() >= deadline) throw new Error(`LetsFG flight search timed out after ${timeoutMs}ms.`);
    const offers = result?.offers || [];
    if (!Array.isArray(offers) || !offers.length) throw new Error("LetsFG returned no flight results for this search.");
    const options = offers.slice(0, max).map((offer) => normalizeLetsFgOption(offer, result.currency || currencyCode, searchId));
    return { provider: "letsfg", source: "LetsFG free agent search", search: { origin, destination, departureDate, returnDate: returnDate || null, adults, cabinClass, currency: currencyCode }, optionCount: options.length, options, ...(includeRaw ? { raw: result } : {}) };
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`LetsFG flight search timed out after ${timeoutMs}ms.`);
    // Never include request headers/token in error messages.
    throw error;
  } finally { clearTimeout(timer); }
}
