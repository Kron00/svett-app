import { libraryExerciseId } from "./exercise-library.ts";
import type { PerformedSet } from "./performed-set.ts";
import {
  ActivityExerciseId,
  ActivityId,
  ActivitySetId,
  EpochMillis,
  type Equipment,
  type ExerciseId,
  type SetType,
} from "./schema.ts";

export const BENCH = libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip");
export const SQUAT = libraryExerciseId("Barbell_Squat");
export const DIPS = libraryExerciseId("Dips_-_Triceps_Version");
export const PULLUPS = libraryExerciseId("Pullups");
export const PLANK = libraryExerciseId("Plank");

const uuid = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The squat of a workout in progress, as a rest names the set it waits for. */
export const SQUAT_NEXT = {
  exercise: "Barbell Squat",
  activityId: ActivityId.make(uuid("00000000", 9001)),
  activityExerciseId: ActivityExerciseId.make(uuid("00000000", 9002)),
};

const EQUIPMENT: ReadonlyMap<ExerciseId, Equipment> = new Map([
  [BENCH, "barbell"],
  [SQUAT, "barbell"],
  [DIPS, "none"],
  [PULLUPS, "none"],
  [PLANK, "none"],
]);

let nextSet = 0;

/** Sets for one workout, in the order they were logged. Unset values are null. */
export const workoutSets = (
  workout: number,
  startedAt: Date,
  sets: ReadonlyArray<{
    readonly exercise: ExerciseId;
    readonly type?: SetType;
    readonly kg?: number;
    readonly reps?: number;
    readonly seconds?: number;
    readonly metres?: number;
  }>,
): ReadonlyArray<PerformedSet> =>
  sets.map((set) => ({
    setId: ActivitySetId.make(uuid("00000000", ++nextSet)),
    activityId: ActivityId.make(uuid("11111111", workout)),
    exerciseId: set.exercise,
    equipment: EQUIPMENT.get(set.exercise) ?? "other",
    startedAt: EpochMillis.make(startedAt.getTime()),
    setType: set.type ?? "normal",
    weightKg: set.kg ?? null,
    reps: set.reps ?? null,
    durationS: set.seconds ?? null,
    distanceM: set.metres ?? null,
  }));
