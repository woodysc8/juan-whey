import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const PROFILE_PATH = path.join(DATA_DIR, "profile.json");
const TRIP_PATH = path.join(DATA_DIR, "trip.json");

function defaultProfile() {
  return {
    profileVersion: 2,
    identity: { preferredAddress: "Señor", alwaysUsePreferredAddress: true },
    home: { location: null, preferredDeparturePoints: [], nearbyDeparturePoints: ["PVD", "BOS"], alternateAirportTolerance: "consider_when_value_justifies" },
    travelHistory: { visits: [], visitedCountries: [] },
    languages: ["English"],
    companions: { typical: ["solo", "girlfriend", "friends"], contexts: { solo: { savingsInconvenienceTolerance: "higher" }, girlfriend: { safetyCaution: "higher", lodging: "one_room" }, friends: { lodging: "shared_multiple_beds" } } },
    transportationPreferences: { modes: ["flights", "trains", "buses"], overnightBusSolo: "consider_for_meaningful_savings", inconvenienceForSavings: "consider_when_meaningful", redEyes: "avoid_when_practical_not_absolute", alternateAirports: "consider_when_value_justifies", compareModeCombinations: true },
    accommodationPreferences: { general: ["hotel", "airbnb"], hostel: "not_default_but_acceptable_for_long_or_expensive_trips", byCompanion: { girlfriend: "one_room", friends: "shared_room_multiple_beds", solo: "economical_appropriate_options" }, valueOverLowestPrice: true },
    foodPreferences: { askPerTrip: true, groceriesAcceptable: true, eatingOutAcceptable: true, foodBudget: null },
    activityPreferences: { balance: "mix_relaxing_and_activities", beaches: "strong_preference", freeWalkingTours: true, adventure: true, exploration: true, packedItinerary: "suggest_not_assume" },
    budgetBehavior: { maximumMeans: "ceiling_not_target", frontsSharedExpenses: true, substantialLiquidity: true, separateTotalFromPersonalOutOfPocket: true },
    rewardsStrategy: { valuesCreditCardRewards: true, biltRentDay: "consider_when_relevant", evaluate: ["cash_price", "points_earned", "points_redeemed", "estimated_points_value", "effective_net_cost"], pointsAreNotAutomaticallyBetterThanCash: true, reimbursementsSeparateFromRewards: true },
    workPreferences: { remoteWorkPossible: true, longerTripsMayIncludeWork: true, considerPtoAndWorkSchedule: true },
    safetyPreferences: { importance: "factor_not_absolute_filter", withGirlfriend: "more_conservative", solo: "more_risk_and_inconvenience_tolerance" },
    destinationPreferences: { prioritizeNew: "preference_not_requirement", adventure: true, warmBeachWhenAppropriate: true, suggestUnconsideredDestinations: true, explainUnusualTradeoffs: true },
    localTravel: { frequentShortOvernights: true, recurring: [{ destination: "Boston", host: "Nick", notes: "Frequent local overnight trip." }, { destination: "London", host: "Nora", notes: "Frequent local overnight trip." }, { destination: "Westerly", host: "Nora", notes: "Frequent local overnight trip." }] },
    mapPreferences: { enjoysMaps: true, futureVisitedCountriesMap: true },
    facts: [], conflicts: [], hardConstraints: [], learnedPreferences: [],
    biltNotes: "Bilt earning categories, Rent Day timing, and transfer partners change -- look them up fresh rather than trusting a stored value here.",
  };
}

async function ensureDataDir() { await mkdir(DATA_DIR, { recursive: true }); }
async function readJsonOrDefault(filePath, fallback) { try { return JSON.parse(await readFile(filePath, "utf-8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } }

function hydrateProfile(profile) {
  const defaults = defaultProfile();
  return {
    ...defaults, ...profile,
    identity: { ...defaults.identity, ...(profile.identity || {}) }, home: { ...defaults.home, ...(profile.home || {}) },
    travelHistory: Array.isArray(profile.travelHistory) ? { ...defaults.travelHistory, visits: profile.travelHistory } : { ...defaults.travelHistory, ...(profile.travelHistory || {}) },
    companions: { ...defaults.companions, ...(profile.companions || {}) }, transportationPreferences: { ...defaults.transportationPreferences, ...(profile.transportationPreferences || {}) },
    accommodationPreferences: { ...defaults.accommodationPreferences, ...(profile.accommodationPreferences || {}) }, foodPreferences: { ...defaults.foodPreferences, ...(profile.foodPreferences || {}) },
    activityPreferences: { ...defaults.activityPreferences, ...(profile.activityPreferences || {}) }, budgetBehavior: { ...defaults.budgetBehavior, ...(profile.budgetBehavior || {}) },
    rewardsStrategy: { ...defaults.rewardsStrategy, ...(profile.rewardsStrategy || {}) }, workPreferences: { ...defaults.workPreferences, ...(profile.workPreferences || {}) },
    safetyPreferences: { ...defaults.safetyPreferences, ...(profile.safetyPreferences || {}) }, destinationPreferences: { ...defaults.destinationPreferences, ...(profile.destinationPreferences || {}) },
    localTravel: { ...defaults.localTravel, ...(profile.localTravel || {}) }, mapPreferences: { ...defaults.mapPreferences, ...(profile.mapPreferences || {}) },
    facts: profile.facts || [], conflicts: profile.conflicts || [], recurringLocal: profile.recurringLocal || profile.localTravel?.recurring || defaults.localTravel.recurring,
  };
}

export async function getProfile() { await ensureDataDir(); return hydrateProfile(await readJsonOrDefault(PROFILE_PATH, defaultProfile())); }
export async function replaceProfile(profile) { const next = hydrateProfile(profile); await ensureDataDir(); await writeFile(PROFILE_PATH, JSON.stringify(next, null, 2)); return next; }
export async function updateProfile(patch) { return replaceProfile({ ...(await getProfile()), ...patch }); }

// Explicit, sourced facts avoid treating a one-trip choice as a lasting preference.
export async function recordProfileFact({ key, value, source = "explicit_statement", confidence = "high", context = null }) {
  const current = await getProfile();
  const sameKey = current.facts.filter((fact) => fact.key === key);
  const sameValue = sameKey.find((fact) => JSON.stringify(fact.value) === JSON.stringify(value));
  if (sameValue) return { profile: current, fact: sameValue, conflict: null };
  const fact = { key, value, source, confidence, context, recordedAt: new Date().toISOString() };
  const conflicts = sameKey.length ? [...current.conflicts, { key, existing: sameKey, incoming: fact, status: "unresolved" }] : current.conflicts;
  const profile = await replaceProfile({ ...current, facts: [...current.facts, fact], conflicts });
  return { profile, fact, conflict: sameKey.length ? conflicts.at(-1) : null };
}

export async function getTrip() { await ensureDataDir(); return readJsonOrDefault(TRIP_PATH, null); }
export async function updateTrip(patch) {
  const current = (await getTrip()) || { status: "discovery", tripTypes: [], hardConstraints: [], preferences: [], sources: [], openQuestions: [] };
  const now = new Date().toISOString();
  const next = { ...current, ...patch, costBreakdown: patch.costBreakdown ? { ...(current.costBreakdown || {}), ...patch.costBreakdown } : current.costBreakdown, costSummary: patch.costSummary ? { ...(current.costSummary || {}), ...patch.costSummary } : current.costSummary, pto: patch.pto ? { ...(current.pto || {}), ...patch.pto } : current.pto, rewards: patch.rewards ? { ...(current.rewards || {}), ...patch.rewards } : current.rewards, createdAt: current.createdAt || now, updatedAt: now };
  await ensureDataDir(); await writeFile(TRIP_PATH, JSON.stringify(next, null, 2)); return next;
}
export async function resetTrip() { await ensureDataDir(); await writeFile(TRIP_PATH, "null"); return null; }
