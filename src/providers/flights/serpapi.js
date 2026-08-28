const SERPAPI_URL = "https://serpapi.com/search.json";
const DEFAULT_TIMEOUT_MS = 30_000;
const cabinClasses = { economy: 1, premium_economy: 2, "premium-economy": 2, business: 3, first: 4 };

function airport(value) { return value ? { name: value.name, code: value.id, time: value.time } : null; }
function normalizeLeg(flight) {
  return { airline: flight.airline, flightNumber: flight.flight_number, origin: airport(flight.departure_airport), destination: airport(flight.arrival_airport), departureTime: flight.departure_airport?.time, arrivalTime: flight.arrival_airport?.time, durationMinutes: flight.duration, aircraft: flight.airplane, travelClass: flight.travel_class, legroom: flight.legroom, amenities: flight.extensions || [], operatedBy: flight.plane_and_crew_by, oftenDelayedOver30Minutes: flight.often_delayed_by_over_30_min || false };
}

export function normalizeSerpApiOption(option, currency, searchLink) {
  const segments = (option.flights || []).map(normalizeLeg);
  const first = segments[0]; const last = segments.at(-1);
  return {
    id: `serpapi:${option.departure_token || `${first?.flightNumber || "unknown"}:${option.price || "unknown"}`}`,
    provider: "serpapi", source: "Google Flights via SerpApi", price: { total: option.price, currency },
    airlines: [...new Set(segments.map((segment) => segment.airline).filter(Boolean))], flightNumbers: segments.map((segment) => segment.flightNumber).filter(Boolean),
    origin: first?.origin || null, destination: last?.destination || null, departureTime: first?.departureTime, arrivalTime: last?.arrivalTime,
    totalDurationMinutes: option.total_duration, stops: Math.max(0, segments.length - 1),
    layovers: (option.layovers || []).map((layover) => ({ airport: { name: layover.name, code: layover.id }, durationMinutes: layover.duration })),
    baggage: (option.extensions || []).filter((item) => /bag/i.test(item)), fareNotes: option.extensions || [],
    emissions: option.carbon_emissions ? { grams: option.carbon_emissions.this_flight, typicalGrams: option.carbon_emissions.typical_for_this_route, differencePercent: option.carbon_emissions.difference_percent } : null,
    itineraries: [{ segments, totalDurationMinutes: option.total_duration }],
    booking: { searchLink: searchLink || null, departureToken: option.departure_token || null, bookingToken: option.booking_token || null, returnLegSelectionRequired: option.type === "Round trip" && Boolean(option.departure_token) },
  };
}

function cabinClassCode(cabinClass) {
  if (cabinClass === undefined || cabinClass === null) return 1;
  if (Number.isInteger(cabinClass) && cabinClass >= 1 && cabinClass <= 4) return cabinClass;
  const code = cabinClasses[String(cabinClass).toLowerCase()];
  if (!code) throw new Error(`Unsupported cabinClass '${cabinClass}'. Use economy, premium_economy, business, or first.`);
  return code;
}

export async function searchFlights({ origin, destination, departureDate, returnDate, adults = 1, cabinClass = "economy", nonStop = false, currencyCode = "USD", max = 10, includeRaw = false }) {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new Error("Missing SERPAPI_API_KEY for the active SerpApi flight provider.");
  const parameters = new URLSearchParams({ engine: "google_flights", departure_id: origin, arrival_id: destination, outbound_date: departureDate, adults: String(adults), travel_class: String(cabinClassCode(cabinClass)), currency: currencyCode, hl: "en", type: returnDate ? "1" : "2", stops: nonStop ? "1" : "0", api_key: apiKey });
  if (returnDate) parameters.set("return_date", returnDate);
  const controller = new AbortController();
  const timeoutMs = Number(process.env.SERPAPI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try { response = await fetch(`${SERPAPI_URL}?${parameters}`, { signal: controller.signal }); }
  catch (error) { const reason = error.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error.message; throw new Error(`SerpApi flight search failed: ${reason}`); }
  finally { clearTimeout(timeout); }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`SerpApi flight search failed (${response.status}): ${data?.error || data?.message || `HTTP ${response.status}`}`);
  if (data?.error) throw new Error(`SerpApi flight search failed: ${data.error}`);
  const rawOptions = [...(data?.best_flights || []), ...(data?.other_flights || [])];
  if (!rawOptions.length) throw new Error("SerpApi returned no flight results for this search.");
  if (rawOptions.some((option) => !Array.isArray(option.flights) || !option.flights.length)) throw new Error("SerpApi returned malformed flight results.");
  const currency = data.search_parameters?.currency || currencyCode;
  const searchLink = data.google_flights_url || data.search_metadata?.google_flights_url || null;
  const options = rawOptions.slice(0, max).map((option) => normalizeSerpApiOption(option, currency, searchLink));
  return { provider: "serpapi", source: "Google Flights via SerpApi", search: { origin, destination, departureDate, returnDate: returnDate || null, adults, cabinClass, currency }, optionCount: options.length, priceInsights: data.price_insights || null, options, ...(includeRaw ? { raw: data } : {}) };
}
