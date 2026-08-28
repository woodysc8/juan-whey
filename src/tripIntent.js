import { updateTrip } from "./storage/store.js";

let currentTripIntent = null;

export function emptyTripIntent() {
  return {
    tripType: null,
    origin: { explicit: null, defaultFromProfile: true },
    destination: { type: "unknown", value: null, weatherPreference: null },
    dates: { departureDate: null, returnDate: null, dateRange: null, flexible: null, naturalLanguage: null, constraints: [] },
    duration: { exactDays: null, approximate: null, flexible: null },
    travelers: { count: null, companionType: null, context: null },
    budget: { maximumTotal: null, maximumTransportation: null, maximumLodging: null, meaning: "ceiling", specified: false },
    transportation: { preferredMode: null, acceptableModes: null, maximumStops: null, redEyePreference: null, alternateAirportTolerance: null },
    lodging: { type: null, roomConfiguration: null, nightlyBudget: null, totalBudget: null, locationPreference: null, cancellationFlexibility: null },
    activities: { desiredTypes: [], intensity: null, beachRelaxationAdventureBalance: null },
    food: { budget: null, preference: null, dietaryConstraints: [] },
    work: { needsWork: null, schedule: null, pto: null, locationRequirements: [] },
    rewards: { maximize: null, rentDayRelevant: null, cashVsPoints: null, reimbursedExpenses: null, ultimatePayer: null },
    safety: { level: "normal", constraints: [] },
    novelty: { prioritizeNew: null, revisitAcceptable: null, destinationRequired: null },
    specialConstraints: [],
    extraction: { source: null, confidence: "low", unrecognized: [] },
  };
}

function has(text, expression) { return expression.test(text); }

/** Conservative deterministic extraction: captures explicit cues and leaves the rest null. */
export function extractTripIntent(request) {
  const text = request.toLowerCase();
  const intent = emptyTripIntent();
  intent.extraction = { source: request, confidence: "medium", unrecognized: [] };

  if (has(text, /work trip/) && has(text, /(afterward|after|home)/)) intent.tripType = "combined_work_vacation";
  else if (has(text, /work trip/)) intent.tripType = "work_trip";
  else if (has(text, /(grandparent|family|mom|dad|mother|father|relative)/)) intent.tripType = "visiting_family_friends";
  else if (has(text, /(local overnight|overnight.*(?:boston|westerly|london))/)) intent.tripType = "local_overnight";
  else if (has(text, /(how.*get|transportation.?only|train|bus|flight).*home/)) intent.tripType = "transportation_only";
  else if (has(text, /(somewhere|thinking about going|vacation|trip)/)) intent.tripType = "vacation";

  if (has(text, /girlfriend/)) { intent.travelers = { count: 2, companionType: "girlfriend", context: "couple" }; intent.safety.level = "elevated"; }
  else if (has(text, /\bsolo\b|\balone\b/)) intent.travelers = { count: 1, companionType: "solo", context: null };
  else if (has(text, /\bfriends?\b/)) intent.travelers = { count: null, companionType: "friends", context: null };

  const duration = text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:day|days|night|nights)\b/);
  if (duration) {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const days = Number(duration[1]) || words[duration[1]];
    intent.duration = { exactDays: days, approximate: null, flexible: false };
  }
  if (has(text, /late november/)) { intent.dates.naturalLanguage = "late November"; intent.dates.dateRange = { month: "November", part: "late" }; intent.dates.flexible = true; }
  else if (has(text, /\bfebruary\b/)) { intent.dates.naturalLanguage = "February"; intent.dates.dateRange = { month: "February", part: null }; intent.dates.flexible = true; }
  else if (has(text, /next weekend/)) { intent.dates.naturalLanguage = "next weekend"; intent.dates.flexible = true; }

  if (has(text, /somewhere warm|\bwarm\b/)) { intent.destination = { type: "open", value: null, weatherPreference: "warm" }; intent.activities.beachRelaxationAdventureBalance = "warm_or_beach_when_appropriate"; }
  const place = text.match(/\b(?:to|in)\s+(maryland|saratoga)\b/i);
  if (place) intent.destination = { type: "specific", value: place[1][0].toUpperCase() + place[1].slice(1), weatherPreference: null };

  if (has(text, /new destination|somewhere new/)) intent.novelty.prioritizeNew = true;
  if (intent.destination.type === "open") { intent.novelty.prioritizeNew = true; intent.novelty.revisitAcceptable = true; }
  if (has(text, /red-?eye/)) intent.transportation.redEyePreference = "avoid_when_practical_not_absolute";
  if (has(text, /overnight bus/)) intent.transportation.acceptableModes = ["bus"];
  if (has(text, /bilt|rewards|points/)) intent.rewards.maximize = true;
  if (has(text, /reimburs/)) intent.rewards.reimbursedExpenses = true;
  return intent;
}

export function getTripIntent() { return currentTripIntent; }
export function setTripIntent(intent) { currentTripIntent = intent; return currentTripIntent; }
export function extractAndSetTripIntent(request) { return setTripIntent(extractTripIntent(request)); }
export function clearTripIntent() { currentTripIntent = null; return null; }

// Persistence is opt-in. Normal intent state is only held for this MCP process/session.
export async function saveTripIntent() {
  if (!currentTripIntent) throw new Error("No active Trip Intent to save.");
  return updateTrip({ tripIntent: currentTripIntent });
}
