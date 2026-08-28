// Flight tools intentionally know nothing about individual providers.
// Provider selection and normalization live in src/providers/flights/.
export { searchFlights, searchCheapestDates } from "../providers/flights/index.js";
