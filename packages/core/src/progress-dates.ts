import { EpochMillis } from "./schema.ts";

// Weeks, days and months here are in the phone's own time zone, as the user lives them.

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const at = (date: Date) => EpochMillis.make(date.getTime());

/** Midnight on the Monday that starts the week holding `time`. */
export const startOfWeek = (time: number): EpochMillis => {
  const date = new Date(time);
  // Built from the date alone, so an hour a midnight clock change added to one day is
  // not carried to Monday.
  return at(
    new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7)),
  );
};

/** The week start `count` weeks after `weekStart`. Calendar days, so a clock change keeps midnight. */
export const addWeeks = (weekStart: number, count: number): EpochMillis => {
  const date = new Date(weekStart);
  return at(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7 * count));
};

const pad = (value: number) => String(value).padStart(2, "0");

/** A week as a link and route parameter carry it: its Monday as YYYY-MM-DD. */
export const weekKey = (weekStart: number): string => {
  const date = new Date(weekStart);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** The week holding the day a key names, or null for anything that is not a real YYYY-MM-DD date. */
export const parseWeekKey = (key: string): EpochMillis | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return null;
  }
  return startOfWeek(date.getTime());
};

/** "26 Oct 2026". */
export const formatDay = (time: number): string => {
  const date = new Date(time);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
};

/** "26 Oct to 1 Nov 2026". */
export const formatWeek = (weekStart: number): string => {
  const first = new Date(weekStart);
  const last = new Date(addWeeks(weekStart, 1));
  last.setDate(last.getDate() - 1);
  const firstYear = first.getFullYear() === last.getFullYear() ? "" : ` ${first.getFullYear()}`;
  return `${first.getDate()} ${MONTHS[first.getMonth()]}${firstYear} to ${formatDay(last.getTime())}`;
};

/** "26 Oct". */
export const formatShortDay = (time: number): string => {
  const date = new Date(time);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
};

/**
 * X-axis labels for points in time order. A point gets its month's name when
 * it is the first point or the first in a new month, and the year instead in
 * January or when the year changed. Every other point gets an empty label.
 */
export const monthLabels = (times: ReadonlyArray<number>): ReadonlyArray<string> =>
  times.map((time, index) => {
    const date = new Date(time);
    const before = index === 0 ? null : new Date(times[index - 1] ?? time);
    if (
      before &&
      before.getMonth() === date.getMonth() &&
      before.getFullYear() === date.getFullYear()
    ) {
      return "";
    }
    const newYear = before !== null && before.getFullYear() !== date.getFullYear();
    return date.getMonth() === 0 || newYear ? String(date.getFullYear()) : MONTHS[date.getMonth()]!;
  });

/** A month on a time axis: its months since year 0, where it starts and its label. */
export type MonthTick = {
  readonly month: number;
  readonly at: EpochMillis;
  readonly label: string;
};

const monthTick = (date: Date): MonthTick => ({
  month: date.getFullYear() * 12 + date.getMonth(),
  at: at(date),
  label: date.getMonth() === 0 ? String(date.getFullYear()) : MONTHS[date.getMonth()]!,
});

/**
 * A tick at the start of each month from `first` to `last`, named by the
 * month, or by the year in January. When no month starts in that time, the
 * one tick is `first` itself with its month's name.
 */
export const monthTicks = (first: number, last: number): ReadonlyArray<MonthTick> => {
  const start = new Date(first);
  // Each month's start is built on its own. Stepping one Date with setMonth would carry
  // the hour a midnight clock change added, such as 01:00, into the months after it.
  let month = start.getFullYear() * 12 + start.getMonth();
  if (new Date(Math.floor(month / 12), month % 12, 1).getTime() < first) month += 1;
  const ticks: Array<MonthTick> = [];
  for (; ; month += 1) {
    const date = new Date(Math.floor(month / 12), month % 12, 1);
    if (date.getTime() > last) break;
    ticks.push(monthTick(date));
  }
  return ticks.length > 0 ? ticks : [monthTick(start)];
};

export const CHART_RANGES = ["three_months", "year", "all"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export const CHART_RANGE_LABEL: Readonly<Record<ChartRange, string>> = {
  three_months: "3 months",
  year: "Year",
  all: "All",
};

export const isChartRange = (value: unknown): value is ChartRange =>
  CHART_RANGES.some((range) => range === value);

/** The earliest time a chart over `range` shows, or null when it shows everything. */
export const rangeStart = (range: ChartRange, now: number): EpochMillis | null => {
  if (range === "all") return null;
  const date = new Date(now);
  if (range === "three_months") date.setMonth(date.getMonth() - 3);
  else date.setFullYear(date.getFullYear() - 1);
  return at(date);
};
