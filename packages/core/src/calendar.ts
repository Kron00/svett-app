const DAY = 86_400_000;

/**
 * Minutes ahead of UTC at an instant. On the phone it is
 * `-new Date(millis).getTimezoneOffset()`, which follows daylight saving time.
 */
export type UtcOffset = (millis: number) => number;

export const UTC: UtcOffset = () => 0;

/** Days since 1 January 1970 on the local calendar. */
export const localDayNumber = (millis: number, offset: UtcOffset): number =>
  Math.floor((millis + offset(millis) * 60_000) / DAY);

/** The first instant of the next local day, when a screen showing today must move on. */
export const nextLocalMidnight = (millis: number, offset: UtcOffset): number => {
  const day = localDayNumber(millis, offset);
  const midnight = (day + 1) * DAY;
  const sameOffset = midnight - offset(millis) * 60_000;
  // Where the clocks go back at midnight, that instant still falls on the same day.
  return localDayNumber(sameOffset, offset) > day
    ? sameOffset
    : midnight - offset(sameOffset) * 60_000;
};

/** Weeks run Monday to Sunday. Day 0 was a Thursday, so week 0 starts on day -3. */
const weekNumber = (dayNumber: number): number => Math.floor((dayNumber + 3) / 7);

export type Streak = {
  /** Weeks in a row with a workout, up to this week. */
  readonly current: number;
  readonly longest: number;
};

/**
 * The streak counts weeks with at least one workout, so rest days never break
 * it. This week has not ended, so a streak that reached last week still counts
 * until this week ends without a workout.
 */
export const weekStreak = (
  startedAt: ReadonlyArray<number>,
  now: number,
  offset: UtcOffset,
): Streak => {
  const weeks = new Set(startedAt.map((millis) => weekNumber(localDayNumber(millis, offset))));
  const sorted = [...weeks].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  for (const [index, week] of sorted.entries()) {
    run = index > 0 && sorted[index - 1] === week - 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const thisWeek = weekNumber(localDayNumber(now, offset));
  let week = weeks.has(thisWeek) ? thisWeek : thisWeek - 1;
  let current = 0;
  while (weeks.has(week)) {
    current++;
    week--;
  }
  return { current, longest };
};

/** A calendar month. `month` runs from 1 for January to 12. */
export type CalendarMonth = { readonly year: number; readonly month: number };

export const monthOf = (millis: number, offset: UtcOffset): CalendarMonth => {
  const date = new Date(localDayNumber(millis, offset) * DAY);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
};

export const shiftMonth = ({ year, month }: CalendarMonth, by: number): CalendarMonth => {
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};

/** "2026-11", the form deep links use. */
export const monthKey = ({ year, month }: CalendarMonth): string =>
  `${year}-${String(month).padStart(2, "0")}`;

export const parseMonthKey = (key: string): CalendarMonth | null => {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null;
};

export type CalendarDay<W> = {
  /** Day of the month, from 1. */
  readonly day: number;
  readonly dayNumber: number;
  /** The workouts that started that day, in the order given. */
  readonly workouts: ReadonlyArray<W>;
};

/**
 * The month as weeks from Monday to Sunday. Cells before the 1st and after the
 * last day are null, so every week has seven cells.
 */
export const calendarWeeks = <W extends { readonly startedAt: number }>(
  { year, month }: CalendarMonth,
  workouts: ReadonlyArray<W>,
  offset: UtcOffset,
): ReadonlyArray<ReadonlyArray<CalendarDay<W> | null>> => {
  const first = Date.UTC(year, month - 1, 1) / DAY;
  const length = Date.UTC(year, month, 1) / DAY - first;
  const byDay = new Map<number, Array<W>>();
  for (const workout of workouts) {
    const day = localDayNumber(workout.startedAt, offset);
    if (day >= first && day < first + length) byDay.set(day, [...(byDay.get(day) ?? []), workout]);
  }
  const lead = (((first + 3) % 7) + 7) % 7;
  const cells: Array<CalendarDay<W> | null> = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= length; day++) {
    const dayNumber = first + day - 1;
    cells.push({ day, dayNumber, workouts: byDay.get(dayNumber) ?? [] });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
};
