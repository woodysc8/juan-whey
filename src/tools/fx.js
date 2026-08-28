// Frankfurter (https://frankfurter.dev) mirrors European Central Bank daily reference rates.
// Free, no API key, no rate limit worth worrying about for personal use.

export async function getExchangeRate({ base = "USD", target, amount }) {
  const url = new URL("https://api.frankfurter.dev/v1/latest");
  url.searchParams.set("base", base);
  if (target) url.searchParams.set("symbols", target);

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Exchange rate lookup failed: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const rate = target ? data.rates?.[target] : data.rates;

  const result = { base, date: data.date, rate };
  if (target && amount != null) {
    result.target = target;
    result.amount = amount;
    result.converted = +(amount * rate).toFixed(2);
  }
  return result;
}
