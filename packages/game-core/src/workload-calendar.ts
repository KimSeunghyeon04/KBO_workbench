import type { WorkloadAppearance } from "@kbo/contracts";

const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86400000;
/** One calendar entry per date; same-day games never acquire an invented order. */
export function workloadCalendar(history: readonly WorkloadAppearance[], cutoff: string) {
  const dates = new Map<string, { pitches: number; appearances: number }>();
  for (const row of history) {
    if (row.gameDate > cutoff) continue;
    const total = dates.get(row.gameDate) ?? { pitches: 0, appearances: 0 };
    total.pitches += row.pitches;
    total.appearances++;
    dates.set(row.gameDate, total);
  }
  const result = new Map<
    string,
    {
      previousObservedDate: string | null;
      observedRestDays: number | null;
      previous3DaysPitches: number;
      previous7DaysPitches: number;
      observedConsecutiveDays: number;
      sameDayAppearances: number;
    }
  >();
  let previous: string | null = null,
    streak = 0;
  const recent: { date: number; pitches: number }[] = [];
  let start = 0;
  for (const date of [...dates.keys()].sort()) {
    const total = dates.get(date);
    if (total === undefined) throw new Error("Missing workload date");
    const current = day(date);
    while (start < recent.length && (recent[start]?.date ?? current) < current - 7) start++;
    let three = 0,
      seven = 0;
    for (let i = start; i < recent.length; i++) {
      const prior = recent[i];
      if (prior === undefined) continue;
      seven += prior.pitches;
      if (prior.date >= current - 3) three += prior.pitches;
    }
    const nextStreak =
      total.pitches > 0 ? (previous !== null && day(previous) === current - 1 ? streak + 1 : 1) : 0;
    result.set(date, {
      previousObservedDate: previous,
      observedRestDays: previous === null ? null : current - day(previous) - 1,
      previous3DaysPitches: three,
      previous7DaysPitches: seven,
      observedConsecutiveDays: nextStreak,
      sameDayAppearances: total.appearances,
    });
    if (total.pitches > 0) {
      previous = date;
      streak = nextStreak;
      recent.push({ date: current, pitches: total.pitches });
    }
  }
  return result;
}
