import { Context, Effect, Layer, Option } from "effect";

import {
  describeWorkout,
  routineFromWorkout,
  summarizeWorkout,
  type WorkoutView,
} from "../history.ts";
import type { ScoredSet } from "../records.ts";
import type { Activity, ActivityExercise, ActivityId, ExerciseId } from "../schema.ts";
import { Sql } from "../sql.ts";
import { RowNotFoundError, selectById, selectRows, TABLES } from "../table.ts";
import { type ActivityDetail, ActivityRepository } from "./activities.ts";
import { RoutineRepository } from "./routines.ts";

const inList = (column: string) => `${column} IN (SELECT value FROM json_each(?))`;

const groupBy = <A, K>(items: ReadonlyArray<A>, key: (item: A) => K) => {
  const groups = new Map<K, Array<A>>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
};

/** A page of history starts after this activity, newest first. */
export type HistoryCursor = Pick<Activity, "startedAt" | "id">;

/** What the calendar and the streak need of every workout. */
export type WorkoutStart = Pick<Activity, "id" | "startedAt" | "title" | "kind">;

const details = (activities: ReadonlyArray<Activity>) =>
  Effect.gen(function* () {
    const exercises = yield* selectRows(
      TABLES.activityExercise,
      inList("activity_id"),
      [JSON.stringify(activities.map((activity) => activity.id))],
      "activity_id, position",
    );
    const sets = yield* selectRows(
      TABLES.activitySet,
      inList("activity_exercise_id"),
      [JSON.stringify(exercises.map((exercise) => exercise.id))],
      "activity_exercise_id, position",
    );
    const library = yield* selectRows(TABLES.exercise, inList("id"), [
      JSON.stringify([...new Set(exercises.map((exercise) => exercise.exerciseId))]),
    ]);
    const exercisesOf = groupBy(exercises, (exercise) => exercise.activityId);
    const setsOf = groupBy(sets, (set) => set.activityExerciseId);
    return {
      library: new Map(library.map((exercise) => [exercise.id, exercise])),
      details: activities.map((activity): ActivityDetail => ({
        activity,
        exercises: (exercisesOf.get(activity.id) ?? []).map((exercise) => ({
          exercise,
          sets: setsOf.get(exercise.id) ?? [],
        })),
        track: null,
      })),
    };
  });

/** Each exercise's sets from the live workouts that started before `before`. */
const earlierSets = (exerciseIds: ReadonlyArray<ExerciseId>, before: HistoryCursor) =>
  Effect.gen(function* () {
    const scope = `${inList("exercise_id")} AND activity_id IN (SELECT id FROM activity WHERE deleted_at IS NULL AND (started_at, id) < (?, ?))`;
    const params = [JSON.stringify(exerciseIds), before.startedAt, before.id];
    const exercises = yield* selectRows(TABLES.activityExercise, scope, params);
    const exerciseOf = new Map<string, ActivityExercise>(
      exercises.map((exercise) => [exercise.id, exercise]),
    );
    const sets = yield* selectRows(
      TABLES.activitySet,
      `activity_exercise_id IN (SELECT id FROM activity_exercise WHERE deleted_at IS NULL AND ${scope})`,
      params,
    );
    const earlier = new Map<ExerciseId, Array<ScoredSet>>();
    for (const set of sets) {
      const exerciseId = exerciseOf.get(set.activityExerciseId)?.exerciseId;
      if (exerciseId !== undefined)
        earlier.set(exerciseId, [...(earlier.get(exerciseId) ?? []), set]);
    }
    return earlier;
  });

const makeHistoryRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const run = <A, E>(effect: Effect.Effect<A, E, Sql>) => Effect.provideService(effect, Sql, sql);

  return {
    /** A page of workouts, newest first, each with what its history row shows. */
    page: (options: { readonly limit: number; readonly after?: HistoryCursor | undefined }) =>
      run(
        Effect.gen(function* () {
          const activities = yield* selectRows(
            TABLES.activity,
            "(started_at, id) < (?, ?)",
            [
              options.after?.startedAt ?? Number.MAX_SAFE_INTEGER,
              options.after?.id ?? "",
              options.limit,
            ],
            "started_at DESC, id DESC LIMIT ?",
          );
          const { library, details: page } = yield* details(activities);
          const names = new Map([...library].map(([id, exercise]) => [id, exercise.name]));
          return page.map((detail) => summarizeWorkout(detail, names));
        }),
      ),

    /** A workout as its detail screen shows it, with its muscle split and record badges. */
    workout: (id: ActivityId) =>
      run(
        Effect.gen(function* () {
          const activity = yield* selectById(TABLES.activity, id);
          if (Option.isNone(activity)) return Option.none<WorkoutView>();
          const { library, details: found } = yield* details([activity.value]);
          const [detail] = found;
          if (detail === undefined) return Option.none<WorkoutView>();
          const exerciseIds = [
            ...new Set(detail.exercises.map((entry) => entry.exercise.exerciseId)),
          ];
          const earlier = yield* earlierSets(exerciseIds, activity.value);
          return Option.some(describeWorkout(detail, library, earlier));
        }),
      ),

    /** Every live workout's start, newest first, for the calendar and the streak. */
    starts: run(
      Effect.map(
        selectRows(TABLES.activity, "1 = 1", [], "started_at DESC, id DESC"),
        (activities): ReadonlyArray<WorkoutStart> =>
          activities.map(({ id, startedAt, title, kind }) => ({ id, startedAt, title, kind })),
      ),
    ),
  };
});

/** Reads history for the Progress screens. It writes nothing: ActivityRepository owns those tables. */
export class HistoryRepository extends Context.Service<
  HistoryRepository,
  Effect.Success<typeof makeHistoryRepository>
>()("svett/HistoryRepository") {
  static readonly layer = Layer.effect(HistoryRepository, makeHistoryRepository);
}

/** Saves a past workout as a new routine at the end of the routine list. */
export const saveWorkoutAsRoutine = (id: ActivityId) =>
  Effect.gen(function* () {
    const activities = yield* ActivityRepository;
    const routines = yield* RoutineRepository;
    const detail = yield* activities.get(id);
    if (Option.isNone(detail)) return yield* new RowNotFoundError({ table: "activity", id });
    const existing = yield* routines.listRoutines;
    return yield* routines.createRoutine(routineFromWorkout(detail.value, existing.length));
  });
