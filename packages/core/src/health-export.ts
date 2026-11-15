import { Exit, Schema } from "effect";

import { XmlScanner, xmlAttributes } from "./xml.ts";

/** A workout as Apple Health's export.xml records it, with the heart rate inside its window. */
export const HealthWorkout = Schema.Struct({
  /** Such as HKWorkoutActivityTypeRunning. */
  activityType: Schema.NonEmptyString,
  /** The app or device that recorded it, such as an Apple Watch. */
  sourceName: Schema.String,
  startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  endedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The hour on the clock where it was recorded, for a title such as "Morning run". */
  localHour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  durationS: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  distanceM: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  energyKcal: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  /** The route's GPX file inside the export, such as /workout-routes/route_2026-11-01.gpx. */
  routeFile: Schema.NullOr(Schema.String),
  heartRate: Schema.Array(
    Schema.Struct({
      recordedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      bpm: Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 260 })),
    }),
  ),
}).check(
  Schema.makeFilter((workout) =>
    workout.endedAt >= workout.startedAt ? undefined : "a workout ends after it starts",
  ),
);
export type HealthWorkout = typeof HealthWorkout.Type;

export interface HealthExport {
  readonly workouts: ReadonlyArray<HealthWorkout>;
  /** Workouts svett could not read, such as one with no start time. */
  readonly skipped: number;
  /** Whether the file had Apple Health's root element at all. */
  readonly isHealthExport: boolean;
}

const HEALTH_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/** Reads a date as export.xml writes it, such as 2026-11-01 07:30:00 +0100. */
export const parseHealthDate = (
  text: string | undefined,
): { readonly at: number; readonly localHour: number } | null => {
  const match = text === undefined ? null : HEALTH_DATE.exec(text.trim());
  if (match === null) return null;
  const [year, month, day, hour, minute, second, , offsetHours, offsetMinutes] = match
    .slice(1)
    .map(Number) as Array<number>;
  const offset = (match[7] === "-" ? -1 : 1) * (offsetHours! * 60 + offsetMinutes!) * 60_000;
  const local = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  return { at: local - offset, localHour: hour! };
};

const METRES: Readonly<Record<string, number>> = {
  m: 1,
  km: 1000,
  mi: 1609.344,
  yd: 0.9144,
  ft: 0.3048,
  cm: 0.01,
};
const KCAL: Readonly<Record<string, number>> = { Cal: 1, kcal: 1, cal: 0.001, kJ: 1 / 4.184 };
const SECONDS: Readonly<Record<string, number>> = { s: 1, sec: 1, min: 60, hr: 3600, h: 3600 };

const scaled = (
  value: string | undefined,
  unit: string | undefined,
  table: Readonly<Record<string, number>>,
) => {
  if (value === undefined || unit === undefined) return null;
  const factor = table[unit];
  const number = Number(value);
  return factor === undefined || !Number.isFinite(number) ? null : number * factor;
};

const HEART_RATE = "HKQuantityTypeIdentifierHeartRate";
const DISTANCE = "HKQuantityTypeIdentifierDistance";
const ENERGY = "HKQuantityTypeIdentifierActiveEnergyBurned";

const decodeWorkout = Schema.decodeUnknownExit(HealthWorkout);

interface Totals {
  distanceM: number | null;
  energyKcal: number | null;
}

interface OpenWorkout {
  readonly attributes: Record<string, string>;
  /** Elements open inside the workout, so its own statistics are told from its activities'. */
  depth: number;
  /** The workout's own statistics, and since iOS 16 its activities' as well. Its own win. */
  readonly own: Totals;
  readonly activities: Totals;
  routeFile: string | null;
}

/**
 * Reads Apple Health's export.xml as it arrives, in pieces of any size. It keeps each
 * workout, and every heart rate reading in compact arrays, because the readings come
 * before the workouts in the file. `finish` gives each workout the readings in its window.
 */
export class HealthExportReader {
  private readonly scanner: XmlScanner;
  private readonly workouts: Array<Omit<HealthWorkout, "heartRate">> = [];
  private skipped = 0;
  private isHealthExport = false;
  private workout: OpenWorkout | undefined;
  private inRoute = false;
  private heartTimes = new Float64Array(4096);
  private heartBpm = new Uint16Array(4096);
  private heartCount = 0;

  constructor() {
    this.scanner = new XmlScanner({
      open: (name, attributes, selfClosing) => this.open(name, attributes, selfClosing),
      close: (name) => this.close(name),
    });
  }

  push(chunk: string): void {
    this.scanner.push(chunk);
  }

  private open(name: string, raw: string, selfClosing: boolean) {
    switch (name) {
      case "HealthData":
        this.isHealthExport = true;
        return;
      case "Record":
        if (raw.includes(HEART_RATE)) this.heartRate(xmlAttributes(raw));
        return;
      case "Workout":
        this.workout = {
          attributes: xmlAttributes(raw),
          depth: 0,
          own: { distanceM: null, energyKcal: null },
          activities: { distanceM: null, energyKcal: null },
          routeFile: null,
        };
        if (selfClosing) this.close(name);
        return;
    }
    const workout = this.workout;
    if (workout === undefined) return;
    if (name === "WorkoutStatistics") {
      this.statistic(workout.depth === 0 ? workout.own : workout.activities, xmlAttributes(raw));
    } else if (name === "WorkoutRoute") {
      this.inRoute = !selfClosing;
    } else if (name === "FileReference" && this.inRoute) {
      workout.routeFile ??= xmlAttributes(raw)["path"] ?? null;
    }
    if (!selfClosing) workout.depth++;
  }

  private close(name: string) {
    if (name === "WorkoutRoute") this.inRoute = false;
    if (this.workout === undefined) return;
    if (name !== "Workout" || this.workout.depth > 0) {
      this.workout.depth--;
      return;
    }
    const { attributes, own, activities, routeFile } = this.workout;
    this.workout = undefined;
    const start = parseHealthDate(attributes["startDate"]);
    const end = parseHealthDate(attributes["endDate"]);
    const durationS =
      scaled(attributes["duration"], attributes["durationUnit"], SECONDS) ??
      (start !== null && end !== null ? (end.at - start.at) / 1000 : null);
    const candidate = {
      activityType: attributes["workoutActivityType"],
      sourceName: attributes["sourceName"] ?? "",
      startedAt: start?.at,
      endedAt: end?.at,
      localHour: start?.localHour,
      durationS,
      distanceM:
        own.distanceM ??
        activities.distanceM ??
        scaled(attributes["totalDistance"], attributes["totalDistanceUnit"], METRES),
      energyKcal:
        own.energyKcal ??
        activities.energyKcal ??
        scaled(attributes["totalEnergyBurned"], attributes["totalEnergyBurnedUnit"], KCAL),
      routeFile,
      heartRate: [],
    };
    const decoded = decodeWorkout(candidate);
    if (Exit.isSuccess(decoded)) this.workouts.push(decoded.value);
    else this.skipped++;
  }

  private statistic(totals: Totals, attributes: Record<string, string>) {
    const type = attributes["type"] ?? "";
    const value = scaled(
      attributes["sum"],
      attributes["unit"],
      type.startsWith(DISTANCE) ? METRES : KCAL,
    );
    if (value === null) return;
    if (type.startsWith(DISTANCE)) totals.distanceM = (totals.distanceM ?? 0) + value;
    else if (type === ENERGY) totals.energyKcal = (totals.energyKcal ?? 0) + value;
  }

  private heartRate(attributes: Record<string, string>) {
    if (attributes["type"] !== HEART_RATE) return;
    const at = parseHealthDate(attributes["startDate"]);
    const bpm = Math.round(Number(attributes["value"]));
    if (at === null || !(bpm >= 20 && bpm <= 260)) return;
    if (this.heartCount === this.heartTimes.length) {
      const times = new Float64Array(this.heartTimes.length * 2);
      times.set(this.heartTimes);
      this.heartTimes = times;
      const beats = new Uint16Array(this.heartBpm.length * 2);
      beats.set(this.heartBpm);
      this.heartBpm = beats;
    }
    this.heartTimes[this.heartCount] = at.at;
    this.heartBpm[this.heartCount] = bpm;
    this.heartCount++;
  }

  /** Ends the file and gives each workout the heart rate readings from its start to its end. */
  finish(): HealthExport {
    this.scanner.end();
    const order = this.workouts
      .map((workout, index) => ({ workout, index }))
      .sort((a, b) => a.workout.startedAt - b.workout.startedAt);
    // The latest end among workouts up to each one, so a reading only looks back while one could still hold it.
    const latestEnd: Array<number> = [];
    for (const [position, { workout }] of order.entries()) {
      latestEnd.push(Math.max(workout.endedAt, latestEnd[position - 1] ?? 0));
    }
    const readings = order.map(() => [] as Array<{ recordedAt: number; bpm: number }>);
    for (let reading = 0; reading < this.heartCount; reading++) {
      const at = this.heartTimes[reading]!;
      let low = 0;
      let high = order.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (order[middle]!.workout.startedAt <= at) low = middle + 1;
        else high = middle;
      }
      for (let position = low - 1; position >= 0 && latestEnd[position]! >= at; position--) {
        if (order[position]!.workout.endedAt >= at) {
          readings[position]!.push({ recordedAt: at, bpm: this.heartBpm[reading]! });
        }
      }
    }
    const withHeart = Array.from<HealthWorkout>({ length: this.workouts.length });
    for (const [position, { workout, index }] of order.entries()) {
      withHeart[index] = {
        ...workout,
        heartRate: readings[position]!.sort((a, b) => a.recordedAt - b.recordedAt),
      };
    }
    return { workouts: withHeart, skipped: this.skipped, isHealthExport: this.isHealthExport };
  }
}
