import { Context, Effect, Layer, Option } from "effect";

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
import { type Origin, provenance, rowId } from "./origin.ts";

type Draft<A, Parent extends string = never> = Omit<
  A,
  "id" | "updatedAt" | "deletedAt" | "position" | Parent
>;

export type SetDraft = Draft<ActivitySet, "activityExerciseId">;
export type SampleDraft = ActivitySample extends infer S
  ? S extends ActivitySample
    ? Omit<S, "id" | "updatedAt" | "deletedAt" | "activityTrackId">
    : never
  : never;

export interface ActivityDraft extends Omit<
  Draft<Activity>,
  "source" | "sourceId" | "fingerprint" | "importBatchId"
> {
  /**
   * The ID to save the activity under, chosen before it is saved, such as when a
   * recording starts. Creating a draft whose ID is already saved returns that ID and
   * writes nothing, so a save repeated after a crash saves once.
   */
  readonly id?: ActivityId;
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
          const { id: chosen, origin, exercises, track, ...fields } = draft;
          if (chosen !== undefined) {
            const saved = yield* sql.all("SELECT id FROM activity WHERE id = ?", [chosen]);
            if (saved.length > 0) return chosen;
          }
          const id = chosen ?? ActivityId.make(yield* rowId(TABLES.activity, origin));
          yield* insertRows(TABLES.activity, [
            { ...fields, ...provenance(origin), id, updatedAt, deletedAt: null },
          ]);
          for (const [position, { sets, ...exercise }] of exercises.entries()) {
            const exerciseId = ActivityExerciseId.make(
              yield* rowId(TABLES.activityExercise, origin, `/exercise/${position}`),
            );
            yield* insertRows(TABLES.activityExercise, [
              { ...exercise, id: exerciseId, activityId: id, position, updatedAt, deletedAt: null },
            ]);
            for (const [setPosition, set] of sets.entries()) {
              const setId = ActivitySetId.make(
                yield* rowId(
                  TABLES.activitySet,
                  origin,
                  `/exercise/${position}/set/${setPosition}`,
                ),
              );
              yield* insertRows(TABLES.activitySet, [
                {
                  ...set,
                  id: setId,
                  activityExerciseId: exerciseId,
                  position: setPosition,
                  updatedAt,
                  deletedAt: null,
                },
              ]);
            }
          }
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
        "(started_at, id) < (?, ?)",
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

  /** Undo for `remove`: brings back the activity and exactly the children that delete took. */
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
          yield* restoreRows(TABLES.activityExercise, childrenOf.exercises, [id], deletedAt, at);
          yield* restoreRows(TABLES.activitySet, childrenOf.sets, [id], deletedAt, at);
          yield* restoreRows(TABLES.activityTrack, childrenOf.tracks, [id], deletedAt, at);
          yield* restoreRows(TABLES.activitySample, childrenOf.samples, [id], deletedAt, at);
        }),
      ),
    );

  return {
    create,
    get,
    list,
    remove,
    restore,
    update: (
      id: ActivityId,
      patch: Omit<Patch<Activity>, "source" | "sourceId" | "fingerprint" | "importBatchId">,
    ) => run(updateRow(TABLES.activity, id, patch)),
    updateSet: (id: ActivitySetId, patch: Omit<Patch<ActivitySet>, "activityExerciseId">) =>
      run(updateRow(TABLES.activitySet, id, patch)),
    /** Changes how much of each end of the route is hidden from others. */
    updateTrack: (
      id: ActivityTrackId,
      patch: Pick<Patch<ActivityTrack>, "hideStartM" | "hideEndM">,
    ) => run(updateRow(TABLES.activityTrack, id, patch)),
    samples: (trackId: ActivityTrackId) =>
      run(selectRows(TABLES.activitySample, "activity_track_id = ?", [trackId], "recorded_at, id")),
    counts: run(
      Effect.all({
        activities: countRows(TABLES.activity),
        sets: countRows(TABLES.activitySet),
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
