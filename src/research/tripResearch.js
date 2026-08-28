import { getProfile } from "../storage/store.js";
import { extractTripIntent, getTripIntent } from "../tripIntent.js";
import { compareFlights } from "./flightComparison.js";
import { generateDestinationCandidates } from "./destinationCandidates.js";
import { searchHotels, isActiveHotelProviderConfigured } from "../providers/hotels/index.js";

function configuredNumber(name, fallback) { const value = Number(process.env[name]); return Number.isInteger(value) && value > 0 ? value : fallback; }
function exactDates(intent) { return Boolean(intent.dates?.departureDate && intent.dates?.returnDate); }

export async function researchTripOptions({ request, intent: suppliedIntent, providers } = {}) {
  const profile = await getProfile();
  const intent = suppliedIntent || (request ? extractTripIntent(request) : getTripIntent());
  if (!intent) throw new Error("Provide a trip request or structured Trip Intent.");
  const maxDestinations = configuredNumber("MAX_DESTINATION_CANDIDATES", 5);
  const maxProviders = configuredNumber("MAX_FLIGHT_PROVIDERS_PER_DESTINATION", 2);
  const maxHotels = configuredNumber("MAX_HOTEL_PROPERTIES", 5);
  const candidates = generateDestinationCandidates(intent, profile, maxDestinations);
  const selectedProviders = (providers || ["serpapi", "letsfg"]).slice(0, maxProviders);
  const origin = intent.origin?.explicit || profile.home?.preferredDeparturePoints?.[0] || profile.home?.nearbyDeparturePoints?.[0] || null;
  if (!exactDates(intent)) return { profileContext: { preferredAddress: profile.identity.preferredAddress, origin }, tripIntent: intent, candidates, flightResearch: [], hotelResearch: [], needsDateClarification: true, message: `${profile.identity.preferredAddress}, I can shortlist destinations now, but I need exact departure and return dates before running live fare or hotel searches.`, researchBudget: { maxDestinations, maxProvidersPerDestination: maxProviders, maxHotelPropertiesPerDestination: maxHotels } };
  if (!origin) return { profileContext: { preferredAddress: profile.identity.preferredAddress, origin: null }, tripIntent: intent, candidates, flightResearch: [], needsOriginClarification: true, message: `${profile.identity.preferredAddress}, I need an origin airport before running live fare searches.`, researchBudget: { maxDestinations, maxProvidersPerDestination: maxProviders } };
  const flightResearch = []; const hotelResearch = [];
  for (const candidate of candidates) {
    const comparison = await compareFlights({ origin, destination: candidate.airport, departureDate: intent.dates.departureDate, returnDate: intent.dates.returnDate, adults: intent.travelers?.count || 1, currencyCode: "USD", max: 10 }, selectedProviders);
    flightResearch.push({ candidate, comparison });
    if (isActiveHotelProviderConfigured()) {
      try {
        const hotels = await searchHotels({ destination: candidate.destination, checkIn: intent.dates.departureDate, checkOut: intent.dates.returnDate, guests: intent.travelers?.count || 1, rooms: 1, currency: "USD", max: maxHotels });
        hotelResearch.push({ candidate, hotels, preferenceContext: { accommodation: profile.accommodationPreferences?.byCompanion?.[intent.travelers?.companionType] || null } });
      } catch (error) { hotelResearch.push({ candidate, error: error.message }); }
    }
  }
  return { profileContext: { preferredAddress: profile.identity.preferredAddress, origin }, tripIntent: intent, candidates, flightResearch, hotelResearch, hotelResearchStatus: isActiveHotelProviderConfigured() ? "attempted" : "not_configured", researchBudget: { maxDestinations, maxProvidersPerDestination: maxProviders, maxHotelPropertiesPerDestination: maxHotels }, bookingAttempted: false };
}
