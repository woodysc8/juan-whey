/**
 * Pure arithmetic — gross cost, what Senor fronts, what others owe back, and his eventual share.
 * items: [{ label, amount }]
 * splits: [{ name, amountOwed }]  -- what each other person owes Senor back
 */
export function calculateTotals({ items = [], splits = [], currency = "USD" }) {
  const gross = round2(items.reduce((sum, i) => sum + toNumber(i.amount), 0));
  const friendsOwe = round2(splits.reduce((sum, s) => sum + toNumber(s.amountOwed), 0));
  const senorEventual = round2(gross - friendsOwe);

  return {
    currency,
    gross,
    senorUpfront: gross,
    friendsOwe,
    senorEventual,
    itemBreakdown: items,
    splitBreakdown: splits,
  };
}

function toNumber(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
