import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Effect, Layer, ManagedRuntime } from "effect";

import { databaseLayer } from "./database.ts";
import { DurationSeconds } from "./duration.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import { contentFingerprint, Ids, seededRandom } from "./ids.ts";
import { manualClock } from "./manual-clock.ts";
import { ActivityRepository, type SetDraft } from "./repositories/activities.ts";
import { MADE_HERE, type Origin } from "./repositories/origin.ts";
import { ImportRepository, MeasurementRepository } from "./repositories/records.ts";
import { RoutineRepository } from "./repositories/routines.ts";
import {
  EpochMillis,
  Fingerprint,
  type MeasurementKind,
  type SetType,
  SourceIdentity,
} from "./schema.ts";
import { Sql, type SqlDriver } from "./sql.ts";

export const FIXTURE_SEED = 20_261_113;

const DAY = 86_400_000;
const END = Date.UTC(2026, 10, 1);
const START = END - 730 * DAY;

type Lift = {
  readonly id: string;
  readonly startKg: number | null;
  readonly reps: readonly [number, number];
  readonly seconds?: number;
};

const SPLITS: ReadonlyArray<{ readonly title: string; readonly lifts: ReadonlyArray<Lift> }> = [
  {
    title: "Push",
    lifts: [
      { id: "Barbell_Bench_Press_-_Medium_Grip", startKg: 70, reps: [5, 8] },
      { id: "Standing_Military_Press", startKg: 40, reps: [5, 8] },
      { id: "Incline_Dumbbell_Press", startKg: 24, reps: [8, 12] },
      { id: "Side_Lateral_Raise", startKg: 8, reps: [12, 15] },
      { id: "Triceps_Pushdown", startKg: 25, reps: [10, 15] },
      { id: "Dips_-_Triceps_Version", startKg: null, reps: [8, 15] },
    ],
  },
  {
    title: "Pull",
    lifts: [
      { id: "Barbell_Deadlift", startKg: 110, reps: [3, 6] },
      { id: "Pullups", startKg: null, reps: [5, 10] },
      { id: "Bent_Over_Barbell_Row", startKg: 60, reps: [6, 10] },
      { id: "Seated_Cable_Rows", startKg: 50, reps: [8, 12] },
      { id: "Face_Pull", startKg: 20, reps: [12, 15] },
      { id: "Hammer_Curls", startKg: 14, reps: [8, 12] },
    ],
  },
  {
    title: "Legs",
    lifts: [
      { id: "Barbell_Squat", startKg: 90, reps: [5, 8] },
      { id: "Romanian_Deadlift", startKg: 80, reps: [6, 10] },
      { id: "Leg_Press", startKg: 140, reps: [8, 12] },
      { id: "Lying_Leg_Curls", startKg: 35, reps: [10, 12] },
      { id: "Standing_Calf_Raises", startKg: 60, reps: [10, 15] },
      { id: "Plank", startKg: null, reps: [0, 0], seconds: 60 },
    ],
  },
];

const MEASURED: ReadonlyArray<{
  readonly kind: MeasurementKind;
  readonly everyDays: number;
  readonly start: number;
  readonly drift: number;
}> = [
  { kind: "body_weight", everyDays: 7, start: 84, drift: -4 },
  { kind: "body_fat", everyDays: 30, start: 19, drift: -3 },
  { kind: "waist", everyDays: 30, start: 88, drift: -4 },
];

const roundTo = (value: number, step: number) => Math.round(value / step) * step;

const generate = (
  seed: number,
  workouts: number,
  clock: { readonly set: (millis: number) => Effect.Effect<void> },
  imported: boolean,
) =>
  Effect.gen(function* () {
    const random = seededRandom(seed);
    const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
    const activities = yield* ActivityRepository;
    const measurements = yield* MeasurementRepository;
    const routines = yield* RoutineRepository;

    yield* clock.set(START - DAY);
    const batch = imported
      ? yield* Effect.flatMap(Effect.service(ImportRepository), (imports) => imports.create("hevy"))
      : null;
    // A Hevy workout's identity is its start time, as D2 imports it.
    const originOf = (startedAt: number, title: string): Origin =>
      batch === null
        ? MADE_HERE
        : {
            source: "hevy",
            sourceId: SourceIdentity.make(new Date(startedAt).toISOString()),
            fingerprint: Fingerprint.make(contentFingerprint({ startedAt, title })),
            importBatchId: batch,
          };
    const folderId = yield* routines.createFolder({ name: "Push pull legs", position: 0 });
    for (const [position, split] of SPLITS.entries()) {
      yield* routines.createRoutine({
        folderId,
        title: split.title,
        notes: "",
        position,
        exercises: split.lifts.slice(0, 5).map((lift) => ({
          exerciseId: libraryExerciseId(lift.id),
          supersetGroup: null,
          restS: DurationSeconds.make(120),
          notes: "",
          sets: Array.from({ length: 3 }, () => ({
            setType: "normal" as const,
            weightKg: null,
            repsMin: lift.seconds === undefined ? lift.reps[0] : null,
            repsMax: lift.seconds === undefined ? lift.reps[1] : null,
            durationS: lift.seconds === undefined ? null : DurationSeconds.make(lift.seconds),
            distanceM: null,
          })),
        })),
      });
    }

    for (let index = 0; index < workouts; index++) {
      const progress = index / workouts;
      const split = SPLITS[index % SPLITS.length]!;
      const day = Math.floor(index * (730 / workouts)) + between(0, 1);
      const startedAt = START + day * DAY + between(6, 19) * 3_600_000 + between(0, 59) * 60_000;
      const durationS = between(45, 85) * 60;
      const lifts = split.lifts.slice(0, between(4, 6));
      yield* clock.set(startedAt + durationS * 1000);
      yield* activities.create({
        kind: "strength",
        startedAt: EpochMillis.make(startedAt),
        durationS: DurationSeconds.make(durationS),
        title: split.title,
        notes: "",
        energyKcal: null,
        audience: "only_you",
        hiddenFields: [],
        origin: originOf(startedAt, split.title),
        track: null,
        exercises: lifts.map((lift, position) => {
          const count = between(3, 5);
          const workingKg =
            lift.startKg === null ? null : roundTo(lift.startKg * (1 + 0.3 * progress), 2.5);
          return {
            exerciseId: libraryExerciseId(lift.id),
            supersetGroup: null,
            notes: "",
            sets: Array.from({ length: count }, (_, setIndex): SetDraft => {
              const warmUp = position === 0 && setIndex === 0;
              const last = setIndex === count - 1;
              const roll = random();
              const setType: SetType = warmUp
                ? "warm_up"
                : last && roll < 0.1
                  ? "failure"
                  : last && roll < 0.14
                    ? "drop"
                    : "normal";
              return {
                setType,
                weightKg:
                  workingKg === null ? null : warmUp ? roundTo(workingKg * 0.5, 2.5) : workingKg,
                reps: lift.seconds === undefined ? between(lift.reps[0], lift.reps[1]) : null,
                durationS:
                  lift.seconds === undefined
                    ? null
                    : DurationSeconds.make(lift.seconds + between(0, 6) * 5),
                distanceM: null,
                rpe: !warmUp && random() < 0.3 ? 7 + between(0, 5) * 0.5 : null,
              };
            }),
          };
        }),
      });
    }

    for (const measured of MEASURED) {
      for (let day = 0; day < 730; day += measured.everyDays) {
        const measuredAt = START + day * DAY + 7 * 3_600_000;
        const noise = (random() - 0.5) * measured.start * 0.01;
        yield* clock.set(measuredAt);
        yield* measurements.create({
          kind: measured.kind,
          measuredAt: EpochMillis.make(measuredAt),
          value: Math.round((measured.start + measured.drift * (day / 730) + noise) * 10) / 10,
          origin: MADE_HERE,
        });
      }
    }
  });

export interface FixtureSummary {
  readonly workouts: number;
  readonly sets: number;
  readonly exercises: number;
  readonly routines: number;
  readonly measurements: number;
  /** SHA-256 of the key columns of every activity, set and measurement, in ID order. */
  readonly checksum: string;
}

const KEY_COLUMNS = [
  "SELECT id, kind, started_at, duration_s, title, updated_at FROM activity ORDER BY id",
  "SELECT id, activity_id, exercise_id, position FROM activity_exercise ORDER BY id",
  "SELECT id, activity_exercise_id, position, set_type, weight_kg, reps, duration_s, rpe FROM activity_set ORDER BY id",
  "SELECT id, kind, measured_at, value FROM measurement ORDER BY id",
];

export const summarizeDatabase = Effect.gen(function* () {
  const sql = yield* Sql;
  const count = (table: string) =>
    Effect.map(sql.all(`SELECT count(*) AS n FROM ${table} WHERE deleted_at IS NULL`), (rows) =>
      Number(rows[0]?.["n"] ?? 0),
    );
  const hash = sha256.create();
  for (const query of KEY_COLUMNS) {
    for (const row of yield* sql.all(query)) {
      hash.update(utf8ToBytes(`${JSON.stringify(Object.values(row))}\n`));
    }
  }
  return {
    workouts: yield* count("activity"),
    sets: yield* count("activity_set"),
    exercises: yield* count("exercise"),
    routines: yield* count("routine"),
    measurements: yield* count("measurement"),
    checksum: bytesToHex(hash.digest()),
  } satisfies FixtureSummary;
});

/**
 * Fills an empty database with two years of strength training: about 300 workouts and
 * 6,000 sets, a routine folder, and body measurements. The same seed gives the same rows.
 * With `imported`, the workouts arrive as one Hevy import instead of being logged here.
 */
export const buildFixture = (
  driver: SqlDriver,
  seed = FIXTURE_SEED,
  workouts = 300,
  { imported = false }: { readonly imported?: boolean } = {},
) => {
  const clock = manualClock(START - DAY);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(databaseLayer(driver, Ids.layerSeeded(seed)), clock.layer),
  );
  return runtime
    .runPromise(Effect.andThen(generate(seed, workouts, clock, imported), summarizeDatabase))
    .finally(() => runtime.dispose());
};
