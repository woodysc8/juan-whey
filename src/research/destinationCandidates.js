// Curated, static seed data isolated from orchestration. It is not real-time travel advice.
const CANDIDATES = [
  { destination: "San Juan, Puerto Rico", airport: "SJU", country: "Puerto Rico", warmWeatherFit: "typically warm; verify conditions for exact dates", adventureFit: "beaches plus outdoor exploration", safetyConsideration: "review current neighborhood-specific guidance", tripDurationFit: "practical for a short four-day trip" },
  { destination: "Cancún, Mexico", airport: "CUN", country: "Mexico", warmWeatherFit: "typically warm; verify conditions for exact dates", adventureFit: "beaches, cenotes, and excursions", safetyConsideration: "review current resort-area and transport guidance", tripDurationFit: "practical for a short beach-focused trip" },
  { destination: "Punta Cana, Dominican Republic", airport: "PUJ", country: "Dominican Republic", warmWeatherFit: "typically warm; verify conditions for exact dates", adventureFit: "beaches and water activities", safetyConsideration: "review current resort and transport guidance", tripDurationFit: "practical if flight schedules are reasonable" },
  { destination: "Nassau, Bahamas", airport: "NAS", country: "Bahamas", warmWeatherFit: "typically warm; verify conditions for exact dates", adventureFit: "beaches and water activities", safetyConsideration: "review current local safety guidance", tripDurationFit: "practical for a short trip" },
  { destination: "Oranjestad, Aruba", airport: "AUA", country: "Aruba", warmWeatherFit: "typically warm and beach-oriented; verify conditions", adventureFit: "beaches and island exploration", safetyConsideration: "review current local safety guidance", tripDurationFit: "reasonable only if fare and schedule justify the extra travel" },
];

export function generateDestinationCandidates(intent, profile, maxCandidates = 5) {
  if (intent.destination?.type === "specific") return CANDIDATES.filter((candidate) => candidate.destination.toLowerCase().includes(intent.destination.value.toLowerCase())).slice(0, maxCandidates);
  const visited = new Set((profile.travelHistory?.visits || []).map((visit) => visit.country).filter(Boolean));
  return CANDIDATES
    .filter((candidate) => !intent.destination?.weatherPreference || intent.destination.weatherPreference === "warm")
    .map((candidate) => ({ ...candidate, novelty: visited.has(candidate.country) ? "visited_before" : "new", rationale: `${candidate.warmWeatherFit}; ${candidate.tripDurationFit}. ${intent.travelers?.companionType === "girlfriend" ? "Couple context keeps safety and one-room lodging relevant." : ""}`.trim(), flightSearchReady: Boolean(candidate.airport), source: "static_curated_seed_not_realtime" }))
    .slice(0, maxCandidates);
}
