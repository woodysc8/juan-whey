const BASE_URL = "https://api.stayingapi.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 2_000;

function number(value) { const result = Number(value); return Number.isFinite(result) ? result : null; }
function coordinates(property) { return property.coordinates || property.location?.coordinates || {}; }
function price(property) { return property.price || property.pricing || {}; }

/** Convert unified accommodation data without treating a nightly rate as a stay total. */
export function normalizeStayingApiHotel(property, { destination, currency }) {
  const rates = price(property); const cancellationData = property.cancellation || property.cancellation_policy || rates.cancellation || {}; const location = coordinates(property);
  const totalPrice = number(property.totalPrice ?? property.total_price ?? rates.totalPrice ?? rates.total ?? rates.stayTotal);
  return {
    provider: "stayingapi", propertyId: String(property.id ?? property.propertyId ?? property.listingId ?? ""), name: property.name ?? property.title ?? null, destination,
    address: property.address ?? property.location?.address ?? null, latitude: number(location.lat ?? location.latitude), longitude: number(location.lng ?? location.longitude),
    rating: number(property.starRating ?? property.star_rating ?? property.rating), reviewScore: number(property.reviewScore ?? property.review_score ?? property.review?.score), roomType: property.roomType ?? property.room_type ?? null,
    nightlyPrice: number(property.nightlyPrice ?? property.nightly_price ?? rates.nightlyPrice ?? rates.perNight ?? rates.nightly), totalPrice, currency: property.currency ?? rates.currency ?? currency ?? null,
    taxesAndFees: number(property.taxesAndFees ?? property.taxes_and_fees ?? rates.taxesAndFees ?? rates.taxes),
    cancellation: { refundable: cancellationData.refundable ?? property.refundable ?? null, deadline: cancellationData.deadline ?? cancellationData.until ?? null, description: cancellationData.description ?? cancellationData.text ?? null },
    amenities: property.amenities || [], sourceUrl: property.url ?? property.sourceUrl ?? property.bookingUrl ?? null, priceStatus: totalPrice === null ? "unknown" : "observed",
  };
}

function propertiesFrom(body) {
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.properties)) return body.properties;
  if (Array.isArray(body?.data?.properties)) return body.data.properties;
  if (Array.isArray(body?.data?.results)) return body.data.results;
  if (Array.isArray(body?.data?.listings)) return body.data.listings;
  return null;
}
function jobFrom(body) {
  const data = body?.data;
  const jobId = data?.jobId ?? data?.job_id ?? body?.jobId ?? body?.job_id;
  const pollUrl = data?.pollUrl ?? data?.poll_url ?? body?.pollUrl ?? body?.poll_url;
  return jobId || pollUrl ? { jobId, pollUrl } : null;
}
function statusFrom(body) { return String(body?.data?.status ?? body?.status ?? "").toLowerCase(); }
function terminalFailure(status) { return ["failed", "error", "cancelled", "canceled", "expired"].includes(status); }
function terminalSuccess(status) { return ["completed", "complete", "succeeded", "success"].includes(status); }
function pollDelayMs(body, response, fallback) {
  const seconds = number(body?.data?.retryAfterSeconds ?? body?.data?.pollAfterSeconds ?? body?.meta?.retryAfterSeconds ?? response.headers?.get?.("retry-after"));
  const milliseconds = number(body?.data?.retryAfterMs ?? body?.data?.pollAfterMs ?? body?.meta?.retryAfterMs);
  const delay = milliseconds ?? (seconds === null ? fallback : seconds * 1000);
  return Math.max(250, Math.min(delay, 10_000));
}
function resolvePollUrl(pollUrl, baseUrl) {
  try {
    const resolved = new URL(pollUrl, baseUrl);
    const base = new URL(baseUrl);
    if (resolved.origin !== base.origin) throw new Error("poll URL has an unexpected origin");
    return resolved.toString();
  } catch { throw new Error("StayingAPI returned an invalid poll URL."); }
}
function message(body, fallback) { return body?.error || body?.message || body?.data?.error || body?.data?.message || fallback; }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function searchHotels({ destination, checkIn, checkOut, guests = 1, rooms = 1, currency = "USD", max = 5, includeRaw = false, fetchImpl = fetch, baseUrl = BASE_URL, pollIntervalMs = DEFAULT_POLL_MS, sleepImpl = wait, now = Date.now } = {}) {
  if (!checkIn || !checkOut) return { status: "needs_clarification", missing: ["exact_check_in", "exact_check_out"], provider: "stayingapi", options: [] };
  const token = process.env.STAYINGAPI_KEY;
  if (!token) throw new Error("Missing STAYINGAPI_KEY for the active StayingAPI hotel provider.");
  const query = new URLSearchParams({ location: destination, checkIn, checkOut, adults: String(guests), rooms: String(rooms), currency, limit: String(max) });
  const controller = new AbortController();
  const timeoutMs = Number(process.env.STAYINGAPI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Authorization: `Bearer ${token}` };
  try {
    let response = await fetchImpl(`${baseUrl}/search?${query}`, { headers, signal: controller.signal });
    let body = await response.json().catch(() => null);
    if (!response.ok && response.status !== 202) throw new Error(`StayingAPI hotel search failed (${response.status}): ${message(body, `HTTP ${response.status}`)}`);
    let properties = propertiesFrom(body);
    if (properties === null) {
      if (terminalSuccess(statusFrom(body))) throw new Error("StayingAPI returned malformed completed hotel results.");
      const job = jobFrom(body);
      if (!job?.jobId || !job.pollUrl) throw new Error("StayingAPI returned a malformed asynchronous job descriptor.");
      const pollUrl = resolvePollUrl(job.pollUrl, baseUrl);
      while (now() < deadline) {
        await sleepImpl(pollDelayMs(body, response, pollIntervalMs));
        response = await fetchImpl(pollUrl, { headers, signal: controller.signal });
        body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(`StayingAPI result polling failed (${response.status}): ${message(body, `HTTP ${response.status}`)}`);
        const status = statusFrom(body);
        if (terminalFailure(status)) throw new Error(`StayingAPI hotel search failed: ${message(body, `job ${status}`)}`);
        properties = propertiesFrom(body);
        if (properties !== null) break;
        if (terminalSuccess(status)) throw new Error("StayingAPI returned malformed completed hotel results.");
        if (!jobFrom(body) && status !== "running" && status !== "pending" && status !== "queued") throw new Error("StayingAPI returned malformed polling results.");
      }
      if (properties === null) throw new Error(`StayingAPI hotel search timed out after ${timeoutMs}ms.`);
    }
    if (!Array.isArray(properties)) throw new Error("StayingAPI returned malformed completed hotel results.");
    const options = properties.slice(0, max).map((property) => normalizeStayingApiHotel(property, { destination, currency }));
    return { status: "ready", provider: "stayingapi", source: "StayingAPI accommodation search", search: { destination, checkIn, checkOut, guests, rooms, currency }, optionCount: options.length, options, ...(includeRaw ? { raw: body } : {}) };
  } catch (error) { if (error.name === "AbortError") throw new Error(`StayingAPI hotel search timed out after ${timeoutMs}ms.`); throw error; }
  finally { clearTimeout(timeout); }
}
