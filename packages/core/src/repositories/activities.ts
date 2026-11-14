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
  type RoutineId,
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

/** A strength workout to start now. It stays in progress until it is finished or discarded. */
export interface WorkoutStart {
  readonly title: string;
  readonly routineId: RoutineId | null;
  readonly exercises: ReadonlyArray<
    Draft<ActivityExercise, "activityId"> & { readonly sets: ReadonlyArray<PlannedSet> }
  >;
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
  readonly exercises: ReadonlyArray<
    Draft<ActivityExercise, "activityId"> & { readonly sets: ReadonlyArray<SetDraft> }
  >;
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

/** Writes an activity's exercises and sets in order. Done sets belong to a finished workout. */
const insertExercises = (
  activityId: ActivityId,
  origin: Origin,
  exercises: ReadonlyArray<
    Draft<ActivityExercise, "activityId"> & {
      readonly sets: ReadonlyArray<SetDraft | PlannedSet>;
    }
  >,
  done: boolean,
  updatedAt: EpochMillis,
) =>
  Effect.gen(function* () {
    for (const [position, { sets, ...exercise }] of exercises.entries()) {
      const exerciseId = ActivityExerciseId.make(
        yield* rowId(TABLES.activityExercise, origin, `/exercise/${position}`),
      );
      yield* insertRows(TABLES.activityExercise, [
        { ...exercise, id: exerciseId, activityId, position, updatedAt, deletedAt: null },
      ]);
      for (const [setPosition, set] of sets.entries()) {
        const setId = ActivitySetId.make(
          yield* rowId(TABLES.activitySet, origin, `/exercise/${position}/set/${setPosition}`),
        );
        yield* insertRows(TABLES.activitySet, [
          {
            rpe: null,
            targetRepsMin: null,
            targetRepsMax: null,
            ...set,
            done,
            id: setId,
            activityExerciseId: exerciseId,
            position: setPosition,
            updatedAt,
            deletedAt: null,
          },
        ]);
      }
    }
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
  const startWorkout = ({ title, routineId, exercises }: WorkoutStart) =>
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
