/**
 * Implied cents-per-point value of a redemption vs. a researched baseline point value.
 * Does NOT know current Bilt rules itself -- feed it a cash price, points required, and
 * whatever baseline cpp you've looked up (e.g. from a current Bilt valuation writeup).
 */
export function calculateRewards({
  cashPrice,
  pointsRequired,
  assumedPointValueCents,
  pointsAvailable,
}) {
  const impliedCentsPerPoint =
    pointsRequired > 0 ? round3((cashPrice * 100) / pointsRequired) : null;

  const goodDeal =
    impliedCentsPerPoint != null && assumedPointValueCents != null
      ? impliedCentsPerPoint >= assumedPointValueCents
      : null;

  const pointsShortfall =
    pointsAvailable != null ? Math.max(0, pointsRequired - pointsAvailable) : null;

  return {
    cashPrice,
    pointsRequired,
    assumedPointValueCents,
    impliedCentsPerPoint,
    goodDeal,
    pointsAvailable: pointsAvailable ?? null,
    pointsShortfall,
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
