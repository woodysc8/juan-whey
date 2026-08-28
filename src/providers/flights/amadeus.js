import { amadeusGet } from "../../amadeusClient.js";

function airport(point) {
  return point ? { code: point.iataCode, terminal: point.terminal, time: point.at } : null;
}

function normalizeItinerary(itinerary) {
  const segments = itinerary.segments || [];
  const first = segments[0];
  const last = segments.at(-1);
  return {
    origin: airport(first?.departure), destination: airport(last?.arrival),
    departureTime: first?.departure?.at, arrivalTime: last?.arrival?.at,
    duration: itinerary.duration, stops: Math.max(0, segments.length - 1),
    layovers: segments.slice(0, -1).map((segment, index) => ({ airport: segment.arrival?.iataCode, arrivalTime: segment.arrival?.at, nextDepartureTime: segments[index + 1]?.departure?.at })),
    segments: segments.map((segment) => ({ airline: segment.carrierCode, flightNumber: segment.number ? `${segment.carrierCode}${segment.number}` : undefined, origin: airport(segment.departure), destination: airport(segment.arrival), departureTime: segment.departure?.at, arrivalTime: segment.arrival?.at, duration: segment.duration })),
  };
}

export async function searchFlights({ origin, destination, departureDate, returnDate, adults = 1, nonStop = false, currencyCode = "USD", max = 10 }) {
  const data = await amadeusGet("/v2/shopping/flight-offers", { originLocationCode: origin, destinationLocationCode: destination, departureDate, returnDate, adults, nonStop, currencyCode, max });
  const options = (data.data || []).map((offer) => {
    const itineraries = (offer.itineraries || []).map(normalizeItinerary);
    const segments = itineraries.flatMap((itinerary) => itinerary.segments);
    return {
      id: `amadeus:${offer.id}`, provider: "amadeus", source: "Amadeus",
      price: { total: Number(offer.price?.total), currency: offer.price?.currency },
      airlines: [...new Set(segments.map((segment) => segment.airline).filter(Boolean))],
      flightNumbers: segments.map((segment) => segment.flightNumber).filter(Boolean),
      origin: itineraries[0]?.origin || null, destination: itineraries.at(-1)?.destination || null,
      departureTime: itineraries[0]?.departureTime, arrivalTime: itineraries.at(-1)?.arrivalTime,
      totalDuration: itineraries.map((itinerary) => itinerary.duration), stops: itineraries.map((itinerary) => itinerary.stops),
      layovers: itineraries.flatMap((itinerary) => itinerary.layovers),
      baggage: offer.travelerPricings?.[0]?.fareDetailsBySegment?.map((fare) => fare.includedCheckedBags) || [],
      emissions: offer.co2Emissions || [], itineraries, booking: { providerOfferId: offer.id }, availableSeats: offer.numberOfBookableSeats,
    };
  });
  return { provider: "amadeus", source: "Amadeus", search: { origin, destination, departureDate, returnDate: returnDate || null, adults, currency: currencyCode }, optionCount: options.length, options };
}

export async function searchCheapestDates({ origin, destination, departureDate }) {
  const data = await amadeusGet("/v1/shopping/flight-dates", { origin, destination, departureDate });
  const dates = (data.data || []).map((date) => ({ departureDate: date.departureDate, returnDate: date.returnDate, price: Number(date.price?.total) })).sort((a, b) => a.price - b.price);
  return { provider: "amadeus", origin, destination, dates };
}
