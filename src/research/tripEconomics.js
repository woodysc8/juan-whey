import { getProfile } from "../storage/store.js";
import { getTripIntent } from "../tripIntent.js";

function round(amount) { return Math.round(amount * 100) / 100; }
function component(amount = null, status = "unknown", extra = {}) { return { amount, status, ...extra }; }
function numeric(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }

function dateDuration(intent, explicitNights) {
  if (numeric(explicitNights) !== null) return { nights: numeric(explicitNights), days: numeric(explicitNights) + 1, basis: "user-provided nights" };
  const departure = intent?.dates?.departureDate;
  const returning = intent?.dates?.returnDate;
  if (departure && returning) {
    const nights = Math.round((Date.parse(`${returning}T00:00:00Z`) - Date.parse(`${departure}T00:00:00Z`)) / 86_400_000);
    if (nights > 0) return { nights, days: nights + 1, basis: "exact departure and return dates" };
  }
  const exactDays = numeric(intent?.duration?.exactDays);
  if (exactDays && exactDays > 1) return { nights: exactDays - 1, days: exactDays, basis: "Trip Intent exact duration (days minus one night)" };
  return { nights: null, days: null, basis: null };
}

function userOrEstimated(userProvided, userKey, estimate, multiplier, basis) {
  const userAmount = numeric(userProvided?.[userKey]);
  if (userAmount !== null) return component(userAmount, "user_provided", { source: "user", basis: "user-provided amount" });
  const estimateAmount = numeric(estimate);
  if (estimateAmount === null || multiplier === null) return component();
  return component(round(estimateAmount * multiplier), "estimated", { source: "deterministic_estimator", basis });
}

function lodgingComponent(hotelOption, userProvided, estimate, nights) {
  const observed = numeric(hotelOption?.totalPrice);
  if (observed !== null) return component(observed, "observed", { source: hotelOption.provider || "hotel_provider", basis: "hotel search result; total stay price" });
  return userOrEstimated(userProvided, "lodging", estimate, nights, nights === null ? null : `estimated nightly rate × ${nights} nights`);
}

function flightComponent(tripOption, userProvided) {
  const observed = numeric(tripOption?.price?.total);
  if (observed !== null) return component(observed, "observed", { source: tripOption.provider || "flight_provider", basis: "normalized flight-provider price" });
  const userAmount = numeric(userProvided?.flights);
  if (userAmount !== null) return component(userAmount, "user_provided", { source: "user", basis: "user-provided flight amount" });
  return component();
}

/**
 * Research-only cash-cost model. It never fetches providers and never treats a
 * deterministic estimate as a confirmed market price.
 */
export async function estimateTripEconomics({ tripOption = null, hotelOption = null, intent = null, currency = "USD", nights, estimates = {}, userProvided = {}, sharedCosts = [] } = {}) {
  const profile = await getProfile();
  const activeIntent = intent || getTripIntent();
  const duration = dateDuration(activeIntent, nights);
  const components = {
    flights: flightComponent(tripOption, userProvided),
    lodging: lodgingComponent(hotelOption, userProvided, estimates.lodgingNightlyEstimate, duration.nights),
    food: userOrEstimated(userProvided, "food", estimates.foodDailyEstimate, duration.days, duration.days === null ? null : `estimated daily food budget × ${duration.days} days`),
    activities: userOrEstimated(userProvided, "activities", estimates.activitiesDailyEstimate, duration.days, duration.days === null ? null : `estimated activity budget × ${duration.days} days`),
    localTransportation: userOrEstimated(userProvided, "localTransportation", estimates.localTransportDailyEstimate, duration.days, duration.days === null ? null : `estimated local transportation budget × ${duration.days} days`),
    other: userOrEstimated(userProvided, "other", estimates.otherEstimate, 1, "explicit incidentals estimate"),
  };
  const missing = Object.entries(components).filter(([, value]) => value.amount === null).map(([key]) => key);
  const knownSubtotal = round(Object.values(components).reduce((sum, value) => sum + (value.amount ?? 0), 0));
  const totalAmount = missing.length ? null : knownSubtotal;
  const normalizedSharedCosts = sharedCosts.map((cost) => ({ name: cost.name || "shared expense", amountOwed: numeric(cost.amountOwed) ?? 0, component: cost.component || null, status: "user_provided" }));
  const reimbursements = round(normalizedSharedCosts.reduce((sum, cost) => sum + cost.amountOwed, 0));
  const estimatedUserCost = totalAmount === null ? null : round(totalAmount - reimbursements);
  const clarification = [];
  if (duration.nights === null && (numeric(estimates.lodgingNightlyEstimate) !== null || numeric(estimates.foodDailyEstimate) !== null || numeric(estimates.activitiesDailyEstimate) !== null || numeric(estimates.localTransportDailyEstimate) !== null)) clarification.push("exact travel dates, nights, or exact trip duration");
  for (const key of missing) clarification.push(`${key} amount or estimate`);
  return {
    status: clarification.length ? "needs_clarification" : "ready",
    missing: [...new Set(clarification)],
    currency: tripOption?.price?.currency || hotelOption?.currency || currency,
    duration,
    components,
    total: totalAmount === null ? component(null, "unknown", { knownSubtotal, basis: "full total unavailable while one or more components are unknown" }) : component(totalAmount, Object.values(components).some((value) => value.status === "estimated") ? "estimated" : "observed_or_user_provided", { basis: "sum of all components" }),
    totalTripCost: totalAmount,
    estimatedUserCost,
    sharedCosts: normalizedSharedCosts,
    reimbursementTotal: reimbursements,
    profileContext: {
      budgetMeaning: profile.budgetBehavior?.maximumMeans,
      companionType: activeIntent?.travelers?.companionType || null,
      lodgingPreference: activeIntent?.travelers?.companionType ? profile.accommodationPreferences?.byCompanion?.[activeIntent.travelers.companionType] || null : null,
      groceriesAcceptable: profile.foodPreferences?.groceriesAcceptable ?? null,
    },
    flightConvenience: tripOption ? { totalDurationMinutes: tripOption.totalDurationMinutes ?? null, stops: tripOption.stops ?? null, layovers: tripOption.layovers ?? [] } : null,
    researchOnly: true,
  };
}

export function compareTripEconomics(options = []) {
  const comparable = options.map(({ label = null, economics, tripOption = null }) => ({ label, totalTripCost: economics.totalTripCost, estimatedUserCost: economics.estimatedUserCost, status: economics.status, convenience: tripOption ? { totalDurationMinutes: tripOption.totalDurationMinutes ?? null, stops: tripOption.stops ?? null } : economics.flightConvenience }));
  const known = comparable.filter((option) => option.totalTripCost !== null);
  const lowest = known.reduce((best, option) => !best || option.totalTripCost < best.totalTripCost ? option : best, null);
  return {
    options: comparable.map((option) => ({ ...option, costDifferenceFromLowest: lowest && option.totalTripCost !== null ? round(option.totalTripCost - lowest.totalTripCost) : null })),
    lowestKnownTotal: lowest ? { label: lowest.label, amount: lowest.totalTripCost } : null,
    note: "Costs are compared only where all components are known or explicitly estimated; no recommendation score is assigned.",
  };
}
