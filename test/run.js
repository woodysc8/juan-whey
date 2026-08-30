import assert from "node:assert/strict";
import { calculateTotals } from "../src/calc/totals.js";
import { calculatePTO } from "../src/calc/pto.js";
import { calculateRewards } from "../src/calc/rewards.js";
import { updateProfile, getProfile, replaceProfile, recordProfileFact, updateTrip, getTrip, resetTrip } from "../src/storage/store.js";
import { emptyTripIntent, extractTripIntent, clearTripIntent } from "../src/tripIntent.js";
import { searchFlights as searchLetsFg, normalizeLetsFgOption } from "../src/providers/flights/letsfg.js";
import { searchFlightsWithProvider, compareFlightProviders } from "../src/providers/flights/index.js";
import { generateDestinationCandidates } from "../src/research/destinationCandidates.js";
import { researchTripOptions } from "../src/research/tripResearch.js";
import { estimateTripEconomics, compareTripEconomics } from "../src/research/tripEconomics.js";
import { searchHotels as searchStayingApiHotels, normalizeStayingApiHotel } from "../src/providers/hotels/stayingapi.js";
import { compareHotels } from "../src/research/hotelComparison.js";
import { recommendTripOptions } from "../src/research/tripDecision.js";
import { searchAirports } from "../src/tools/airports.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
    passed++;
  } catch (e) {
    console.error(`FAIL  - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}
async function atest(name, fn) {
  try {
    await fn();
    console.log(`  ok  - ${name}`);
    passed++;
  } catch (e) {
    console.error(`FAIL  - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const originalProfile = await getProfile();
const originalEnv = Object.fromEntries(["LETSFG_BEARER_TOKEN", "SERPAPI_API_KEY", "STAYINGAPI_KEY", "STAYINGAPI_TIMEOUT_MS", "MAX_DESTINATION_CANDIDATES", "MAX_FLIGHT_PROVIDERS_PER_DESTINATION", "MAX_HOTEL_PROPERTIES"].map((key) => [key, process.env[key]]));
function response(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
const letsFgOffer = { id: "off_test", price: 499, currency: "USD", airlines: ["Test Air"], outbound: { stopovers: 0, total_duration_seconds: 7200, segments: [{ airline: "Test Air", flight_no: "TA101", origin: "PVD", destination: "MIA", departure: "2026-11-19T08:00:00", arrival: "2026-11-19T10:00:00", duration_seconds: 7200 }] }, conditions: { refund_before_departure: "allowed_with_fee" } };

console.log("searchAirports");
await atest("airport autocomplete uses the existing SerpApi Google Flights provider, not Amadeus", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  const originalFetch = global.fetch;
  let requestedUrl;
  global.fetch = async (url) => {
    requestedUrl = new URL(url);
    return response(200, {
      suggestions: [{
        name: "Miami, FL, USA", type: "city", airports: [
          { name: "Miami International Airport", id: "MIA", city: "Miami" },
          { name: "Miami International Airport duplicate", id: "MIA", city: "Miami" },
        ],
      }],
    });
  };
  try {
    const result = await searchAirports({ keyword: "Miami" });
    assert.equal(requestedUrl.searchParams.get("engine"), "google_flights_autocomplete");
    assert.equal(requestedUrl.searchParams.get("q"), "Miami");
    assert.deepEqual(result, { query: "Miami", results: [{ name: "Miami International Airport", iataCode: "MIA", type: "AIRPORT", cityName: "Miami", countryName: null }] });
  } finally {
    global.fetch = originalFetch;
  }
});

console.log("calculateTotals");
test("gross/friendsOwe/eventual split (brief example: $1600 trip, friends owe $800)", () => {
  const r = calculateTotals({
    items: [{ label: "Airbnb", amount: 1000 }, { label: "Groceries", amount: 600 }],
    splits: [{ name: "Friend A", amountOwed: 400 }, { name: "Friend B", amountOwed: 400 }],
  });
  assert.equal(r.gross, 1600);
  assert.equal(r.senorUpfront, 1600);
  assert.equal(r.friendsOwe, 800);
  assert.equal(r.senorEventual, 800);
});
test("solo trip, no splits -> eventual == gross", () => {
  const r = calculateTotals({ items: [{ label: "Flight", amount: 300 }] });
  assert.equal(r.senorEventual, 300);
});
test("handles junk/missing amounts as 0 rather than throwing", () => {
  const r = calculateTotals({ items: [{ label: "Flight", amount: "oops" }, { label: "Hotel", amount: 200 }] });
  assert.equal(r.gross, 200);
});

console.log("calculatePTO");
test("weekday requires PTO, weekend does not", () => {
  const r = calculatePTO({
    candidateDates: [
      { date: "2026-11-19", note: "Thursday departure" }, // Thu
      { date: "2026-11-20", note: "Friday" }, // Fri
      { date: "2026-11-21", note: "Saturday" }, // Sat
    ],
  });
  assert.equal(r.ptoDaysRequired, 2);
  assert.equal(r.days.find((d) => d.date === "2026-11-21").requiresPTO, false);
});
test("holiday suppresses PTO requirement even on a weekday", () => {
  const r = calculatePTO({
    candidateDates: [{ date: "2026-11-26", note: "Thanksgiving" }], // Thursday
    holidays: ["2026-11-26"],
  });
  assert.equal(r.ptoDaysRequired, 0);
});

console.log("calculateRewards");
test("implied cents-per-point matches manual math", () => {
  const r = calculateRewards({ cashPrice: 400, pointsRequired: 20000, assumedPointValueCents: 1.5 });
  // 400 * 100 / 20000 = 2.0 cpp
  assert.equal(r.impliedCentsPerPoint, 2);
  assert.equal(r.goodDeal, true);
});
test("below baseline value flags as not a good deal", () => {
  const r = calculateRewards({ cashPrice: 100, pointsRequired: 20000, assumedPointValueCents: 1.5 });
  // 0.5 cpp < 1.5 cpp baseline
  assert.equal(r.goodDeal, false);
});
test("points shortfall computed when balance provided", () => {
  const r = calculateRewards({ cashPrice: 400, pointsRequired: 20000, assumedPointValueCents: 1.5, pointsAvailable: 12000 });
  assert.equal(r.pointsShortfall, 8000);
});

console.log("storage (data/ JSON files)");
await atest("profile round-trips through disk", async () => {
  const before = await getProfile();
  assert.ok(Array.isArray(before.recurringLocal));
  const updated = await updateProfile({ languages: ["English", "Spanish"] });
  assert.deepEqual(updated.languages, ["English", "Spanish"]);
  const reread = await getProfile();
  assert.deepEqual(reread.languages, ["English", "Spanish"]);
});
await atest("trip create/update/reset round-trips through disk", async () => {
  await resetTrip();
  assert.equal(await getTrip(), null);
  const created = await updateTrip({ destination: "Curacao", origin: "PVD", status: "planning" });
  assert.equal(created.destination, "Curacao");
  const updated = await updateTrip({ costSummary: { gross: 1600 } });
  assert.equal(updated.origin, "PVD"); // earlier fields preserved
  assert.equal(updated.costSummary.gross, 1600);
  await resetTrip();
  assert.equal(await getTrip(), null);
});

console.log("travel profile and Trip Intent");
await atest("structured Travel Profile loads and retains Señor", async () => {
  const profile = await getProfile();
  assert.equal(profile.identity.preferredAddress, "Señor");
  assert.equal(profile.identity.alwaysUsePreferredAddress, true);
  assert.ok(Array.isArray(profile.home.nearbyDeparturePoints));
});
await atest("explicit Travel Profile facts persist with source/confidence", async () => {
  const result = await recordProfileFact({ key: "languages.preference", value: "Spanish", source: "explicit_statement", confidence: "high" });
  assert.equal(result.fact.source, "explicit_statement");
  const reread = await getProfile();
  assert.ok(reread.facts.some((fact) => fact.key === "languages.preference" && fact.value === "Spanish"));
});
await atest("conflicting profile facts are preserved instead of silently overwritten", async () => {
  await recordProfileFact({ key: "transportation.redEyes", value: "avoid_when_practical", source: "explicit_statement" });
  const result = await recordProfileFact({ key: "transportation.redEyes", value: "acceptable_for_large_savings", source: "explicit_statement", context: "solo travel" });
  assert.ok(result.conflict);
  assert.equal(result.profile.facts.filter((fact) => fact.key === "transportation.redEyes").length, 2);
});
test("Trip-specific overnight-bus choice does not become a permanent preference", () => {
  const intent = extractTripIntent("I'll take an overnight bus this time because it's $120 cheaper.");
  assert.deepEqual(intent.transportation.acceptableModes, ["bus"]);
  assert.equal(intent.extraction.source.includes("this time"), true);
});
test("budget is modeled as a ceiling, not a target", () => {
  const intent = emptyTripIntent();
  assert.equal(intent.budget.meaning, "ceiling");
  assert.equal(intent.budget.specified, false);
});
test("companion contexts distinguish girlfriend, solo, and friends", () => {
  assert.equal(extractTripIntent("A vacation with my girlfriend").travelers.companionType, "girlfriend");
  assert.equal(extractTripIntent("I am traveling solo").travelers.companionType, "solo");
  assert.equal(extractTripIntent("A trip with friends").travelers.companionType, "friends");
});
test("red-eye and novelty preferences are soft preferences", () => {
  const profile = originalProfile;
  assert.equal(profile.transportationPreferences.redEyes, "avoid_when_practical_not_absolute");
  assert.equal(profile.destinationPreferences.prioritizeNew, "preference_not_requirement");
});
test("natural-language request extracts a conservative Trip Intent", () => {
  const intent = extractTripIntent("I'm thinking about going somewhere warm with my girlfriend for four days in late November.");
  assert.equal(intent.tripType, "vacation");
  assert.equal(intent.travelers.count, 2);
  assert.equal(intent.travelers.companionType, "girlfriend");
  assert.equal(intent.destination.weatherPreference, "warm");
  assert.equal(intent.dates.naturalLanguage, "late November");
  assert.equal(intent.duration.exactDays, 4);
  assert.equal(intent.safety.level, "elevated");
});
test("missing Trip Intent information remains unknown", () => {
  const intent = extractTripIntent("I need a trip.");
  assert.equal(intent.destination.value, null);
  assert.equal(intent.dates.departureDate, null);
  assert.equal(intent.travelers.count, null);
  assert.equal(intent.budget.specified, false);
});

console.log("flight providers and bounded research");
await atest("LetsFG reports a missing bearer token clearly", async () => {
  delete process.env.LETSFG_BEARER_TOKEN;
  await assert.rejects(() => searchLetsFg({ origin: "PVD", destination: "MIA", departureDate: "2026-11-19" }), /Missing LETSFG_BEARER_TOKEN/);
});
await atest("LetsFG constructs bearer auth without exposing it in results", async () => {
  process.env.LETSFG_BEARER_TOKEN = "test-secret-token";
  const calls = [];
  const result = await searchLetsFg({ origin: "PVD", destination: "MIA", departureDate: "2026-11-19", returnDate: "2026-11-22", adults: 2, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? response(200, { search_id: "search_test" }) : response(200, { status: "completed", offers: [letsFgOffer] });
  } });
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-secret-token");
  assert.equal(JSON.stringify(result).includes("test-secret-token"), false);
  assert.equal(result.optionCount, 1);
});
test("LetsFG response normalization preserves flight research fields", () => {
  const option = normalizeLetsFgOption(letsFgOffer, "USD", "search_test");
  assert.equal(option.price.total, 499);
  assert.deepEqual(option.flightNumbers, ["TA101"]);
  assert.equal(option.origin.code, "PVD");
  assert.equal(option.totalDurationMinutes, 120);
  assert.equal(option.booking.researchOnly, true);
});
await atest("provider registry selects SerpApi and LetsFG independently", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  process.env.LETSFG_BEARER_TOKEN = "lets-test";
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.startsWith("https://serpapi.com")) return response(200, { search_parameters: { currency: "USD" }, best_flights: [{ price: 300, flights: [{ airline: "Test Air", flight_number: "TA1", departure_airport: { id: "PVD", time: "2026-11-19 08:00" }, arrival_airport: { id: "MIA", time: "2026-11-19 11:00" }, duration: 180 }] }] });
    if (url.endsWith("/api/search")) return response(200, { search_id: "search_test" });
    return response(200, { status: "completed", offers: [letsFgOffer] });
  };
  try {
    assert.equal((await searchFlightsWithProvider("serpapi", { origin: "PVD", destination: "MIA", departureDate: "2026-11-19" })).provider, "serpapi");
    assert.equal((await searchFlightsWithProvider("letsfg", { origin: "PVD", destination: "MIA", departureDate: "2026-11-19" })).provider, "letsfg");
  } finally { global.fetch = originalFetch; }
});
await atest("provider comparison retains a successful provider when the other fails", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  process.env.LETSFG_BEARER_TOKEN = "lets-test";
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url.startsWith("https://serpapi.com")) return response(500, { error: "mock failure" });
    if (url.endsWith("/api/search")) return response(200, { search_id: "search_test" });
    return response(200, { status: "completed", offers: [letsFgOffer] });
  };
  try {
    const results = await compareFlightProviders({ origin: "PVD", destination: "MIA", departureDate: "2026-11-19" });
    assert.equal(results.find((entry) => entry.provider === "serpapi").ok, false);
    assert.equal(results.find((entry) => entry.provider === "letsfg").ok, true);
  } finally { global.fetch = originalFetch; }
});
await atest("destination candidates use open-ended Trip Intent and Travel Profile context", async () => {
  const profile = await getProfile();
  const candidates = generateDestinationCandidates(extractTripIntent("Somewhere warm with my girlfriend"), profile, 3);
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((candidate) => candidate.flightSearchReady && candidate.novelty));
  assert.ok(candidates[0].rationale.includes("Couple context"));
});
await atest("research budget bounds live provider calls and unknown dates are not invented", async () => {
  process.env.SERPAPI_API_KEY = "serp-test";
  process.env.MAX_DESTINATION_CANDIDATES = "2";
  process.env.MAX_FLIGHT_PROVIDERS_PER_DESTINATION = "1";
  const originalFetch = global.fetch; let calls = 0; const urls = [];
  global.fetch = async (url) => { calls++; urls.push(url); return response(200, { search_parameters: { currency: "USD" }, best_flights: [{ price: 300, flights: [{ airline: "Test Air", flight_number: "TA1", departure_airport: { id: "PVD", time: "2026-11-19 08:00" }, arrival_airport: { id: "MIA", time: "2026-11-19 11:00" }, duration: 180 }] }] }); };
  try {
    const datedIntent = { ...extractTripIntent("Somewhere warm"), dates: { departureDate: "2026-11-19", returnDate: "2026-11-22" } };
    const researched = await researchTripOptions({ intent: datedIntent, providers: ["serpapi"] });
    assert.equal(researched.flightResearch.length, 2);
    assert.equal(calls, 2);
    assert.equal(researched.bookingAttempted, false);
    assert.ok(urls.every((url) => !url.includes("book") && !url.includes("order")));
    const undated = await researchTripOptions({ request: "Somewhere warm with my girlfriend" });
    assert.equal(undated.needsDateClarification, true);
    assert.equal(calls, 2);
  } finally { global.fetch = originalFetch; }
});

console.log("trip economics");
const economicsIntent = { ...emptyTripIntent(), dates: { departureDate: "2026-11-19", returnDate: "2026-11-21" }, travelers: { count: 2, companionType: "girlfriend", context: "couple" } };
const economicsFlight = { provider: "serpapi", price: { total: 801, currency: "USD" }, totalDurationMinutes: 325, stops: 1, layovers: [] };
await atest("Trip Economics calculates a transparent total with observed flights", async () => {
  const economics = await estimateTripEconomics({ tripOption: economicsFlight, intent: economicsIntent, estimates: { lodgingNightlyEstimate: 140, foodDailyEstimate: 45, activitiesDailyEstimate: 20, localTransportDailyEstimate: 15, otherEstimate: 0 } });
  assert.equal(economics.status, "ready");
  assert.equal(economics.components.flights.amount, 801);
  assert.equal(economics.components.flights.status, "observed");
  assert.equal(economics.components.lodging.amount, 280);
  assert.equal(economics.components.lodging.status, "estimated");
  assert.equal(economics.totalTripCost, 1321);
  assert.equal(economics.total.status, "estimated");
});
await atest("Trip Economics separates total cost from user cost with explicit sharing", async () => {
  const economics = await estimateTripEconomics({ tripOption: economicsFlight, intent: economicsIntent, estimates: { lodgingNightlyEstimate: 140, foodDailyEstimate: 45, activitiesDailyEstimate: 20, localTransportDailyEstimate: 15, otherEstimate: 0 }, sharedCosts: [{ name: "Companion", amountOwed: 500, component: "lodging" }] });
  assert.equal(economics.totalTripCost, 1321);
  assert.equal(economics.reimbursementTotal, 500);
  assert.equal(economics.estimatedUserCost, 821);
  assert.equal(economics.sharedCosts[0].status, "user_provided");
});
await atest("Trip Economics does not invent nights or a full total", async () => {
  const economics = await estimateTripEconomics({ tripOption: economicsFlight, intent: emptyTripIntent(), estimates: { lodgingNightlyEstimate: 140 } });
  assert.equal(economics.status, "needs_clarification");
  assert.equal(economics.duration.nights, null);
  assert.equal(economics.totalTripCost, null);
  assert.ok(economics.missing.includes("exact travel dates, nights, or exact trip duration"));
});
await atest("Trip Economics comparison reports cost deltas without a score", async () => {
  const a = await estimateTripEconomics({ tripOption: economicsFlight, intent: economicsIntent, estimates: { lodgingNightlyEstimate: 100, foodDailyEstimate: 20, activitiesDailyEstimate: 0, localTransportDailyEstimate: 0, otherEstimate: 0 } });
  const b = await estimateTripEconomics({ tripOption: { ...economicsFlight, totalDurationMinutes: 200, stops: 0, price: { total: 900, currency: "USD" } }, intent: economicsIntent, estimates: { lodgingNightlyEstimate: 100, foodDailyEstimate: 20, activitiesDailyEstimate: 0, localTransportDailyEstimate: 0, otherEstimate: 0 } });
  const comparison = compareTripEconomics([{ label: "A", economics: a, tripOption: economicsFlight }, { label: "B", economics: b, tripOption: { ...economicsFlight, totalDurationMinutes: 200, stops: 0 } }]);
  assert.equal(comparison.lowestKnownTotal.label, "A");
  assert.equal(comparison.options.find((option) => option.label === "B").costDifferenceFromLowest, 99);
  assert.equal(comparison.options.find((option) => option.label === "B").convenience.stops, 0);
});

console.log("hotel provider and observed lodging");
const stayingProperty = { id: "hotel_1", name: "Test Hotel", address: "1 Test Way", coordinates: { lat: 18.4, lng: -66.1 }, starRating: 4, reviewScore: 8.7, roomType: "Private room", price: { nightly: 140, total: 420, currency: "USD", taxes: 45 }, cancellation: { refundable: true, deadline: "2026-11-17T23:59:00", description: "Free cancellation" }, amenities: ["WiFi", "Pool"], url: "https://example.test/hotel" };
test("hotel normalization preserves an observed total stay price and cancellation", () => {
  const hotel = normalizeStayingApiHotel(stayingProperty, { destination: "San Juan", currency: "USD" });
  assert.equal(hotel.totalPrice, 420);
  assert.equal(hotel.nightlyPrice, 140);
  assert.equal(hotel.priceStatus, "observed");
  assert.equal(hotel.cancellation.refundable, true);
  assert.equal(hotel.cancellation.description, "Free cancellation");
});
await atest("hotel search handles missing dates and credentials safely", async () => {
  delete process.env.STAYINGAPI_KEY;
  const missingDates = await searchStayingApiHotels({ destination: "San Juan" });
  assert.deepEqual(missingDates.missing, ["exact_check_in", "exact_check_out"]);
  await assert.rejects(() => searchStayingApiHotels({ destination: "San Juan", checkIn: "2026-11-19", checkOut: "2026-11-22" }), /Missing STAYINGAPI_KEY/);
});
await atest("StayingAPI accepts an immediate completed hotel response without booking", async () => {
  process.env.STAYINGAPI_KEY = "stay-test-secret"; const calls = [];
  const successful = await searchStayingApiHotels({ destination: "San Juan", checkIn: "2026-11-19", checkOut: "2026-11-22", guests: 2, fetchImpl: async (url, options) => { calls.push({ url, options }); return response(200, { data: [stayingProperty] }); } });
  assert.equal(successful.optionCount, 1);
  assert.equal(successful.options[0].totalPrice, 420);
  assert.equal(calls[0].options.headers.Authorization, "Bearer stay-test-secret");
  assert.ok(calls.every((call) => !call.url.includes("book") && !call.url.includes("payment") && !call.url.includes("reserve")));
});
await atest("StayingAPI polls a relative job URL through running to completed", async () => {
  process.env.STAYINGAPI_KEY = "stay-test-secret";
  const calls = [];
  const bodies = [
    response(202, { data: { jobId: "job_test", pollUrl: "/v1/jobs/job_test", status: "queued", pollAfterMs: 250 } }),
    response(200, { data: { jobId: "job_test", pollUrl: "/v1/jobs/job_test", status: "running", pollAfterMs: 250 } }),
    response(200, { data: [stayingProperty], status: "completed" }),
  ];
  const result = await searchStayingApiHotels({ destination: "Miami", checkIn: "2026-11-19", checkOut: "2026-11-22", guests: 2, rooms: 1, fetchImpl: async (url, options) => { calls.push({ url, options }); return bodies.shift(); }, sleepImpl: async () => {}, now: () => 0 });
  assert.equal(result.optionCount, 1);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.startsWith("https://api.stayingapi.com/v1/search?"));
  assert.equal(calls[1].url, "https://api.stayingapi.com/v1/jobs/job_test");
  assert.equal(calls[2].url, "https://api.stayingapi.com/v1/jobs/job_test");
  assert.equal(JSON.stringify(result).includes("stay-test-secret"), false);
});
await atest("StayingAPI reports terminal job failure and authentication failure", async () => {
  process.env.STAYINGAPI_KEY = "stay-test-secret";
  const terminalBodies = [response(202, { data: { jobId: "job_fail", pollUrl: "/v1/jobs/job_fail", status: "queued" } }), response(200, { data: { status: "failed", message: "no availability" } })];
  await assert.rejects(() => searchStayingApiHotels({ destination: "Miami", checkIn: "2026-11-19", checkOut: "2026-11-22", fetchImpl: async () => terminalBodies.shift(), sleepImpl: async () => {}, now: (() => { let calls = 0; return () => calls++ === 0 ? 0 : 1; })() }), /no availability/);
  await assert.rejects(() => searchStayingApiHotels({ destination: "Miami", checkIn: "2026-11-19", checkOut: "2026-11-22", fetchImpl: async () => response(401, { error: "unauthorized" }) }), /StayingAPI hotel search failed \(401\)/);
});
await atest("StayingAPI rejects malformed jobs, malformed completed results, and polling timeouts", async () => {
  process.env.STAYINGAPI_KEY = "stay-test-secret";
  await assert.rejects(() => searchStayingApiHotels({ destination: "Miami", checkIn: "2026-11-19", checkOut: "2026-11-22", fetchImpl: async () => response(202, { data: { jobId: "job_missing_url", status: "queued" } }) }), /malformed asynchronous job descriptor/);
  await assert.rejects(() => searchStayingApiHotels({ destination: "Miami", checkIn: "2026-11-19", checkOut: "2026-11-22", fetchImpl: async () => response(200, { data: { status: "completed" } }) }), /malformed completed hotel results/);
  process.env.STAYINGAPI_TIMEOUT_MS = "5";
  const timeoutBodies = [response(202, { data: { jobId: "job_slow", pollUrl: "/v1/jobs/job_slow", status: "queued" } }), response(200, { data: { jobId: "job_slow", pollUrl: "/v1/jobs/job_slow", status: "running" } })];
  let clockCalls = 0;
  await assert.rejects(() => searchStayingApiHotels({ destination: "Miami", checkIn: "2026-11-19", checkOut: "2026-11-22", fetchImpl: async () => timeoutBodies.shift(), sleepImpl: async () => {}, now: () => clockCalls++ === 0 ? 0 : 10 }), /timed out after 5ms/);
  delete process.env.STAYINGAPI_TIMEOUT_MS;
});
await atest("StayingAPI HTTP failures are handled without booking", async () => {
  process.env.STAYINGAPI_KEY = "stay-test-secret";
  await assert.rejects(() => searchStayingApiHotels({ destination: "San Juan", checkIn: "2026-11-19", checkOut: "2026-11-22", fetchImpl: async () => response(503, { error: "upstream unavailable" }) }), /StayingAPI hotel search failed \(503\)/);
});
await atest("observed hotel total replaces lodging estimate in Trip Economics", async () => {
  const hotel = normalizeStayingApiHotel(stayingProperty, { destination: "San Juan", currency: "USD" });
  const economics = await estimateTripEconomics({ tripOption: economicsFlight, hotelOption: hotel, intent: economicsIntent, estimates: { lodgingNightlyEstimate: 999, foodDailyEstimate: 45, activitiesDailyEstimate: 20, localTransportDailyEstimate: 15, otherEstimate: 0 } });
  assert.equal(economics.components.lodging.amount, 420);
  assert.equal(economics.components.lodging.status, "observed");
  assert.equal(economics.components.lodging.source, "stayingapi");
  assert.equal(economics.totalTripCost, 1461);
  assert.equal(compareHotels([hotel]).options[0].cancellation.refundable, true);
});

console.log("trip decision engine");
const decisionIntent = { ...emptyTripIntent(), dates: { departureDate: "2026-11-19", returnDate: "2026-11-22" }, travelers: { count: 2, companionType: "girlfriend", context: "couple" }, budget: { maximumTotal: 800, meaning: "ceiling", specified: true }, novelty: { prioritizeNew: true, revisitAcceptable: true } };
const decisionProfile = { travelHistory: { visits: [{ country: "Visitedland" }] } };
function decisionOption({ id, total, userCost = total, duration, stops, departureTime, country, novelty, adventureFit = null, cancellation = null }) {
  return { id, label: id, candidate: { destination: `${id} City`, country, novelty, adventureFit }, flightOption: { id: `flight-${id}`, price: { total: 300, currency: "USD" }, totalDurationMinutes: duration, stops, departureTime, layovers: [] }, hotelOption: { name: `${id} Hotel`, totalPrice: 300, currency: "USD", priceStatus: "observed", cancellation: cancellation || { refundable: null, deadline: null, description: null }, taxesAndFees: null }, economics: { currency: "USD", totalTripCost: total, estimatedUserCost: userCost, reimbursementTotal: total - userCost, sharedCosts: total === userCost ? [] : [{ name: "Companion", amountOwed: total - userCost, status: "user_provided" }], components: { flights: { amount: 300, status: "observed" }, lodging: { amount: 300, status: "observed" } }, total: { status: "estimated" }, missing: [] } };
}
const cheapRedEye = decisionOption({ id: "Cheap", total: 600, duration: 500, stops: 1, departureTime: "2026-11-19T02:00:00", country: "Visitedland", novelty: "visited_before" });
const comfortableNew = decisionOption({ id: "Comfortable", total: 700, userCost: 450, duration: 200, stops: 0, departureTime: "2026-11-19T10:00:00", country: "Newland", novelty: "new", adventureFit: "beaches and adventure" });
await atest("Trip Decision distinguishes cheapest from girlfriend best overall and explains both", async () => {
  const result = await recommendTripOptions({ options: [cheapRedEye, comfortableNew], intent: decisionIntent, profile: decisionProfile });
  assert.equal(result.status, "ready");
  assert.equal(result.recommendations.find((entry) => entry.role === "cheapest").optionId, "Cheap");
  assert.equal(result.recommendations.find((entry) => entry.role === "best_overall").optionId, "Comfortable");
  assert.ok(result.recommendations.every((entry) => entry.whyItFits.length > 0 && Array.isArray(entry.givesUpVersusCheapest)));
});
await atest("Trip Decision allows a solo trip to favor meaningful savings over inconvenience", async () => {
  const soloIntent = { ...decisionIntent, travelers: { count: 1, companionType: "solo", context: null } };
  const soloComfortable = { ...comfortableNew, economics: { ...comfortableNew.economics, estimatedUserCost: 700, reimbursementTotal: 0, sharedCosts: [] } };
  const result = await recommendTripOptions({ options: [cheapRedEye, soloComfortable], intent: soloIntent, profile: decisionProfile });
  assert.equal(result.recommendations.find((entry) => entry.role === "best_overall").optionId, "Cheap");
});
await atest("Trip Decision enforces the hard budget ceiling and retains cost sharing", async () => {
  const result = await recommendTripOptions({ options: [cheapRedEye, comfortableNew], intent: { ...decisionIntent, budget: { maximumTotal: 650, meaning: "ceiling", specified: true } }, profile: decisionProfile });
  assert.equal(result.recommendations[0].optionId, "Cheap");
  assert.equal(result.excludedOptions[0].optionId, "Comfortable");
  const shared = await recommendTripOptions({ options: [comfortableNew], intent: decisionIntent, profile: decisionProfile });
  assert.equal(shared.recommendations[0].costs.totalTripCost, 700);
  assert.equal(shared.recommendations[0].costs.estimatedUserCost, 450);
  assert.equal(shared.recommendations[0].costs.reimbursementTotal, 250);
});
await atest("Trip Decision marks revisits, unknown facts, missing dates, and no viable options explicitly", async () => {
  const ready = await recommendTripOptions({ options: [cheapRedEye], intent: decisionIntent, profile: decisionProfile });
  assert.equal(ready.recommendations[0].novelty, "revisit");
  assert.ok(ready.recommendations[0].unknowns.includes("destination-specific safety information"));
  const missingDates = await recommendTripOptions({ options: [cheapRedEye], intent: emptyTripIntent(), profile: decisionProfile });
  assert.equal(missingDates.status, "needs_clarification");
  const noViable = await recommendTripOptions({ options: [cheapRedEye], intent: { ...decisionIntent, budget: { maximumTotal: 500, meaning: "ceiling", specified: true } }, profile: decisionProfile });
  assert.equal(noViable.status, "no_viable_options");
});
await atest("Trip Decision bounds recommendations to five and does not fabricate safety or hotel terms", async () => {
  const options = Array.from({ length: 8 }, (_, index) => decisionOption({ id: `Option ${index}`, total: 600 + index, duration: 200 + index, stops: 0, departureTime: "2026-11-19T10:00:00", country: `Country ${index}`, novelty: "new", adventureFit: index === 7 ? "adventure" : null }));
  const result = await recommendTripOptions({ options, intent: decisionIntent, profile: decisionProfile });
  assert.ok(result.recommendations.length <= 5);
  assert.ok(result.recommendations.every((entry) => entry.safety.status === "unknown"));
  assert.ok(result.recommendations.every((entry) => entry.hotel.cancellation.refundable === null));
});

await replaceProfile(originalProfile);
clearTripIntent();
for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }

console.log(`\n${passed} test(s) passed.`);
