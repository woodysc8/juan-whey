import "dotenv/config";
import { searchFlightsWithProvider } from "../src/providers/flights/index.js";

if (!process.env.LETSFG_BEARER_TOKEN) {
  console.error("Missing LETSFG_BEARER_TOKEN. Configure the free LetsFG agent bearer token; LETSFG_API_KEY is not accepted by this diagnostic.");
  process.exitCode = 1;
} else {
  const result = await searchFlightsWithProvider("letsfg", { origin: "PVD", destination: "MIA", departureDate: "2026-11-19", returnDate: "2026-11-22", adults: 2, cabinClass: "economy", currencyCode: "USD", max: 10 });
  console.log(JSON.stringify(result, null, 2));
}
