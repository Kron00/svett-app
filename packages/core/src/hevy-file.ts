import { Data, Option, Result, Schema, SchemaTransformation } from "effect";

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

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A plain decimal, so text such as "12kg", "1e3" or "0x10" is refused rather than guessed at. */
const decimal = (to: typeof NonNegative) =>
  Schema.decodeUnknownOption(
    Schema.String.check(Schema.isPattern(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/)).pipe(
      Schema.decodeTo(to, SchemaTransformation.numberFromString),
    ),
  );

/** The numeric columns, each with the values svett can store for it. */
const NUMBER_COLUMNS = {
  set_index: decimal(NonNegativeInt),
  superset_id: decimal(NonNegativeInt),
  weight_kg: decimal(NonNegative),
  weight_lbs: decimal(NonNegative),
  reps: decimal(NonNegativeInt),
  distance_km: decimal(NonNegative),
  distance_miles: decimal(NonNegative),
  duration_seconds: decimal(NonNegative),
  rpe: decimal(Rpe),
} satisfies Partial<Record<Column, unknown>>;

type NumberColumn = keyof typeof NUMBER_COLUMNS;
const NUMBER_COLUMN_NAMES = Object.keys(NUMBER_COLUMNS) as ReadonlyArray<NumberColumn>;

const rounded = (value: number | null, places: number) =>
  value === null ? null : Math.round(value * 10 ** places) / 10 ** places;

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
    const numbers: Partial<Record<NumberColumn, number | null>> = {};
    for (const column of NUMBER_COLUMN_NAMES) {
      const raw = get(row, column)?.trim() ?? "";
      const value = raw === "" ? Option.some(null) : NUMBER_COLUMNS[column](raw);
      if (Option.isNone(value)) {
        return invalid(`Row ${line} has a ${column} svett cannot read, "${raw}".`);
      }
      numbers[column] = value.value;
    }
    const number = (column: NumberColumn) => numbers[column] ?? null;
    const setIndex = number("set_index");
    const last = workout.exercises.at(-1);
    const exercise =
      last !== undefined &&
      last.name === name &&
      (setIndex === null || last.lastIndex === null || setIndex > last.lastIndex)
        ? last
        : {
            name,
            supersetGroup: number("superset_id"),
            notes: get(row, "exercise_notes") ?? "",
            sets: [],
            lastIndex: null,
          };
    if (exercise !== last) workout.exercises.push(exercise);
    exercise.lastIndex = setIndex;

    const kg = number("weight_kg");
    const lbs = number("weight_lbs");
    const km = number("distance_km");
    const miles = number("distance_miles");
    const set: HevySet = {
      setType: SET_TYPES[(get(row, "set_type") ?? "").trim().toLowerCase()] ?? "normal",
      weightKg: rounded(kg ?? (lbs === null ? null : lbs * KG_PER_LB), 3),
      reps: number("reps"),
      durationS: number("duration_seconds"),
      distanceM: rounded(
        km === null ? (miles === null ? null : miles * METRES_PER_MILE) : km * 1_000,
        1,
      ),
      rpe: number("rpe"),
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

const counted = (count: number, one: string, other: string) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : other}`;

/** What a Hevy file holds, in one sentence for the import preview. */
export const hevyFileLabel = (file: HevyFile): string => {
  const holds = `A Hevy export with ${counted(file.workouts.length, "workout", "workouts")} and ${counted(file.sets, "set", "sets")}.`;
  if (file.emptySets === 0) return holds;
  return `${holds} ${file.emptySets === 1 ? "One set records" : `${file.emptySets.toLocaleString("en-US")} sets record`} no reps, time or distance, so svett leaves ${file.emptySets === 1 ? "it" : "them"} out.`;
};
