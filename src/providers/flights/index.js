import { searchFlights as searchAmadeusFlights, searchCheapestDates as searchAmadeusCheapestDates } from "./amadeus.js";
import { searchFlights as searchSerpApiFlights } from "./serpapi.js";
import { searchFlights as searchLetsFgFlights } from "./letsfg.js";

const providers = {
  amadeus: { searchFlights: searchAmadeusFlights, searchCheapestDates: searchAmadeusCheapestDates },
  serpapi: { searchFlights: searchSerpApiFlights },
  letsfg: { searchFlights: searchLetsFgFlights },
};

function activeProviderName() {
  return (process.env.FLIGHT_PROVIDER || "serpapi").trim().toLowerCase();
}

function activeProvider() {
  const name = activeProviderName();
  const provider = providers[name];
  if (!provider) throw new Error(`Unsupported FLIGHT_PROVIDER '${name}'. Available providers: ${Object.keys(providers).join(", ")}.`);
  return { name, provider };
}

/** Provider-neutral flight-search boundary. */
export async function searchFlights(input) {
  return activeProvider().provider.searchFlights(input);
}

export async function searchFlightsWithProvider(name, input) {
  const provider = providers[String(name).toLowerCase()];
  if (!provider) throw new Error(`Unsupported flight provider '${name}'. Available providers: ${Object.keys(providers).join(", ")}.`);
  return provider.searchFlights(input);
}

export async function compareFlightProviders(input, providerNames = ["serpapi", "letsfg"]) {
  const results = [];
  for (const provider of providerNames) {
    const startedAt = Date.now();
    try {
      const result = await searchFlightsWithProvider(provider, input);
      results.push({ provider, ok: true, durationMs: Date.now() - startedAt, optionCount: result.optionCount, result });
    } catch (error) {
      results.push({ provider, ok: false, durationMs: Date.now() - startedAt, optionCount: 0, error: error.message });
    }
  }
  return results;
}

export function availableFlightProviders() { return Object.keys(providers); }

export async function searchCheapestDates(input) {
  const { name, provider } = activeProvider();
  if (!provider.searchCheapestDates) throw new Error(`Flight provider '${name}' does not support cheapest-date searches.`);
  return provider.searchCheapestDates(input);
}

export function getActiveFlightProvider() {
  return activeProviderName();
}
