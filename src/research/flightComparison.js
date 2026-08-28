import { compareFlightProviders } from "../providers/flights/index.js";

function signature(option) {
  return [option.origin?.code, option.destination?.code, option.departureTime, option.arrivalTime, ...(option.flightNumbers || [])].filter(Boolean).join("|");
}
function cheapest(result) { return result.options?.reduce((best, option) => !best || option.price.total < best.price.total ? option : best, null) || null; }

export async function compareFlights(input, providers = ["serpapi", "letsfg"]) {
  const providerResults = await compareFlightProviders(input, providers);
  const successful = providerResults.filter((entry) => entry.ok);
  const equivalent = new Map();
  for (const entry of successful) for (const option of entry.result.options) {
    const key = signature(option);
    if (!equivalent.has(key)) equivalent.set(key, []);
    equivalent.get(key).push({ provider: entry.provider, optionId: option.id, price: option.price });
  }
  const cheapestByProvider = Object.fromEntries(successful.map((entry) => [entry.provider, cheapest(entry.result)]));
  const overallCheapest = Object.values(cheapestByProvider).filter(Boolean).reduce((best, option) => !best || option.price.total < best.price.total ? option : best, null);
  return {
    providers: providerResults,
    equivalentOptions: [...equivalent.entries()].filter(([, matches]) => matches.length > 1).map(([signature, matches]) => ({ signature, matches })),
    cheapestByProvider,
    overallCheapest,
    providerUsefulness: successful.map((entry) => ({ provider: entry.provider, normalizedOptions: entry.optionCount, status: "available" })),
  };
}
