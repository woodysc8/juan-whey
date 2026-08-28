import { getProfile } from "../storage/store.js";
import { getTripIntent } from "../tripIntent.js";

function numeric(value) { const amount = Number(value); return Number.isFinite(amount) ? amount : null; }
function money(amount, currency) { return amount === null ? "unknown" : `${currency || "USD"} ${amount.toFixed(0)}`; }
function flightFor(option) { return option.flightOption || option.tripOption || option.flight || null; }
function hotelFor(option) { return option.hotelOption || option.hotel || null; }
function economicsFor(option) { return option.economics || option.tripEconomics || null; }
function destinationFor(option) { return option.destination || option.candidate?.destination || flightFor(option)?.destination?.name || flightFor(option)?.destination?.code || null; }
function noveltyFor(option, profile) {
  if (option.novelty === "new" || option.candidate?.novelty === "new") return "new";
  if (option.novelty === "visited_before" || option.candidate?.novelty === "visited_before") return "revisit";
  const country = option.country || option.candidate?.country || null;
  if (country && (profile.travelHistory?.visits || []).some((visit) => visit.country === country)) return "revisit";
  return "unknown";
}
function isRedEye(flight) {
  const time = flight?.departureTime;
  const hour = time ? new Date(time).getHours() : NaN;
  return Number.isFinite(hour) ? hour < 6 : null;
}
function convenience(flight) {
  if (!flight) return { status: "unknown", totalDurationMinutes: null, stops: null, layovers: [], redEye: null };
  return { status: "available", totalDurationMinutes: numeric(flight.totalDurationMinutes), stops: numeric(flight.stops), layovers: flight.layovers || [], redEye: isRedEye(flight) };
}
function workContext(intent) {
  if (!intent?.work?.needsWork) return { status: "not_requested", note: null };
  if (!intent.dates?.departureDate || !intent.dates?.returnDate) return { status: "unknown", note: "Exact dates are needed to identify weekdays; PTO policy is not known." };
  const occupiedWeekdays = [];
  for (let date = new Date(`${intent.dates.departureDate}T00:00:00Z`); date <= new Date(`${intent.dates.returnDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1)) {
    if (date.getUTCDay() > 0 && date.getUTCDay() < 6) occupiedWeekdays.push(date.toISOString().slice(0, 10));
  }
  return { status: "needs_policy_confirmation", occupiedWeekdays, note: "These dates include workdays; remote-work compatibility and PTO requirements are not confirmed." };
}
function budgetCeiling(intent, constraints) { return numeric(constraints?.maximumTotal ?? constraints?.maximumTotalBudget ?? intent?.budget?.maximumTotal); }
function viable(option, ceiling) {
  const total = numeric(option.economics?.totalTripCost);
  if (ceiling === null) return { viable: true, reason: null };
  if (total === null) return { viable: false, reason: "total trip cost is unknown, so the stated ceiling cannot be verified" };
  return total <= ceiling ? { viable: true, reason: null } : { viable: false, reason: `estimated total exceeds the ${option.currency} ${ceiling} ceiling` };
}
function optionFacts(input, profile) {
  const economics = economicsFor(input);
  const flight = flightFor(input);
  const hotel = hotelFor(input);
  return {
    id: input.id || input.label || flight?.id || destinationFor(input) || "trip-option",
    label: input.label || input.id || destinationFor(input) || "Trip option",
    destination: destinationFor(input), country: input.country || input.candidate?.country || null,
    candidate: input.candidate || null, adventureFit: input.adventureFit || null, economics, flight, hotel, novelty: noveltyFor(input, profile),
    currency: economics?.currency || flight?.price?.currency || hotel?.currency || "USD",
    convenience: convenience(flight),
  };
}
function costSummary(option) {
  const economics = option.economics;
  return {
    totalTripCost: numeric(economics?.totalTripCost), estimatedUserCost: numeric(economics?.estimatedUserCost), sharedCosts: economics?.sharedCosts || [], reimbursementTotal: numeric(economics?.reimbursementTotal),
    components: economics?.components || null, totalStatus: economics?.total?.status || "unknown",
  };
}
function unknowns(option) {
  const missing = [...(option.economics?.missing || [])];
  if (!option.hotel) missing.push("hotel selection");
  else {
    if (option.hotel.taxesAndFees === null || option.hotel.taxesAndFees === undefined) missing.push("hotel taxes/fees breakdown");
    if (option.hotel.cancellation?.refundable === null || option.hotel.cancellation?.refundable === undefined) missing.push("hotel cancellation/refundability");
  }
  if (option.novelty === "unknown") missing.push("whether destination is new or a revisit");
  missing.push("destination-specific safety information");
  return [...new Set(missing)];
}
function explanation(option, intent, role, cheapest) {
  const cost = costSummary(option); const flight = option.convenience; const parts = [];
  if (role === "cheapest") parts.push("It has the lowest known total trip cost among viable options.");
  if (role === "best_overall") parts.push("It stays within the stated constraints while avoiding avoidable travel inconvenience where the available flight data supports that conclusion.");
  if (role === "value_convenience") parts.push("It is presented as a cost/convenience tradeoff using observed flight duration and stop data, not a composite score.");
  if (role === "most_adventurous") parts.push("It is the option whose existing destination research explicitly describes the strongest adventure fit; this is not a claim about unresearched activities.");
  if (cost.estimatedUserCost !== null) parts.push(`Estimated personal cost: ${money(cost.estimatedUserCost, option.currency)}; total trip cost: ${money(cost.totalTripCost, option.currency)}.`);
  else if (cost.totalTripCost !== null) parts.push(`Total trip cost: ${money(cost.totalTripCost, option.currency)}; personal cost is unknown.`);
  if (flight.status === "available") parts.push(`${flight.totalDurationMinutes ?? "Unknown"} minutes, ${flight.stops ?? "unknown"} stops${flight.redEye === true ? ", red-eye departure" : ""}.`);
  if (option.novelty === "new") parts.push("The destination is new based on the stored travel history.");
  if (option.novelty === "revisit") parts.push("This is a revisit based on the stored travel history.");
  if (intent?.travelers?.companionType === "girlfriend") parts.push("Couple context makes comfort, one-room lodging, and safety considerations more important; safety facts remain unknown here.");
  return parts;
}
function sacrifice(option, reference) {
  if (!reference || reference.id === option.id) return [];
  const amount = numeric(option.economics?.totalTripCost); const referenceAmount = numeric(reference.economics?.totalTripCost);
  const notes = [];
  if (amount !== null && referenceAmount !== null && amount > referenceAmount) notes.push(`Costs ${money(amount - referenceAmount, option.currency)} more than ${reference.label}.`);
  if (option.convenience.totalDurationMinutes !== null && reference.convenience.totalDurationMinutes !== null && option.convenience.totalDurationMinutes > reference.convenience.totalDurationMinutes) notes.push(`Adds ${option.convenience.totalDurationMinutes - reference.convenience.totalDurationMinutes} minutes of flight time versus ${reference.label}.`);
  if (option.convenience.stops !== null && reference.convenience.stops !== null && option.convenience.stops > reference.convenience.stops) notes.push(`Adds ${option.convenience.stops - reference.convenience.stops} stop(s) versus ${reference.label}.`);
  return notes.length ? notes : ["No material tradeoff can be established from the available data."];
}
function chooseBestOverall(options, intent) {
  const companion = intent?.travelers?.companionType;
  return [...options].sort((a, b) => {
    const aRedEye = a.convenience.redEye === true ? 1 : 0; const bRedEye = b.convenience.redEye === true ? 1 : 0;
    const aStops = a.convenience.stops ?? 99; const bStops = b.convenience.stops ?? 99;
    const aDuration = a.convenience.totalDurationMinutes ?? Number.MAX_SAFE_INTEGER; const bDuration = b.convenience.totalDurationMinutes ?? Number.MAX_SAFE_INTEGER;
    const aCost = numeric(a.economics?.estimatedUserCost) ?? numeric(a.economics?.totalTripCost) ?? Number.MAX_SAFE_INTEGER;
    const bCost = numeric(b.economics?.estimatedUserCost) ?? numeric(b.economics?.totalTripCost) ?? Number.MAX_SAFE_INTEGER;
    if (companion === "girlfriend") return aRedEye - bRedEye || aStops - bStops || aDuration - bDuration || aCost - bCost;
    return aCost - bCost || aRedEye - bRedEye || aStops - bStops || aDuration - bDuration;
  })[0];
}
function createRecommendation(option, role, intent, cheapest) {
  return {
    role, optionId: option.id, label: option.label, destination: option.destination, novelty: option.novelty,
    costs: costSummary(option), transportation: option.convenience,
    hotel: option.hotel ? { name: option.hotel.name ?? null, roomType: option.hotel.roomType ?? null, totalPrice: option.hotel.totalPrice ?? null, currency: option.hotel.currency ?? option.currency, cancellation: option.hotel.cancellation ?? null, priceStatus: option.hotel.priceStatus ?? "unknown" } : null,
    safety: { status: "unknown", note: "No destination-specific safety data was researched." }, work: workContext(intent), unknowns: unknowns(option), whyItFits: explanation(option, intent, role, cheapest), givesUpVersusCheapest: sacrifice(option, cheapest),
  };
}

/**
 * Produce a bounded, evidence-based decision brief. This does not fetch data,
 * recompute costs, invent safety/weather facts, or make booking decisions.
 */
export async function recommendTripOptions({ options = [], intent = null, profile = null, constraints = {} } = {}) {
  const activeProfile = profile || await getProfile();
  const activeIntent = intent || getTripIntent();
  if (!activeIntent?.dates?.departureDate || !activeIntent?.dates?.returnDate) return { status: "needs_clarification", missing: ["exact departure and return dates"], recommendations: [], excludedOptions: [], note: "Live research and PTO implications require exact dates." };
  if (!options.length) return { status: "no_viable_options", recommendations: [], excludedOptions: [], note: "No researched trip options were supplied." };
  const ceiling = budgetCeiling(activeIntent, constraints);
  const normalized = options.map((option) => optionFacts(option, activeProfile));
  const assessed = normalized.map((option) => ({ ...option, ...viable(option, ceiling) }));
  const viableOptions = assessed.filter((option) => option.viable && option.economics);
  const excludedOptions = assessed.filter((option) => !option.viable || !option.economics).map((option) => ({ optionId: option.id, label: option.label, reason: option.reason || "Trip Economics result is required for a recommendation." }));
  if (!viableOptions.length) return { status: "no_viable_options", budgetCeiling: ceiling, recommendations: [], excludedOptions, note: "No option can be recommended within the known constraints." };
  const cheapest = [...viableOptions].filter((option) => numeric(option.economics?.totalTripCost) !== null).sort((a, b) => a.economics.totalTripCost - b.economics.totalTripCost)[0] || null;
  const bestOverall = chooseBestOverall(viableOptions, activeIntent);
  const adventure = viableOptions.find((option) => /adventure|explor/i.test(option.candidate?.adventureFit || option.adventureFit || "")) || null;
  const valueConvenience = [...viableOptions].filter((option) => option.convenience.status === "available").sort((a, b) => (a.convenience.stops ?? 99) - (b.convenience.stops ?? 99) || (a.convenience.totalDurationMinutes ?? Number.MAX_SAFE_INTEGER) - (b.convenience.totalDurationMinutes ?? Number.MAX_SAFE_INTEGER) || (numeric(a.economics?.totalTripCost) ?? Number.MAX_SAFE_INTEGER) - (numeric(b.economics?.totalTripCost) ?? Number.MAX_SAFE_INTEGER))[0] || null;
  const selections = [["best_overall", bestOverall], ["cheapest", cheapest], ["value_convenience", valueConvenience], ["most_adventurous", adventure]].filter(([, option]) => option);
  const seen = new Set();
  const recommendations = selections.filter(([, option]) => { const key = `${option.id}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 5).map(([role, option]) => createRecommendation(option, role, activeIntent, cheapest));
  return { status: "ready", budgetCeiling: ceiling, budgetMeaning: "ceiling_not_target", recommendationCount: recommendations.length, recommendations, excludedOptions, note: "Recommendations are bounded evidence summaries. Estimated amounts, unknown safety facts, and unknown hotel terms are retained as such; no booking action is available." };
}
