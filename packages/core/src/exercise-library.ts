import { Schema } from "effect";

import { importedId } from "./ids.ts";
import entries from "./exercise-library.json" with { type: "json" };
import {
  EpochMillis,
  type Equipment,
  type ExerciseCategory,
  ExerciseId,
  type Muscle,
  SourceIdentity,
} from "./schema.ts";
import { TABLES } from "./table.ts";

const LibraryMuscle = Schema.Literals([
  "abdominals",
  "abductors",
  "adductors",
  "biceps",
  "calves",
  "chest",
  "forearms",
  "glutes",
  "hamstrings",
  "lats",
  "lower back",
  "middle back",
  "neck",
  "quadriceps",
  "shoulders",
  "traps",
  "triceps",
]);

const LibraryEquipment = Schema.NullOr(
  Schema.Literals([
    "bands",
    "barbell",
    "body only",
    "cable",
    "dumbbell",
    "e-z curl bar",
    "exercise ball",
    "foam roll",
    "kettlebells",
    "machine",
    "medicine ball",
    "other",
  ]),
);

const LibraryCategory = Schema.Literals([
  "cardio",
  "olympic weightlifting",
  "plyometrics",
  "powerlifting",
  "stretching",
  "strength",
  "strongman",
]);

/** One exercise as free-exercise-db (github.com/yuhonas/free-exercise-db, Unlicense) lists it. */
export const LibraryEntry = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  category: LibraryCategory,
  equipment: LibraryEquipment,
  primaryMuscles: Schema.Array(LibraryMuscle),
  secondaryMuscles: Schema.Array(LibraryMuscle),
});
export type LibraryEntry = typeof LibraryEntry.Type;

export const MUSCLE_FROM_LIBRARY: Readonly<Record<typeof LibraryMuscle.Type, Muscle>> = {
  abdominals: "abdominals",
  abductors: "abductors",
  adductors: "adductors",
  biceps: "biceps",
  calves: "calves",
  chest: "chest",
  forearms: "forearms",
  glutes: "glutes",
  hamstrings: "hamstrings",
  lats: "lats",
  "lower back": "lower_back",
  "middle back": "upper_back",
  neck: "neck",
  quadriceps: "quadriceps",
  shoulders: "shoulders",
  traps: "traps",
  triceps: "triceps",
};

export const EQUIPMENT_FROM_LIBRARY: Readonly<
  Record<NonNullable<typeof LibraryEquipment.Type>, Equipment>
> = {
  bands: "band",
  barbell: "barbell",
  "body only": "none",
  cable: "cable",
  dumbbell: "dumbbell",
  "e-z curl bar": "ez_bar",
  "exercise ball": "exercise_ball",
  "foam roll": "foam_roller",
  kettlebells: "kettlebell",
  machine: "machine",
  "medicine ball": "medicine_ball",
  other: "other",
};

export const CATEGORY_FROM_LIBRARY: Readonly<
  Record<typeof LibraryCategory.Type, ExerciseCategory>
> = {
  cardio: "cardio",
  "olympic weightlifting": "olympic_weightlifting",
  plyometrics: "plyometrics",
  powerlifting: "powerlifting",
  stretching: "stretching",
  strength: "strength",
  strongman: "strongman",
};

export interface LibraryExercise {
  readonly id: ExerciseId;
  readonly sourceId: SourceIdentity;
  readonly name: string;
  readonly category: ExerciseCategory;
  readonly equipment: Equipment;
  readonly primaryMuscles: ReadonlyArray<Muscle>;
  readonly secondaryMuscles: ReadonlyArray<Muscle>;
}

/** The same library exercise has the same ID on every device. */
export const libraryExerciseId = (libraryId: string): ExerciseId =>
  ExerciseId.make(importedId(TABLES.exercise.name, "library", libraryId));

const unique = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

export const fromLibraryEntry = (entry: LibraryEntry): LibraryExercise => ({
  id: libraryExerciseId(entry.id),
  sourceId: SourceIdentity.make(entry.id),
  name: entry.name,
  category: CATEGORY_FROM_LIBRARY[entry.category],
  equipment: entry.equipment === null ? "none" : EQUIPMENT_FROM_LIBRARY[entry.equipment],
  primaryMuscles: unique(entry.primaryMuscles.map((muscle) => MUSCLE_FROM_LIBRARY[muscle])),
  secondaryMuscles: unique(entry.secondaryMuscles.map((muscle) => MUSCLE_FROM_LIBRARY[muscle])),
});

/** Every install stores the same library rows, so an export or sync never sees them as changed. */
export const LIBRARY_UPDATED_AT = EpochMillis.make(0);

/** The bundled library's IDs, read without decoding the library. */
export const libraryIds = (): ReadonlyArray<string> => entries.map((entry) => entry.id);

/** The bundled library, parsed and mapped to svett's muscles and equipment. */
export const exerciseLibrary = (): ReadonlyArray<LibraryExercise> =>
  Schema.decodeUnknownSync(Schema.Array(LibraryEntry))(entries).map(fromLibraryEntry);
