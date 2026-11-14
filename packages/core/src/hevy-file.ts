import { Data, Result, Schema } from "effect";

import { contentFingerprint } from "./ids.ts";
import { Rpe, type SetType } from "./schema.ts";

/**
 * Hevy's workout export (Settings, Export & Import Data, Export Workouts) is a CSV with one row
 * per set. These are the columns svett reads. Any other column is ignored, so a later Hevy
 * export that adds columns still imports.
 */
export const HEVY_COLUMNS = {
  required: ["title", "start_time", "exercise_title"],
  optional: [
    "end_time",
    "description",
    "superset_id",
    "exercise_notes",
    "set_index",
    "set_type",
    "weight_kg",
    "weight_lbs",
    "reps",
    "distance_km",
    "distance_miles",
    "duration_seconds",
    "rpe",
  ],
} as const;

type Column = (typeof HEVY_COLUMNS)["required" | "optional"][number];

const KG_PER_LB = 0.45359237;
const METRES_PER_MILE = 1_609.344;

export class HevyFileError extends Data.TaggedError("HevyFileError")<{
  readonly reason: "not_hevy" | "invalid";
  readonly message: string;
}> {}

/** A clock time as the file writes it, with no time zone unless the file gives one. */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The instant a clock time without a zone stands for, such as in the phone's own zone. */
export type ToInstant = (time: WallTime) => number;

/** Reads a clock time as if it were UTC. Tests use it, so they pass in every time zone. */
export const wallTimeAsUtc: ToInstant = (time) =>
  Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);

export interface HevySet {
  readonly setType: SetType;
  readonly weightKg: number | null;
  readonly reps: number | null;
  readonly durationS: number | null;
  readonly distanceM: number | null;
  readonly rpe: number | null;
}

export interface HevyExercise {
  readonly name: string;
  readonly supersetGroup: number | null;
  readonly notes: string;
  readonly sets: ReadonlyArray<HevySet>;
}

export interface HevyWorkout {
  /**
   * The start time as the file writes it, normalized. A Hevy workout has no ID, so this is
   * its identity. It stays the clock time, so moving the phone to another zone changes nothing.
   */
  readonly start: string;
  readonly startedAt: number;
  readonly durationS: number;
  readonly title: string;
  readonly description: string;
  readonly exercises: ReadonlyArray<HevyExercise>;
  /** The workout's place among the file's workouts, from 0. */
  readonly position: number;
  /** Changes when anything Hevy holds for the workout changes, other than its start. */
  readonly fingerprint: string;
}

export interface HevyFile {
  readonly workouts: ReadonlyArray<HevyWorkout>;
  readonly sets: number;
  /** Rows that record no reps, time or distance. svett has no such set, so it leaves them out. */
  readonly emptySets: number;
  /** True when the times carry no zone and were read in the phone's zone. */
  readonly localTimes: boolean;
}

/**
 * Splits CSV text into rows of fields, following RFC 4180: quoted fields, doubled quotes inside
 * them, commas and line breaks inside them, CRLF line ends, and a leading byte order mark.
 * Blank lines are dropped. Returns undefined when the text ends inside a quoted field.
 */
export const parseCsv = (text: string): ReadonlyArray<ReadonlyArray<string>> | undefined => {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let field = "";
  let quoted = false;
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    field = "";
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") endRow();
    else if (char === "\r") {
      if (source[index + 1] === "\n") index++;
      endRow();
    } else field += char;
  }
  if (quoted) return undefined;
  if (field !== "" || row.length > 0) endRow();
  return rows;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

const validTime = (time: WallTime): WallTime | undefined => {
  const days = new Date(Date.UTC(time.year, time.month, 0)).getUTCDate();
  return time.month >= 1 &&
    time.month <= 12 &&
    time.day >= 1 &&
    time.day <= days &&
    time.hour <= 23 &&
    time.minute <= 59 &&
    time.second <= 59
    ? time
    : undefined;
};

export interface ReadTime {
  /** The time normalized, such as 2024-01-15T18:30:00, with the file's zone when it has one. */
  readonly text: string;
  readonly instant: number;
  /** The clock time read as UTC, so the gap between two times does not depend on the zone. */
  readonly wall: number;
  readonly zoned: boolean;
}

/**
 * Reads a time from the file. Hevy writes "15 Jan 2024, 18:30" in the phone's clock time, with
 * no zone. An ISO time such as 2024-01-15 18:30:00 is read too, and keeps its zone if it has one.
 */
export const readTime = (raw: string, toInstant: ToInstant): ReadTime | undefined => {
  const value = raw.trim();
  const hevy =
    /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      value,
    );
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      value,
    );
  let time: WallTime | undefined;
  let zone: string | undefined;
  if (hevy) {
    const month = MONTHS.indexOf((hevy[2] ?? "").toLowerCase()) + 1;
    if (month === 0) return undefined;
    time = validTime({
      year: Number(hevy[3]),
      month,
      day: Number(hevy[1]),
      hour: Number(hevy[4]),
      minute: Number(hevy[5]),
      second: Number(hevy[6] ?? 0),
    });
  } else if (iso) {
    time = validTime({
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      hour: Number(iso[4]),
      minute: Number(iso[5]),
      second: Number(iso[6] ?? 0),
    });
    zone = iso[7]?.toUpperCase();
  }
  if (time === undefined) return undefined;
  const text = `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
  const wall = wallTimeAsUtc(time);
  if (zone === undefined) return { text, instant: toInstant(time), wall, zoned: false };
  const offset = zone === "Z" ? "+00:00" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const minutes =
    (offset.startsWith("-") ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4)));
  return {
    text: `${text}${offset}`,
    instant: wall - minutes * 60_000,
    wall: wall - minutes * 60_000,
    zoned: true,
  };
};

const SET_TYPES: Readonly<Record<string, SetType>> = {
  normal: "normal",
  warmup: "warm_up",
  warm_up: "warm_up",
  failure: "failure",
  dropset: "drop",
  drop: "drop",
};

const number = (raw: string | undefined): number | null => {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const nonNegative = (value: number | null) => (value !== null && value >= 0 ? value : null);
const rounded = (value: number | null, places: number) =>
  value === null ? null : Math.round(value * 10 ** places) / 10 ** places;
const isRpe = Schema.is(Rpe);

/**
 * Reads a Hevy workout export. A row is one set. Rows with the same title, start and end make
 * one workout, and within it a run of rows with the same exercise makes one exercise, which
 * starts again when the set index does not go up. A file whose columns or times svett cannot
 * read is refused whole, rather than half imported.
 */
export const decodeHevyFile = (
  text: string,
  toInstant: ToInstant,
): Result.Result<HevyFile, HevyFileError> => {
  const notHevy = (message: string) =>
    Result.fail(new HevyFileError({ reason: "not_hevy", message }));
  const invalid = (message: string) =>
    Result.fail(new HevyFileError({ reason: "invalid", message }));

  const rows = parseCsv(text);
  if (rows === undefined)
    return invalid("The file ends inside a quoted field, so it looks cut off.");
  const [header, ...body] = rows;
  if (header === undefined) return notHevy("The file is empty.");
  const index = new Map(header.map((name, at) => [name.trim().toLowerCase(), at]));
  const missing = HEVY_COLUMNS.required.filter((name) => !index.has(name));
  if (missing.length > 0) {
    return notHevy(`This is not a Hevy workout export. It has no ${missing.join(", ")} column.`);
  }
  const get = (row: ReadonlyArray<string>, column: Column) => {
    const at = index.get(column);
    return at === undefined ? undefined : row[at];
  };

  type Building = {
    start: ReadTime;
    end: ReadTime | undefined;
    title: string;
    description: string;
    exercises: Array<{
      name: string;
      supersetGroup: number | null;
      notes: string;
      sets: Array<HevySet>;
      lastIndex: number | null;
    }>;
  };
  const workouts = new Map<string, Building>();
  let sets = 0;
  let emptySets = 0;
  let localTimes = false;

  for (const [at, row] of body.entries()) {
    const line = at + 2;
    const startRaw = get(row, "start_time") ?? "";
    const start = readTime(startRaw, toInstant);
    if (start === undefined || start.instant < 0) {
      return invalid(`Row ${line} has a start time svett cannot read, "${startRaw}".`);
    }
    if (!start.zoned) localTimes = true;
    const endRaw = get(row, "end_time")?.trim() ?? "";
    const end = endRaw === "" ? undefined : readTime(endRaw, toInstant);
    if (endRaw !== "" && end === undefined) {
      return invalid(`Row ${line} has an end time svett cannot read, "${endRaw}".`);
    }
    const title = get(row, "title")?.trim() ?? "";
    const key = JSON.stringify([start.text, title, end?.text ?? ""]);
    const workout = workouts.get(key) ?? {
      start,
      end,
      title,
      description: get(row, "description") ?? "",
      exercises: [],
    };
    workouts.set(key, workout);

    const name = get(row, "exercise_title")?.trim() ?? "";
    if (name === "") return invalid(`Row ${line} has no exercise.`);
    const setIndex = number(get(row, "set_index"));
    const last = workout.exercises.at(-1);
    const exercise =
      last !== undefined &&
      last.name === name &&
      (setIndex === null || last.lastIndex === null || setIndex > last.lastIndex)
        ? last
        : {
            name,
            supersetGroup: nonNegative(number(get(row, "superset_id"))),
            notes: get(row, "exercise_notes") ?? "",
            sets: [],
            lastIndex: null,
          };
    if (exercise !== last) workout.exercises.push(exercise);
    exercise.lastIndex = setIndex;

    const kg = number(get(row, "weight_kg"));
    const lbs = number(get(row, "weight_lbs"));
    const km = number(get(row, "distance_km"));
    const miles = number(get(row, "distance_miles"));
    const reps = number(get(row, "reps"));
    const rpe = number(get(row, "rpe"));
    const set: HevySet = {
      setType: SET_TYPES[(get(row, "set_type") ?? "").trim().toLowerCase()] ?? "normal",
      weightKg: nonNegative(rounded(kg ?? (lbs === null ? null : lbs * KG_PER_LB), 3)),
      reps: reps !== null && Number.isInteger(reps) && reps >= 0 ? reps : null,
      durationS: nonNegative(number(get(row, "duration_seconds"))),
      distanceM: nonNegative(
        rounded(km === null ? (miles === null ? null : miles * METRES_PER_MILE) : km * 1_000, 1),
      ),
      rpe: rpe !== null && isRpe(rpe) ? rpe : null,
    };
    if (set.reps === null && set.durationS === null && set.distanceM === null) emptySets++;
    else {
      exercise.sets.push(set);
      sets++;
    }
  }

  return Result.succeed({
    workouts: [...workouts.values()].map((workout, position) => {
      const exercises = workout.exercises.map(
        ({ name, supersetGroup, notes, sets: exerciseSets }): HevyExercise => ({
          name,
          supersetGroup,
          notes,
          sets: exerciseSets,
        }),
      );
      const durationS =
        workout.end === undefined
          ? 0
          : Math.max(0, Math.round((workout.end.wall - workout.start.wall) / 1_000));
      return {
        start: workout.start.text,
        startedAt: workout.start.instant,
        durationS,
        title: workout.title,
        description: workout.description,
        exercises,
        position,
        fingerprint: contentFingerprint({
          title: workout.title,
          description: workout.description,
          durationS,
          exercises,
        }),
      };
    }),
    sets,
    emptySets,
    localTimes,
  });
};
