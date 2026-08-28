/**
 * Classifies candidate dates as weekend/holiday (free) vs. workday (requires PTO).
 * candidateDates: [{ date: "YYYY-MM-DD", note? }]  -- pass every weekday the trip occupies
 * holidays: ["YYYY-MM-DD", ...]
 */
export function calculatePTO({ candidateDates = [], holidays = [] }) {
  const holidaySet = new Set(holidays);
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const days = candidateDates.map(({ date, note = "" }) => {
    const dt = new Date(`${date}T00:00:00`);
    const dow = dt.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = holidaySet.has(date);
    return {
      date,
      note,
      weekday: weekdayNames[dow],
      requiresPTO: !isWeekend && !isHoliday,
    };
  });

  return {
    days,
    ptoDaysRequired: days.filter((d) => d.requiresPTO).length,
  };
}
