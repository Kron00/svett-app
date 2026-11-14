import { Context, Data, Effect, Layer, Option } from "effect";

import { Ids } from "../ids.ts";
import {
  type Activity,
  type ActivityExercise,
  ActivityExerciseId,
  ActivityId,
  type ActivitySample,
  ActivitySampleId,
  type ActivitySet,
  ActivitySetId,
  type ActivityTrack,
  ActivityTrackId,
  type EpochMillis,
  type ExerciseId,
  type RoutineId,
  type SetFields,
} from "../schema.ts";
import { Sql } from "../sql.ts";
import {
  countRows,
  currentTime,
  insertRows,
  type Patch,
  restoreRows,
  RowNotFoundError,
  selectById,
  selectRows,
  softDeleteRows,
  TABLES,
  updateRow,
} from "../table.ts";
import { DurationSeconds } from "../duration.ts";
import { finishPlan, setFieldsFromSets } from "../logger.ts";
import { MADE_HERE, type Origin, provenance, rowId } from "./origin.ts";

type Draft<A, Parent extends string = never> = Omit<
  A,
  "id" | "updatedAt" | "deletedAt" | "position" | Parent
>;

/** A set of a finished workout. It is done and has no target. */
export type SetDraft = Omit<
  Draft<ActivitySet, "activityExerciseId">,
  "done" | "targetRepsMin" | "targetRepsMax"
>;

/** A set still to do in a workout that is starting, with the values a routine filled in. */
export type PlannedSet = Pick<
  ActivitySet,
  "setType" | "weightKg" | "reps" | "durationS" | "distanceM" | "targetRepsMin" | "targetRepsMax"
>;

/**
 * An exercise to write with its sets. Without set fields it records what its sets hold, as
 * setFieldsFromSets decides, so importers need not choose.
 */
export type ExerciseRows<S> = Omit<Draft<ActivityExercise, "activityId">, "setFields"> & {
  readonly setFields?: SetFields;
  readonly sets: ReadonlyArray<S>;
};

/** A strength workout to start now. It stays in progress until it is finished or discarded. */
export interface NewWorkout {
  readonly title: string;
  readonly routineId: RoutineId | null;
  readonly exercises: ReadonlyArray<ExerciseRows<PlannedSet>>;
}

/** Finishing a workout needs at least one set marked done. */
export class NothingDoneError extends Data.TaggedError("NothingDoneError")<{
  readonly problem: string;
}> {}

/** What an exercise held the last time it was done, for the logger's previous values. */
export interface LastPerformance {
  readonly activityId: ActivityId;
  readonly setFields: SetFields;
  readonly sets: ReadonlyArray<ActivitySet>;
}

/** Only one workout is in progress at a time. */
export class WorkoutInProgressError extends Data.TaggedError("WorkoutInProgressError")<{
  readonly activityId: ActivityId;
}> {}
export type SampleDraft = ActivitySample extends infer S
  ? S extends ActivitySample
    ? Omit<S, "id" | "updatedAt" | "deletedAt" | "activityTrackId">
    : never
  : never;

/** A finished activity, logged or imported. */
export interface ActivityDraft extends Omit<
  Draft<Activity>,
  "source" | "sourceId" | "fingerprint" | "importBatchId" | "status" | "routineId"
> {
  readonly origin: Origin;
  readonly exercises: ReadonlyArray<ExerciseRows<SetDraft>>;
  readonly track:
    | (Draft<ActivityTrack, "activityId"> & {
        readonly samples: ReadonlyArray<SampleDraft>;
      })
    | null;
}

export interface ActivityDetail {
  readonly activity: Activity;
  readonly exercises: ReadonlyArray<{
    readonly exercise: ActivityExercise;
    readonly sets: ReadonlyArray<ActivitySet>;
  }>;
  readonly track: ActivityTrack | null;
}

const childrenOf = {
  exercises: "activity_id = ?",
  sets: "activity_exercise_id IN (SELECT id FROM activity_exercise WHERE activity_id = ?)",
  tracks: "activity_id = ?",
  samples: "activity_track_id IN (SELECT id FROM activity_track WHERE activity_id = ?)",
};

const insertSet = (
  activityExerciseId: ActivityExerciseId,
  origin: Origin,
  path: string,
  position: number,
  set: SetDraft | PlannedSet,
  done: boolean,
  updatedAt: EpochMillis,
) =>
  Effect.gen(function* () {
    const id = ActivitySetId.make(yield* rowId(TABLES.activitySet, origin, path));
    yield* insertRows(TABLES.activitySet, [
      {
        rpe: null,
        targetRepsMin: null,
        targetRepsMax: null,
        ...set,
        done,
        id,
        activityExerciseId,
        position,
        updatedAt,
        deletedAt: null,
      },
    ]);
    return id;
  });

/**
 * Writes exercises and their sets in order, the first at `from`. Done sets belong to a
 * finished workout. Returns the new exercises' IDs.
 */
const insertExercises = (
  activityId: ActivityId,
  origin: Origin,
  exercises: ReadonlyArray<ExerciseRows<SetDraft | PlannedSet>>,
  done: boolean,
  updatedAt: EpochMillis,
  from = 0,
) =>
  Effect.gen(function* () {
    const ids: Array<ActivityExerciseId> = [];
    for (const [index, { sets, setFields, ...exercise }] of exercises.entries()) {
      const position = from + index;
      const exerciseId = ActivityExerciseId.make(
        yield* rowId(TABLES.activityExercise, origin, `/exercise/${position}`),
      );
      yield* insertRows(TABLES.activityExercise, [
        {
          ...exercise,
          setFields: setFields ?? setFieldsFromSets(sets) ?? "weight_reps",
          id: exerciseId,
          activityId,
          position,
          updatedAt,
          deletedAt: null,
        },
      ]);
      for (const [setPosition, set] of sets.entries()) {
        yield* insertSet(
          exerciseId,
          origin,
          `/exercise/${position}/set/${setPosition}`,
          setPosition,
          set,
          done,
          updatedAt,
        );
      }
      ids.push(exerciseId);
    }
    return ids;
  });

const liveExercises = (activityId: ActivityId) =>
  selectRows(TABLES.activityExercise, childrenOf.exercises, [activityId], "position, id");

const exerciseSets = (id: ActivityExerciseId) =>
  selectRows(TABLES.activitySet, "activity_exercise_id = ?", [id], "position, id");

/** The workout an exercise belongs to, if it is the one in progress. */
const inProgressExercise = (id: ActivityExerciseId) =>
  Effect.gen(function* () {
    const exercise = yield* selectById(TABLES.activityExercise, id);
    if (Option.isNone(exercise)) {
      return yield* new RowNotFoundError({ table: "activity_exercise", id });
    }
    const activity = yield* selectById(TABLES.activity, exercise.value.activityId);
    if (Option.isNone(activity) || activity.value.status !== "in_progress") {
      return yield* new RowNotFoundError({ table: "activity", id: exercise.value.activityId });
    }
    return exercise.value;
  });

/** Fails when a live workout other than `id` is in progress. */
const noOtherInProgress = (id: ActivityId) =>
  Effect.gen(function* () {
    const [other] = yield* selectRows(
      TABLES.activity,
      "status = 'in_progress' AND id <> ?",
      [id],
      "started_at DESC, id DESC LIMIT 1",
    );
    if (other !== undefined) {
      return yield* new WorkoutInProgressError({ activityId: other.id });
    }
  });

const makeActivityRepository = Effect.gen(function* () {
  const sql = yield* Sql;
  const ids = yield* Ids;
  const run = <A, E>(effect: Effect.Effect<A, E, Sql | Ids>) =>
    effect.pipe(Effect.provideService(Sql, sql), Effect.provideService(Ids, ids));

  const create = (draft: ActivityDraft) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const updatedAt = yield* currentTime;
          const { origin, exercises, track, ...fields } = draft;
          const id = ActivityId.make(yield* rowId(TABLES.activity, origin));
          yield* insertRows(TABLES.activity, [
            {
              ...fields,
              ...provenance(origin),
              status: "finished",
              routineId: null,
              id,
              updatedAt,
              deletedAt: null,
            },
          ]);
          yield* insertExercises(id, origin, exercises, true, updatedAt);
          if (track !== null) {
            const { samples, ...trackFields } = track;
            const trackId = ActivityTrackId.make(
              yield* rowId(TABLES.activityTrack, origin, "/track"),
            );
            yield* insertRows(TABLES.activityTrack, [
              { ...trackFields, id: trackId, activityId: id, updatedAt, deletedAt: null },
            ]);
            for (const [index, sample] of samples.entries()) {
              const sampleId = ActivitySampleId.make(
                yield* rowId(TABLES.activitySample, origin, `/track/sample/${index}`),
              );
              yield* insertRows(TABLES.activitySample, [
                { ...sample, id: sampleId, activityTrackId: trackId, updatedAt, deletedAt: null },
              ]);
            }
          }
          return id;
        }),
      ),
    );

  const inProgressId = Effect.map(
    selectRows(TABLES.activity, "status = 'in_progress'", [], "started_at DESC, id DESC LIMIT 1"),
    (rows) => Option.fromNullishOr(rows[0]?.id),
  );

  /** Starts a strength workout now, with every set still to do. */
  const startWorkout = ({ title, routineId, exercises }: NewWorkout) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const running = yield* inProgressId;
          if (Option.isSome(running)) {
            return yield* new WorkoutInProgressError({ activityId: running.value });
          }
          const updatedAt = yield* currentTime;
          const id = ActivityId.make(yield* rowId(TABLES.activity, MADE_HERE));
          yield* insertRows(TABLES.activity, [
            {
              kind: "strength",
              status: "in_progress",
              routineId,
              startedAt: updatedAt,
              durationS: DurationSeconds.make(0),
              title,
              notes: "",
              energyKcal: null,
              audience: "only_you",
              hiddenFields: [],
              ...provenance(MADE_HERE),
              id,
              updatedAt,
              deletedAt: null,
            },
          ]);
          yield* insertExercises(id, MADE_HERE, exercises, false, updatedAt);
          return id;
        }),
      ),
    );

  /** Adds exercises at the end of the workout in progress. Returns their IDs. */
  const addExercises = (activityId: ActivityId, exercises: WorkoutStart["exercises"]) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const activity = yield* selectById(TABLES.activity, activityId);
          if (Option.isNone(activity) || activity.value.status !== "in_progress") {
            return yield* new RowNotFoundError({ table: "activity", id: activityId });
          }
          const current = yield* liveExercises(activityId);
          const from = current.reduce((end, row) => Math.max(end, row.position + 1), 0);
          return yield* insertExercises(
            activityId,
            MADE_HERE,
            exercises,
            false,
            yield* currentTime,
            from,
          );
        }),
      ),
    );

  /** Removes an exercise of the workout in progress, with its sets. */
  const removeExercise = (id: ActivityExerciseId) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          yield* inProgressExercise(id);
          const at = yield* currentTime;
          yield* softDeleteRows(TABLES.activitySet, "activity_exercise_id = ?", [id], at);
          yield* softDeleteRows(TABLES.activityExercise, "id = ?", [id], at);
        }),
      ),
    );

  /** Puts the workout's exercises in the order of `ids`. */
  const orderExercises = (activityId: ActivityId, order: ReadonlyArray<ActivityExerciseId>) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const current = yield* liveExercises(activityId);
          const known = new Set<string>(current.map((row) => row.id));
          if (order.length !== known.size || order.some((id) => !known.has(id))) {
            return yield* Effect.die(new Error("The new order must name each exercise once"));
          }
          for (const [position, id] of order.entries()) {
            const row = current.find((exercise) => exercise.id === id);
            if (row !== undefined && row.position !== position) {
              yield* updateRow(TABLES.activityExercise, id, { position });
            }
          }
        }),
      ),
    );

  /** Swaps an exercise of the workout in progress for another, with its sets emptied. */
  const replaceExercise = (
    id: ActivityExerciseId,
    exerciseId: ExerciseId,
    setFields: SetFields,
    emptySet: Patch<ActivitySet>,
  ) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          yield* inProgressExercise(id);
          yield* updateRow(TABLES.activityExercise, id, { exerciseId, setFields, notes: "" });
          for (const set of yield* exerciseSets(id)) {
            yield* updateRow(TABLES.activitySet, set.id, emptySet);
          }
        }),
      ),
    );

  /** Adds a set at the end of an exercise of the workout in progress. Returns its ID. */
  const addSet = (id: ActivityExerciseId, set: PlannedSet) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          yield* inProgressExercise(id);
          const sets = yield* exerciseSets(id);
          const position = sets.reduce((end, row) => Math.max(end, row.position + 1), 0);
          return yield* insertSet(id, MADE_HERE, "", position, set, false, yield* currentTime);
        }),
      ),
    );

  /** Removes a set of the workout in progress. */
  const removeSet = (id: ActivitySetId) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const set = yield* selectById(TABLES.activitySet, id);
          if (Option.isNone(set)) return yield* new RowNotFoundError({ table: "activity_set", id });
          yield* inProgressExercise(set.value.activityExerciseId);
          yield* softDeleteRows(TABLES.activitySet, "id = ?", [id], yield* currentTime);
        }),
      ),
    );

  /**
   * Finishes the workout in progress. Sets not marked done, and exercises left without a done
   * set, are left out. Fails with NothingDoneError when no set is done.
   */
  const finishWorkout = (id: ActivityId) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const activity = yield* selectById(TABLES.activity, id);
          if (Option.isNone(activity) || activity.value.status !== "in_progress") {
            return yield* new RowNotFoundError({ table: "activity", id });
          }
          const exercises = yield* liveExercises(id);
          const sets = yield* selectRows(TABLES.activitySet, childrenOf.sets, [id], "position, id");
          const plan = finishPlan(
            exercises.map((exercise) => ({
              id: exercise.id,
              sets: sets.filter((set) => set.activityExerciseId === exercise.id),
            })),
          );
          if (!plan.ok) return yield* new NothingDoneError({ problem: plan.problem });
          const at = yield* currentTime;
          if (plan.dropSets.length > 0) {
            yield* softDeleteRows(
              TABLES.activitySet,
              "id IN (SELECT value FROM json_each(?))",
              [JSON.stringify(plan.dropSets)],
              at,
            );
          }
          if (plan.dropExercises.length > 0) {
            yield* softDeleteRows(
              TABLES.activityExercise,
              "id IN (SELECT value FROM json_each(?))",
              [JSON.stringify(plan.dropExercises)],
              at,
            );
          }
          const kept = exercises.filter((exercise) => !plan.dropExercises.includes(exercise.id));
          for (const [position, exercise] of kept.entries()) {
            if (exercise.position !== position) {
              yield* updateRow(TABLES.activityExercise, exercise.id, { position });
            }
          }
          return yield* updateRow(TABLES.activity, id, {
            status: "finished",
            durationS: DurationSeconds.make(Math.max(0, (at - activity.value.startedAt) / 1000)),
          });
        }),
      ),
    );

  /**
   * What each exercise held in the last finished workout that has it, other than `except`.
   * An exercise never done before has no entry.
   */
  const lastPerformances = (exerciseIds: Iterable<ExerciseId>, except: ActivityId | null = null) =>
    run(
      Effect.gen(function* () {
        const found = new Map<ExerciseId, LastPerformance>();
        for (const exerciseId of new Set(exerciseIds)) {
          const [row] = yield* sql.all(
            `SELECT e.id AS id FROM activity_exercise e JOIN activity a ON a.id = e.activity_id
             WHERE e.exercise_id = ? AND e.deleted_at IS NULL AND a.deleted_at IS NULL
               AND a.status = 'finished' AND a.id != ?
             ORDER BY a.started_at DESC, a.id DESC, e.position DESC LIMIT 1`,
            [exerciseId, except ?? ""],
          );
          if (row === undefined) continue;
          const exercise = yield* selectById(
            TABLES.activityExercise,
            ActivityExerciseId.make(String(row["id"])),
          );
          if (Option.isNone(exercise)) continue;
          found.set(exerciseId, {
            activityId: exercise.value.activityId,
            setFields: exercise.value.setFields,
            sets: yield* exerciseSets(exercise.value.id),
          });
        }
        return found;
      }),
    );

  const get = (id: ActivityId) =>
    run(
      Effect.gen(function* () {
        const activity = yield* selectById(TABLES.activity, id);
        if (Option.isNone(activity)) return Option.none<ActivityDetail>();
        const exercises = yield* selectRows(
          TABLES.activityExercise,
          childrenOf.exercises,
          [id],
          "position",
        );
        const sets = yield* selectRows(TABLES.activitySet, childrenOf.sets, [id], "position");
        const [track] = yield* selectRows(TABLES.activityTrack, childrenOf.tracks, [id]);
        return Option.some<ActivityDetail>({
          activity: activity.value,
          exercises: exercises.map((exercise) => ({
            exercise,
            sets: sets.filter((set) => set.activityExerciseId === exercise.id),
          })),
          track: track ?? null,
        });
      }),
    );

  const list = (
    options: {
      readonly limit?: number;
      readonly before?: Pick<Activity, "startedAt" | "id">;
    } = {},
  ) =>
    run(
      selectRows(
        TABLES.activity,
        "status = 'finished' AND (started_at, id) < (?, ?)",
        [
          options.before?.startedAt ?? Number.MAX_SAFE_INTEGER,
          options.before?.id ?? "",
          options.limit ?? 50,
        ],
        "started_at DESC, id DESC LIMIT ?",
      ),
    );

  const remove = (id: ActivityId) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const at = yield* currentTime;
          const removed = yield* softDeleteRows(TABLES.activity, "id = ?", [id], at);
          if (removed === 0) return yield* new RowNotFoundError({ table: "activity", id });
          yield* softDeleteRows(TABLES.activitySet, childrenOf.sets, [id], at);
          yield* softDeleteRows(TABLES.activityExercise, childrenOf.exercises, [id], at);
          yield* softDeleteRows(TABLES.activitySample, childrenOf.samples, [id], at);
          yield* softDeleteRows(TABLES.activityTrack, childrenOf.tracks, [id], at);
        }),
      ),
    );

  /**
   * Undo for `remove`: brings back the activity and exactly the children that delete took.
   * A workout in progress comes back only while no other workout is in progress.
   */
  const restore = (id: ActivityId) =>
    run(
      sql.transaction(
        Effect.gen(function* () {
          const [row] = yield* sql.all(
            "SELECT deleted_at FROM activity WHERE id = ? AND deleted_at IS NOT NULL",
            [id],
          );
          if (row === undefined) return yield* new RowNotFoundError({ table: "activity", id });
          const deletedAt = row["deleted_at"] as EpochMillis;
          const at = yield* currentTime;
          yield* restoreRows(TABLES.activity, "id = ?", [id], deletedAt, at);
          const restored = yield* selectById(TABLES.activity, id);
          if (Option.isSome(restored) && restored.value.status === "in_progress") {
            yield* noOtherInProgress(id);
          }
          yield* restoreRows(TABLES.activityExercise, childrenOf.exercises, [id], deletedAt, at);
          yield* restoreRows(TABLES.activitySet, childrenOf.sets, [id], deletedAt, at);
          yield* restoreRows(TABLES.activityTrack, childrenOf.tracks, [id], deletedAt, at);
          yield* restoreRows(TABLES.activitySample, childrenOf.samples, [id], deletedAt, at);
        }),
      ),
    );

  return {
    create,
    startWorkout,
    /** The workout in progress, if there is one. */
    inProgress: run(
      Effect.flatMap(inProgressId, (id) =>
        Option.isSome(id) ? get(id.value) : Effect.succeed(Option.none<ActivityDetail>()),
      ),
    ),
    get,
    list,
    remove,
    restore,
    addExercises,
    removeExercise,
    orderExercises,
    replaceExercise,
    updateExercise: (
      id: ActivityExerciseId,
      patch: Pick<Patch<ActivityExercise>, "notes" | "setFields" | "supersetGroup">,
    ) => run(updateRow(TABLES.activityExercise, id, patch)),
    addSet,
    removeSet,
    finishWorkout,
    lastPerformances,
    /** Fails with WorkoutInProgressError when it would put a second workout in progress. */
    update: (
      id: ActivityId,
      patch: Omit<Patch<Activity>, "source" | "sourceId" | "fingerprint" | "importBatchId">,
    ) =>
      run(
        sql.transaction(
          Effect.gen(function* () {
            const next = yield* updateRow(TABLES.activity, id, patch);
            if (next.status === "in_progress") yield* noOtherInProgress(id);
            return next;
          }),
        ),
      ),
    updateSet: (id: ActivitySetId, patch: Omit<Patch<ActivitySet>, "activityExerciseId">) =>
      run(updateRow(TABLES.activitySet, id, patch)),
    samples: (trackId: ActivityTrackId) =>
      run(selectRows(TABLES.activitySample, "activity_track_id = ?", [trackId], "recorded_at, id")),
    counts: run(
      Effect.all({
        activities: countRows(TABLES.activity, "status = 'finished'"),
        sets: countRows(
          TABLES.activitySet,
          `done = 1 AND activity_exercise_id IN (SELECT e.id FROM activity_exercise e JOIN activity a ON a.id = e.activity_id
            WHERE e.deleted_at IS NULL AND a.deleted_at IS NULL AND a.status = 'finished')`,
        ),
      }),
    ),
  };
});

/** The only writer of activity, activity_exercise, activity_set, activity_track and activity_sample. */
export class ActivityRepository extends Context.Service<
  ActivityRepository,
  Effect.Success<typeof makeActivityRepository>
>()("svett/ActivityRepository") {
  static readonly layer = Layer.effect(ActivityRepository, makeActivityRepository);
}
