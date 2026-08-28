import "dotenv/config";
import { searchFlights } from "../src/providers/flights/index.js";

if ((process.env.FLIGHT_PROVIDER || "serpapi").toLowerCase() !== "serpapi") throw new Error("diagnose:flight requires FLIGHT_PROVIDER=serpapi (or no FLIGHT_PROVIDER setting).");

const result = await searchFlights({ origin: "PVD", destination: "MIA", departureDate: "2026-11-19", returnDate: "2026-11-22", adults: 2, cabinClass: "economy", currencyCode: "USD", max: 50 });
console.log(JSON.stringify(result, null, 2));
