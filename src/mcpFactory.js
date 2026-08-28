import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { searchAirports } from "./tools/airports.js";
import { searchFlights, searchCheapestDates } from "./tools/flights.js";
import { searchHotels } from "./tools/hotels.js";
import { searchActivities } from "./tools/activities.js";
import { getExchangeRate } from "./tools/fx.js";
import { calculateTotals } from "./calc/totals.js";
import { calculatePTO } from "./calc/pto.js";
import { calculateRewards } from "./calc/rewards.js";
import { getProfile, updateProfile, recordProfileFact, getTrip, updateTrip, resetTrip } from "./storage/store.js";
import { getTripIntent, setTripIntent, extractAndSetTripIntent, clearTripIntent, saveTripIntent } from "./tripIntent.js";
import { compareFlights } from "./research/flightComparison.js";
import { researchTripOptions } from "./research/tripResearch.js";
import { estimateTripEconomics, compareTripEconomics } from "./research/tripEconomics.js";
import { compareHotels } from "./research/hotelComparison.js";
import { recommendTripOptions } from "./research/tripDecision.js";

export function createJuanMcpServer() {
const server = new McpServer({
  name: "juan-whey",
  version: "1.0.0",
  title: "Juan Whey — Travel Research Toolbelt",
});

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(err) {
  return {
    content: [{ type: "text", text: `Error: ${err.message || String(err)}` }],
    isError: true,
  };
}
function wrap(fn) {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

// ---------- research tools ----------

server.registerTool(
  "search_airports",
  {
    title: "Search airports/cities",
    description:
      "Resolve a free-text place name (e.g. 'Curacao', 'Providence') to IATA airport/city codes. Needed before search_flights or search_hotels, which require IATA codes.",
    inputSchema: {
      keyword: z.string().describe("Free-text place name to resolve"),
    },
  },
  wrap(searchAirports)
);

server.registerTool(
  "search_flights",
  {
    title: "Search flights",
    description:
      "Provider-neutral real flight research for a specific route/date(s). The active provider is selected with FLIGHT_PROVIDER. Returns normalized flight options; it never books travel.",
    inputSchema: {
      origin: z.string().describe("Origin IATA code, e.g. PVD"),
      destination: z.string().describe("Destination IATA code"),
      departureDate: z.string().describe("YYYY-MM-DD"),
      returnDate: z.string().optional().describe("YYYY-MM-DD, omit for one-way"),
      adults: z.number().int().min(1).default(1),
      cabinClass: z.enum(["economy", "premium_economy", "business", "first"]).default("economy"),
      nonStop: z.boolean().default(false),
      currencyCode: z.string().default("USD"),
      max: z.number().int().min(1).max(50).default(10),
      includeRaw: z.boolean().default(false).describe("Include raw provider response for diagnostics"),
    },
  },
  wrap(searchFlights)
);

server.registerTool(
  "search_cheapest_dates",
  {
    title: "Scan cheapest flight dates",
    description:
      "Scans a date range for the cheapest departure dates on a route, e.g. all of November. Cheaper than pricing every date individually with search_flights.",
    inputSchema: {
      origin: z.string(),
      destination: z.string(),
      departureDate: z
        .string()
        .describe("Single date 'YYYY-MM-DD' or range 'YYYY-MM-DD,YYYY-MM-DD'"),
    },
  },
  wrap(searchCheapestDates)
);

server.registerTool(
  "compare_flight_providers",
  {
    title: "Compare flight research providers",
    description: "Research-only comparison of normalized results from independently selected flight providers. Provider failures are reported without preventing other providers' results.",
    inputSchema: {
      origin: z.string(), destination: z.string(), departureDate: z.string(), returnDate: z.string().optional(), adults: z.number().int().min(1).default(1),
      providers: z.array(z.enum(["serpapi", "letsfg"])).max(2).default(["serpapi", "letsfg"]),
    },
  },
  wrap(async ({ providers, ...input }) => compareFlights(input, providers))
);

server.registerTool(
  "search_hotels",
  {
    title: "Search hotels",
    description:
      "Provider-neutral, research-only hotel search. Requires exact check-in/check-out dates and never books or reserves a stay.",
    inputSchema: {
      destination: z.string().describe("Destination/city, e.g. San Juan, Puerto Rico"),
      checkIn: z.string().describe("YYYY-MM-DD"),
      checkOut: z.string().describe("YYYY-MM-DD"),
      guests: z.number().int().min(1).default(1),
      rooms: z.number().int().min(1).default(1),
      currency: z.string().default("USD"),
      max: z.number().int().min(1).max(10).default(5),
      includeRaw: z.boolean().default(false),
    },
  },
  wrap(searchHotels)
);

server.registerTool(
  "compare_hotels",
  {
    title: "Compare hotel research options",
    description: "Present normalized hotel facts—total stay price, ratings, room type, cancellation, and source—without assigning a score or booking anything.",
    inputSchema: { hotels: z.array(z.record(z.unknown())).min(1) },
  },
  wrap(async ({ hotels }) => compareHotels(hotels))
);

server.registerTool(
  "search_activities",
  {
    title: "Search activities",
    description:
      "Bookable tours/activities near a lat/lng, with real prices where available, via Amadeus.",
    inputSchema: {
      latitude: z.number(),
      longitude: z.number(),
      radius: z.number().min(1).max(20).default(5).describe("Search radius in km"),
    },
  },
  wrap(searchActivities)
);

server.registerTool(
  "get_exchange_rate",
  {
    title: "Get currency exchange rate",
    description:
      "Current exchange rate (ECB reference rates via Frankfurter, free/no-key) and, optionally, a converted amount.",
    inputSchema: {
      base: z.string().default("USD"),
      target: z.string().describe("Target currency code, e.g. EUR"),
      amount: z.number().optional().describe("Amount in base currency to convert"),
    },
  },
  wrap(getExchangeRate)
);

// ---------- deterministic math (no external calls at all) ----------

server.registerTool(
  "calculate_totals",
  {
    title: "Calculate trip cost totals",
    description:
      "Deterministically compute gross trip cost, what Senor fronts upfront, what others owe him back, and his eventual personal cost. Always use this instead of doing the arithmetic by hand.",
    inputSchema: {
      items: z
        .array(z.object({ label: z.string(), amount: z.number() }))
        .describe("All trip expense line items"),
      splits: z
        .array(z.object({ name: z.string(), amountOwed: z.number() }))
        .default([])
        .describe("What each other traveler owes Senor back"),
      currency: z.string().default("USD"),
    },
  },
  wrap(async (args) => calculateTotals(args))
);

server.registerTool(
  "calculate_pto",
  {
    title: "Calculate PTO days required",
    description:
      "Deterministically classifies candidate travel dates as weekend/holiday (free) vs. workday (requires PTO). Pass every weekday the trip occupies as a candidate date.",
    inputSchema: {
      candidateDates: z
        .array(z.object({ date: z.string().describe("YYYY-MM-DD"), note: z.string().optional() }))
        .describe("Weekdays the trip would occupy"),
      holidays: z.array(z.string()).default([]).describe("YYYY-MM-DD list of observed holidays"),
    },
  },
  wrap(async (args) => calculatePTO(args))
);

server.registerTool(
  "calculate_rewards",
  {
    title: "Calculate points redemption value",
    description:
      "Deterministically computes the implied cents-per-point value of a redemption against a researched baseline point value, and any points shortfall. Look up the current baseline value yourself first -- this tool does not know current Bilt (or any) program rules.",
    inputSchema: {
      cashPrice: z.number(),
      pointsRequired: z.number(),
      assumedPointValueCents: z
        .number()
        .describe("Baseline cents-per-point value from current research"),
      pointsAvailable: z.number().optional(),
    },
  },
  wrap(async (args) => calculateRewards(args))
);

server.registerTool(
  "estimate_trip_cost",
  {
    title: "Estimate trip cash cost",
    description: "Research-only cash-cost model. Uses an observed normalized flight option when supplied and clearly labels user-provided, estimated, and unknown components. It never searches, books, or purchases.",
    inputSchema: {
      tripOption: z.record(z.unknown()).optional().describe("Normalized flight option from existing flight research"),
      hotelOption: z.record(z.unknown()).optional().describe("Normalized hotel option with an observed total stay price"),
      intent: z.record(z.unknown()).optional().describe("Trip Intent; defaults to the active session intent"),
      currency: z.string().default("USD"),
      nights: z.number().int().min(1).optional().describe("Explicit nights when dates/duration do not provide them"),
      estimates: z.object({ lodgingNightlyEstimate: z.number().nonnegative().optional(), foodDailyEstimate: z.number().nonnegative().optional(), activitiesDailyEstimate: z.number().nonnegative().optional(), localTransportDailyEstimate: z.number().nonnegative().optional(), otherEstimate: z.number().nonnegative().optional() }).default({}),
      userProvided: z.object({ flights: z.number().nonnegative().optional(), lodging: z.number().nonnegative().optional(), food: z.number().nonnegative().optional(), activities: z.number().nonnegative().optional(), localTransportation: z.number().nonnegative().optional(), other: z.number().nonnegative().optional() }).default({}),
      sharedCosts: z.array(z.object({ name: z.string().optional(), amountOwed: z.number().nonnegative(), component: z.string().optional() })).default([]),
    },
  },
  wrap(async (args) => estimateTripEconomics(args))
);

server.registerTool(
  "compare_trip_costs",
  {
    title: "Compare estimated trip cash costs",
    description: "Compare supplied Trip Economics results by known total and estimated user cost, with duration/stops where available. It does not score or recommend options.",
    inputSchema: { options: z.array(z.object({ label: z.string().optional(), economics: z.record(z.unknown()), tripOption: z.record(z.unknown()).optional() })).min(1) },
  },
  wrap(async ({ options }) => compareTripEconomics(options))
);

server.registerTool(
  "recommend_trip_options",
  {
    title: "Recommend researched trip options",
    description: "Research-only, evidence-bound trip decision brief. Consumes existing Trip Economics and normalized flight/hotel options; applies a stated budget as a ceiling, explains tradeoffs and unknowns, and never books or purchases.",
    inputSchema: {
      options: z.array(z.record(z.unknown())).default([]).describe("Researched trip options containing Trip Economics plus optional normalized flight/hotel/candidate data"),
      intent: z.record(z.unknown()).optional().describe("Trip Intent; defaults to the active temporary session intent"),
      profile: z.record(z.unknown()).optional().describe("Travel Profile override; defaults to Señor's persistent profile"),
      constraints: z.object({ maximumTotal: z.number().nonnegative().optional(), maximumTotalBudget: z.number().nonnegative().optional() }).default({}).describe("Optional explicit ceiling override; this is never treated as a spending target"),
    },
  },
  wrap(recommendTripOptions)
);

// ---------- persistent state ----------

server.registerTool(
  "get_traveler_profile",
  {
    title: "Get traveler profile",
    description: "Fetch Señor's persistent, structured traveler profile: general preferences, travel history, recurring local travel, and sourced facts.",
    inputSchema: {},
  },
  wrap(async () => getProfile())
);

server.registerTool(
  "update_traveler_profile",
  {
    title: "Update traveler profile",
    description:
      "Persist a LASTING fact/preference about Señor. Do not call this for one-off statements that only apply to the current trip; use Trip Intent instead.",
    inputSchema: {
      languages: z.array(z.string()).optional(),
      travelHistory: z
        .array(
          z.object({
            destination: z.string(),
            country: z.string().optional(),
            year: z.string().optional(),
            tripType: z.string().optional(),
            notes: z.string().optional(),
          })
        )
        .optional(),
      learnedPreferences: z
        .array(z.object({ text: z.string(), scope: z.enum(["one-off", "general"]) }))
        .optional(),
      hardConstraints: z.array(z.string()).optional(),
      recurringLocal: z
        .array(z.object({ destination: z.string(), host: z.string().optional(), notes: z.string().optional() }))
        .optional(),
      biltNotes: z.string().optional(),
    },
  },
  wrap(async (patch) => updateProfile(patch))
);

server.registerTool(
  "record_traveler_profile_fact",
  {
    title: "Record a sourced traveler-profile fact",
    description: "Record an explicit, lasting statement from Señor with confidence/source. Conflicting values are retained and flagged instead of silently overwriting older information. Never use for a single-trip decision.",
    inputSchema: {
      key: z.string().describe("Stable preference/fact key, e.g. transportation.overnightBusSolo"),
      value: z.unknown().describe("Structured value stated by Señor"),
      source: z.enum(["explicit_statement", "profile_setup", "user_correction"]).default("explicit_statement"),
      confidence: z.enum(["high", "medium", "low"]).default("high"),
      context: z.string().nullable().optional().describe("Context that qualifies the fact, if any"),
    },
  },
  wrap(async (fact) => recordProfileFact(fact))
);

// ---------- temporary Trip Intent (session state; saved only on request) ----------

server.registerTool(
  "extract_trip_intent",
  {
    title: "Extract Trip Intent from a request",
    description: "Conservatively extract a structured, temporary Trip Intent from Señor's request. Missing details remain null and this never modifies the permanent profile.",
    inputSchema: { request: z.string() },
  },
  wrap(async ({ request }) => extractAndSetTripIntent(request))
);

server.registerTool(
  "get_trip_intent",
  {
    title: "Get active Trip Intent",
    description: "Return the current session's temporary Trip Intent, or null if no request has been extracted/set.",
    inputSchema: {},
  },
  wrap(async () => getTripIntent())
);

server.registerTool(
  "set_trip_intent",
  {
    title: "Set active Trip Intent",
    description: "Replace the current session's Trip Intent with structured data. This does not save it permanently.",
    inputSchema: { intent: z.record(z.unknown()) },
  },
  wrap(async ({ intent }) => setTripIntent(intent))
);

server.registerTool(
  "clear_trip_intent",
  {
    title: "Clear active Trip Intent",
    description: "Clear the temporary Trip Intent without changing Señor's profile or saved trip state.",
    inputSchema: {},
  },
  wrap(async () => clearTripIntent())
);

server.registerTool(
  "save_trip_intent",
  {
    title: "Save active Trip Intent",
    description: "Explicitly save the current temporary Trip Intent into the existing persistent trip state.",
    inputSchema: {},
  },
  wrap(async () => saveTripIntent())
);

server.registerTool(
  "research_trip_options",
  {
    title: "Research destination and flight options",
    description: "Research-only: uses the structured profile and a temporary Trip Intent to shortlist a bounded set of destinations, then compares available flight providers only when exact dates are supplied. Never books or changes permanent preferences.",
    inputSchema: {
      request: z.string().optional().describe("Natural-language request; extracted conservatively without saving it"),
      intent: z.record(z.unknown()).optional().describe("Structured Trip Intent; takes precedence over request"),
      providers: z.array(z.enum(["serpapi", "letsfg"])).max(2).optional(),
    },
  },
  wrap(async (args) => researchTripOptions(args))
);

server.registerTool(
  "get_trip",
  {
    title: "Get current trip state",
    description: "Fetch the current trip's structured state, or null if none active.",
    inputSchema: {},
  },
  wrap(async () => (await getTrip()) ?? { status: "none" })
);

server.registerTool(
  "update_trip",
  {
    title: "Update current trip state",
    description:
      "Create or update the single current trip (route, dates, trip types, companions, constraints, cost breakdown, PTO, rewards notes, open questions, sources). Pass full arrays each time -- they replace, not append.",
    inputSchema: {
      status: z.enum(["discovery", "planning", "confirmed", "archived"]).optional(),
      tripTypes: z.array(z.string()).optional(),
      companions: z.string().optional().describe("solo | girlfriend | friends | family | work | mixed"),
      origin: z.string().optional(),
      destination: z.string().optional(),
      dateStart: z.string().optional(),
      dateEnd: z.string().optional(),
      hardConstraints: z.array(z.string()).optional(),
      preferences: z.array(z.string()).optional(),
      costBreakdown: z
        .object({
          flights: z.string().optional(),
          hotel: z.string().optional(),
          food: z.string().optional(),
          activities: z.string().optional(),
          localTransport: z.string().optional(),
          other: z.string().optional(),
        })
        .optional(),
      costSummary: z
        .object({
          gross: z.number().optional(),
          senorUpfront: z.number().optional(),
          friendsOwe: z.number().optional(),
          senorEventual: z.number().optional(),
        })
        .optional(),
      pto: z.object({ workdaysRequired: z.number().optional(), notes: z.string().optional() }).optional(),
      rewards: z.object({ notes: z.string().optional() }).optional(),
      sources: z.array(z.string()).optional(),
      openQuestions: z.array(z.string()).optional(),
    },
  },
  wrap(async (patch) => updateTrip(patch))
);

server.registerTool(
  "reset_trip",
  {
    title: "Reset current trip",
    description: "Clear the current trip state. Traveler profile is untouched.",
    inputSchema: {},
  },
  wrap(async () => ({ ok: true, trip: await resetTrip() }))
);


  return server;
}
