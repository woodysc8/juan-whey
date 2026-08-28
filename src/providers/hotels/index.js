import { searchHotels as searchStayingApiHotels } from "./stayingapi.js";

const providers = { stayingapi: { searchHotels: searchStayingApiHotels } };
function activeProviderName() { return (process.env.HOTEL_PROVIDER || "stayingapi").trim().toLowerCase(); }
export function getActiveHotelProvider() { return activeProviderName(); }
export function isActiveHotelProviderConfigured() { return activeProviderName() === "stayingapi" && Boolean(process.env.STAYINGAPI_KEY); }
export async function searchHotels(input) {
  const name = activeProviderName(); const provider = providers[name];
  if (!provider) throw new Error(`Unsupported HOTEL_PROVIDER '${name}'. Available providers: ${Object.keys(providers).join(", ")}.`);
  return provider.searchHotels(input);
}
