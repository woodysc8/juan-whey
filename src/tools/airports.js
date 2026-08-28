import { amadeusGet } from "../amadeusClient.js";

// Resolve a free-text place name (e.g. "Curacao", "Providence") to IATA city/airport codes.
// Needed because flight/hotel search below require IATA codes, not city names.
export async function searchAirports({ keyword, subType = "AIRPORT,CITY" }) {
  const data = await amadeusGet("/v1/reference-data/locations", {
    subType,
    keyword,
    "page[limit]": 10,
  });

  const results = (data.data || []).map((loc) => ({
    name: loc.name,
    iataCode: loc.iataCode,
    type: loc.subType,
    cityName: loc.address?.cityName,
    countryName: loc.address?.countryName,
  }));

  return { query: keyword, results };
}
