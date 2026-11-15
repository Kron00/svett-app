import { formatDuration } from "./duration.ts";
import { type MuscleShare, muscleSplit } from "./muscle-split.ts";
import type { RecordKind } from "./records.ts";
import type { ActivityDetail } from "./repositories/activities.ts";
import type { RoutineDraft } from "./repositories/routines.ts";
import type {
  Activity,
  ActivityExercise,
  ActivitySet,
  Exercise,
  ExerciseId,
  Muscle,
} from "./schema.ts";
import { formatSetLoad, formatWeightKg, setBadge, type SetBadge } from "./set-format.ts";
import { type SupersetPlace, supersetPlaces } from "./superset.ts";
import { type WeightUnit, weightIn } from "./weight-unit.ts";

type VolumeSet = Pick<ActivitySet, "setType" | "weightKg" | "reps">;

/** Weight times reps over every set except warm-ups. */
export const workingVolumeKg = (sets: ReadonlyArray<VolumeSet>): number =>
  sets.reduce(
    (total, set) =>
      set.setType === "warm_up" ? total : total + (set.weightKg ?? 0) * (set.reps ?? 0),
    0,
  );

/** "12,450 kg" or "27,448 lb", the way a workout's volume reads in history. */
export const formatVolumeKg = (kg: number, unit: WeightUnit): string =>
  `${String(Math.round(weightIn(kg, unit))).replaceAll(/\B(?=(\d{3})+$)/g, ",")} ${unit}`;

/** A workout's length to the minute, such as "58 min" or "1 h 5 min". */
export const formatWorkoutDuration = (seconds: number): string => {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
};

const formatDistance = (metres: number): string =>
  metres >= 1000 ? `${formatWeightKg(metres / 1000)} km` : `${formatWeightKg(metres)} m`;

/** Everything a set recorded, such as "80 kg × 8 · RPE 8", "1:05" or "20 kg · 1:05". */
export const describeSet = (
  set: Pick<ActivitySet, "weightKg" | "reps" | "durationS" | "distanceM"> &
    Partial<Pick<ActivitySet, "rpe">>,
  unit: WeightUnit = "kg",
): string =>
  [
    formatSetLoad(set.weightKg, set.reps, unit),
    set.durationS === null ? null : formatDuration(set.durationS),
    set.distanceM === null ? null : formatDistance(set.distanceM),
    set.rpe === null || set.rpe === undefined ? null : `RPE ${set.rpe}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

const DELETED_EXERCISE = "Deleted exercise";

/** The exercises a history row names, such as "Squat, Leg Press and 3 more". */
export const exerciseNameList = (names: ReadonlyArray<string>, shown = 2): string => {
  if (names.length <= shown + 1) {
    return names.length <= 1
      ? (names[0] ?? "No exercises")
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
};

export type WorkoutSummary = {
  readonly activity: Activity;
  readonly exerciseNames: ReadonlyArray<string>;
  readonly setCount: number;
  readonly volumeKg: number;
};

export const summarizeWorkout = (
  detail: ActivityDetail,
  names: ReadonlyMap<ExerciseId, string>,
): WorkoutSummary => {
  const sets = detail.exercises.flatMap((entry) => entry.sets);
  return {
    activity: detail.activity,
    exerciseNames: detail.exercises.map(
      (entry) => names.get(entry.exercise.exerciseId) ?? DELETED_EXERCISE,
    ),
    setCount: sets.length,
    volumeKg: workingVolumeKg(sets),
  };
};

export type WorkoutSet = ActivitySet & {
  readonly badge: SetBadge;
  readonly text: string;
  readonly records: ReadonlyArray<RecordKind>;
};

export type WorkoutExercise = {
  readonly exercise: ActivityExercise;
  /** Where it sits in a superset, or null. */
  readonly superset: SupersetPlace | null;
  readonly name: string;
  readonly primaryMuscles: ReadonlyArray<Muscle>;
  readonly sets: ReadonlyArray<WorkoutSet>;
};

/** One past workout as its detail screen shows it. */
export type WorkoutView = {
  readonly activity: Activity;
  readonly exercises: ReadonlyArray<WorkoutExercise>;
  readonly split: ReadonlyArray<MuscleShare>;
  readonly setCount: number;
  readonly volumeKg: number;
  readonly recordCount: number;
};

/**
 * Puts a workout together for its detail screen. `records` holds the records
 * each set set, keyed by set ID, as workoutRecords finds them.
 */
export const describeWorkout = (
  detail: ActivityDetail,
  library: ReadonlyMap<ExerciseId, Exercise>,
  records: ReadonlyMap<string, ReadonlyArray<RecordKind>>,
): WorkoutView => {
  const supersets = supersetPlaces(detail.exercises.map(({ exercise }) => exercise));
  const exercises = detail.exercises.map(({ exercise, sets }, index): WorkoutExercise => {
    const info = library.get(exercise.exerciseId);
    let normal = 0;
    return {
      exercise,
      superset: supersets[index] ?? null,
      name: info?.name ?? DELETED_EXERCISE,
      primaryMuscles: info?.primaryMuscles ?? [],
      sets: sets.map((set) => {
        if (set.setType === "normal") normal++;
        return {
          ...set,
          badge: setBadge(set.setType, normal),
          text: describeSet(set),
          records: records.get(set.id) ?? [],
        };
      }),
    };
  });

  const sets = detail.exercises.flatMap((entry) => entry.sets);
  return {
    activity: detail.activity,
    exercises,
    split: muscleSplit(exercises),
    setCount: sets.length,
    volumeKg: workingVolumeKg(sets),
    recordCount: [...records.values()].reduce((count, kinds) => count + kinds.length, 0),
  };
};

/**
 * A routine with the workout's exercises, in order, and each set as its target:
 * the same type, weight, time and distance, with the reps done as the rep target.
 */
export const routineFromWorkout = (detail: ActivityDetail, position: number): RoutineDraft => ({
  folderId: null,
  title: detail.activity.title.trim() === "" ? "Workout" : detail.activity.title.trim(),
  notes: "",
  position,
  exercises: detail.exercises.map(({ exercise, sets }) => ({
    exerciseId: exercise.exerciseId,
    supersetGroup: exercise.supersetGroup,
    restS: exercise.restS,
    notes: exercise.notes,
    sets: sets.map((set) => ({
      setType: set.setType,
      weightKg: set.weightKg,
      repsMin: set.reps,
      repsMax: set.reps,
      durationS: set.durationS,
      distanceM: set.distanceM,
    })),
  })),
});
