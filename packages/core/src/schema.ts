import { Schema } from "effect";

import { DurationSeconds } from "./duration.ts";
import { Uuid } from "./ids.ts";
import { BarsAndPlates } from "./plates.ts";
import { WeightUnit } from "./weight-unit.ts";

export const EpochMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("EpochMillis"),
);
export type EpochMillis = typeof EpochMillis.Type;

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const JsonArray = <S extends Schema.Top>(item: S) => Schema.fromJsonString(Schema.Array(item));

export const ActivityId = Uuid.pipe(Schema.brand("ActivityId"));
export type ActivityId = typeof ActivityId.Type;
export const ActivityExerciseId = Uuid.pipe(Schema.brand("ActivityExerciseId"));
export type ActivityExerciseId = typeof ActivityExerciseId.Type;
export const ActivitySetId = Uuid.pipe(Schema.brand("ActivitySetId"));
export type ActivitySetId = typeof ActivitySetId.Type;
export const ActivityTrackId = Uuid.pipe(Schema.brand("ActivityTrackId"));
export type ActivityTrackId = typeof ActivityTrackId.Type;
export const ActivitySampleId = Uuid.pipe(Schema.brand("ActivitySampleId"));
export type ActivitySampleId = typeof ActivitySampleId.Type;
export const ExerciseId = Uuid.pipe(Schema.brand("ExerciseId"));
export type ExerciseId = typeof ExerciseId.Type;
export const ExerciseAliasId = Uuid.pipe(Schema.brand("ExerciseAliasId"));
export type ExerciseAliasId = typeof ExerciseAliasId.Type;
export const RoutineId = Uuid.pipe(Schema.brand("RoutineId"));
export type RoutineId = typeof RoutineId.Type;
export const RoutineExerciseId = Uuid.pipe(Schema.brand("RoutineExerciseId"));
export type RoutineExerciseId = typeof RoutineExerciseId.Type;
export const RoutineSetId = Uuid.pipe(Schema.brand("RoutineSetId"));
export type RoutineSetId = typeof RoutineSetId.Type;
export const FolderId = Uuid.pipe(Schema.brand("FolderId"));
export type FolderId = typeof FolderId.Type;
export const MeasurementId = Uuid.pipe(Schema.brand("MeasurementId"));
export type MeasurementId = typeof MeasurementId.Type;
export const ImportBatchId = Uuid.pipe(Schema.brand("ImportBatchId"));
export type ImportBatchId = typeof ImportBatchId.Type;
export const ImportChangeId = Uuid.pipe(Schema.brand("ImportChangeId"));
export type ImportChangeId = typeof ImportChangeId.Type;
export const ProposalId = Uuid.pipe(Schema.brand("ProposalId"));
export type ProposalId = typeof ProposalId.Type;
export const CoachMessageId = Uuid.pipe(Schema.brand("CoachMessageId"));
export type CoachMessageId = typeof CoachMessageId.Type;
export const ConversationId = Uuid.pipe(Schema.brand("ConversationId"));
export type ConversationId = typeof ConversationId.Type;
export const GearId = Uuid.pipe(Schema.brand("GearId"));
export type GearId = typeof GearId.Type;

/** Every row carries these, so phase 6 sync needs no table rewrite. */
const rowFields = <Id extends Schema.Top>(id: Id) => ({
  id,
  updatedAt: EpochMillis,
  deletedAt: Schema.NullOr(EpochMillis),
});

export const Source = Schema.Literals(["svett", "library", "hevy", "apple_health"]);
export type Source = typeof Source.Type;
export const ImportSource = Schema.Literals(["hevy", "apple_health", "svett_file"]);
export type ImportSource = typeof ImportSource.Type;
export const SourceIdentity = Schema.NonEmptyString.pipe(Schema.brand("SourceIdentity"));
export type SourceIdentity = typeof SourceIdentity.Type;
export const Fingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("Fingerprint"),
);
export type Fingerprint = typeof Fingerprint.Type;

const provenanceFields = {
  source: Source,
  sourceId: Schema.NullOr(SourceIdentity),
  fingerprint: Schema.NullOr(Fingerprint),
  importBatchId: Schema.NullOr(ImportBatchId),
};

type Provenance = {
  readonly source: Source;
  readonly sourceId: SourceIdentity | null;
  readonly fingerprint: Fingerprint | null;
};

const provenanceRule = Schema.makeFilter<Provenance>((row) => {
  switch (row.source) {
    case "svett":
      return row.sourceId === null && row.fingerprint === null
        ? undefined
        : "a row made in svett has no source identity or fingerprint";
    case "library":
      return row.sourceId !== null ? undefined : "a library row needs its library identity";
    case "hevy":
    case "apple_health":
      return row.sourceId !== null && row.fingerprint !== null
        ? undefined
        : "an imported row needs its source identity and fingerprint";
  }
});

export const ActivityKind = Schema.Literals(["strength", "run", "ride", "walk", "hike", "other"]);
export type ActivityKind = typeof ActivityKind.Type;
export const Audience = Schema.Literals(["everyone", "followers", "only_you"]);
export type Audience = typeof Audience.Type;
export const HiddenField = Schema.Literals([
  "weight",
  "heart_rate",
  "start_time",
  "calories",
  "pace",
]);
export type HiddenField = typeof HiddenField.Type;

/** A workout is in progress from its start until it is finished or discarded. */
export const ActivityStatus = Schema.Literals(["in_progress", "finished"]);
export type ActivityStatus = typeof ActivityStatus.Type;

export const Activity = Schema.Struct({
  ...rowFields(ActivityId),
  kind: ActivityKind,
  status: ActivityStatus,
  /** The routine a workout was started from, so the logger can read its rest times. */
  routineId: Schema.NullOr(RoutineId),
  startedAt: EpochMillis,
  durationS: DurationSeconds,
  title: Schema.String,
  notes: Schema.String,
  energyKcal: Schema.NullOr(NonNegative),
  audience: Audience,
  hiddenFields: JsonArray(HiddenField),
  ...provenanceFields,
}).check(provenanceRule);
export type Activity = typeof Activity.Type;

/** What each set of an exercise records, such as weight and reps, or a time. */
export const SetFields = Schema.Literals([
  "weight_reps",
  "reps",
  "time",
  "weight_time",
  "distance_time",
  "weight_distance",
]);
export type SetFields = typeof SetFields.Type;

export const ActivityExercise = Schema.Struct({
  ...rowFields(ActivityExerciseId),
  activityId: ActivityId,
  exerciseId: ExerciseId,
  position: NonNegativeInt,
  /** Exercises in one activity that share a group number form a superset. */
  supersetGroup: Schema.NullOr(NonNegativeInt),
  notes: Schema.String,
  setFields: SetFields,
  /** The rest after each set, for the rest timer. 0 is off. Null before svett had the timer. */
  restS: Schema.NullOr(DurationSeconds),
});
export type ActivityExercise = typeof ActivityExercise.Type;

export const SetType = Schema.Literals(["warm_up", "normal", "failure", "drop"]);
export type SetType = typeof SetType.Type;

export const Rpe = Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 10 })).check(
  Schema.isMultipleOf(0.5),
);

type SetValues = {
  readonly reps: number | null;
  readonly durationS: number | null;
  readonly distanceM: number | null;
};

type RepRange = { readonly repsMin: number | null; readonly repsMax: number | null };

const repRangeInOrder = ({ repsMin, repsMax }: RepRange) =>
  repsMin === null || repsMax === null || repsMin <= repsMax
    ? undefined
    : "a rep range starts at or below its end";

// A set still to do in a workout in progress may be empty. Once done it records something.
const setRecordsSomething = Schema.makeFilter<SetValues & { readonly done: boolean }>((set) =>
  !set.done || set.reps !== null || set.durationS !== null || set.distanceM !== null
    ? undefined
    : "a set records reps, a time or a distance",
);

export const ActivitySet = Schema.Struct({
  ...rowFields(ActivitySetId),
  activityExerciseId: ActivityExerciseId,
  position: NonNegativeInt,
  setType: SetType,
  weightKg: Schema.NullOr(NonNegative),
  reps: Schema.NullOr(NonNegativeInt),
  durationS: Schema.NullOr(DurationSeconds),
  distanceM: Schema.NullOr(NonNegative),
  rpe: Schema.NullOr(Rpe),
  done: Schema.BooleanFromBit,
  /** The rep range the routine set as the goal, shown while the set is still to do. */
  targetRepsMin: Schema.NullOr(NonNegativeInt),
  targetRepsMax: Schema.NullOr(NonNegativeInt),
})
  .check(setRecordsSomething)
  .check(
    Schema.makeFilter((set) =>
      repRangeInOrder({ repsMin: set.targetRepsMin, repsMax: set.targetRepsMax }),
    ),
  );
export type ActivitySet = typeof ActivitySet.Type;

export const ActivityTrack = Schema.Struct({
  ...rowFields(ActivityTrackId),
  activityId: ActivityId,
  distanceM: Schema.NullOr(NonNegative),
  elevationGainM: Schema.NullOr(NonNegative),
  /** Metres of the route hidden at each end, so a map does not show where you live. */
  hideStartM: NonNegative,
  hideEndM: NonNegative,
});
export type ActivityTrack = typeof ActivityTrack.Type;

const sampleFields = {
  ...rowFields(ActivitySampleId),
  activityTrackId: ActivityTrackId,
  recordedAt: EpochMillis,
};

export const ActivitySample = Schema.Union([
  Schema.Struct({
    ...sampleFields,
    kind: Schema.Literal("location"),
    latitude: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
    longitude: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
    altitudeM: Schema.NullOr(Schema.Finite),
  }),
  Schema.Struct({
    ...sampleFields,
    kind: Schema.Literal("heart_rate"),
    bpm: Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 260 })),
  }),
  Schema.Struct({
    ...sampleFields,
    kind: Schema.Literal("split"),
    distanceM: NonNegative,
    durationS: DurationSeconds,
  }),
]);
export type ActivitySample = typeof ActivitySample.Type;

export const Muscle = Schema.Literals([
  "abdominals",
  "abductors",
  "adductors",
  "biceps",
  "calves",
  "cardio",
  "chest",
  "forearms",
  "full_body",
  "glutes",
  "hamstrings",
  "lats",
  "lower_back",
  "neck",
  "quadriceps",
  "shoulders",
  "traps",
  "triceps",
  "upper_back",
  "other",
]);
export type Muscle = typeof Muscle.Type;

export const Equipment = Schema.Literals([
  "none",
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "cable",
  "plate",
  "band",
  "ez_bar",
  "medicine_ball",
  "exercise_ball",
  "foam_roller",
  "suspension",
  "other",
]);
export type Equipment = typeof Equipment.Type;

export const ExerciseCategory = Schema.Literals([
  "strength",
  "powerlifting",
  "olympic_weightlifting",
  "strongman",
  "plyometrics",
  "stretching",
  "cardio",
]);
export type ExerciseCategory = typeof ExerciseCategory.Type;

export const Exercise = Schema.Struct({
  ...rowFields(ExerciseId),
  name: Schema.NonEmptyString,
  category: ExerciseCategory,
  equipment: Equipment,
  primaryMuscles: JsonArray(Muscle),
  secondaryMuscles: JsonArray(Muscle),
  ...provenanceFields,
}).check(provenanceRule);
export type Exercise = typeof Exercise.Type;

/**
 * An exercise name from another app, and the exercise you matched it to, so the next import
 * from that app uses the same exercise without asking again.
 */
export const ExerciseAlias = Schema.Struct({
  ...rowFields(ExerciseAliasId),
  source: ImportSource,
  name: Schema.NonEmptyString,
  exerciseId: ExerciseId,
});
export type ExerciseAlias = typeof ExerciseAlias.Type;

export const Folder = Schema.Struct({
  ...rowFields(FolderId),
  name: Schema.NonEmptyString,
  position: NonNegativeInt,
});
export type Folder = typeof Folder.Type;

export const Routine = Schema.Struct({
  ...rowFields(RoutineId),
  folderId: Schema.NullOr(FolderId),
  title: Schema.NonEmptyString,
  notes: Schema.String,
  position: NonNegativeInt,
});
export type Routine = typeof Routine.Type;

export const RoutineExercise = Schema.Struct({
  ...rowFields(RoutineExerciseId),
  routineId: RoutineId,
  exerciseId: ExerciseId,
  position: NonNegativeInt,
  supersetGroup: Schema.NullOr(NonNegativeInt),
  restS: Schema.NullOr(DurationSeconds),
  notes: Schema.String,
});
export type RoutineExercise = typeof RoutineExercise.Type;

export const RoutineSet = Schema.Struct({
  ...rowFields(RoutineSetId),
  routineExerciseId: RoutineExerciseId,
  position: NonNegativeInt,
  setType: SetType,
  weightKg: Schema.NullOr(NonNegative),
  repsMin: Schema.NullOr(NonNegativeInt),
  repsMax: Schema.NullOr(NonNegativeInt),
  durationS: Schema.NullOr(DurationSeconds),
  distanceM: Schema.NullOr(NonNegative),
}).check(Schema.makeFilter(repRangeInOrder));
export type RoutineSet = typeof RoutineSet.Type;

export const MeasurementKind = Schema.Literals([
  "body_weight",
  "body_fat",
  "neck",
  "shoulders",
  "chest",
  "left_biceps",
  "right_biceps",
  "left_forearm",
  "right_forearm",
  "abdomen",
  "waist",
  "hips",
  "left_thigh",
  "right_thigh",
  "left_calf",
  "right_calf",
]);
export type MeasurementKind = typeof MeasurementKind.Type;

/** The unit each measurement's value is stored in. */
export const MEASUREMENT_UNIT: Readonly<Record<MeasurementKind, "kg" | "percent" | "cm">> = {
  body_weight: "kg",
  body_fat: "percent",
  neck: "cm",
  shoulders: "cm",
  chest: "cm",
  left_biceps: "cm",
  right_biceps: "cm",
  left_forearm: "cm",
  right_forearm: "cm",
  abdomen: "cm",
  waist: "cm",
  hips: "cm",
  left_thigh: "cm",
  right_thigh: "cm",
  left_calf: "cm",
  right_calf: "cm",
};

/**
 * The values a measurement can take, by unit. A body fat reading is a
 * percentage, and a body weight or tape length outside these is a typo.
 */
export const MEASUREMENT_RANGE: Readonly<
  Record<(typeof MEASUREMENT_UNIT)[MeasurementKind], { readonly min: number; readonly max: number }>
> = {
  kg: { min: 20, max: 400 },
  percent: { min: 1, max: 75 },
  cm: { min: 10, max: 250 },
};

export const isMeasurementValue = (kind: MeasurementKind, value: number): boolean => {
  const { min, max } = MEASUREMENT_RANGE[MEASUREMENT_UNIT[kind]];
  return Number.isFinite(value) && value >= min && value <= max;
};

export const Measurement = Schema.Struct({
  ...rowFields(MeasurementId),
  kind: MeasurementKind,
  measuredAt: EpochMillis,
  value: Schema.Finite,
  ...provenanceFields,
})
  .check(provenanceRule)
  .check(
    Schema.makeFilter((row) =>
      isMeasurementValue(row.kind, row.value)
        ? undefined
        : `a ${row.kind} measurement is within its range`,
    ),
  );
export type Measurement = typeof Measurement.Type;

export const ImportStatus = Schema.Literals(["previewed", "applied", "undone"]);
export type ImportStatus = typeof ImportStatus.Type;

export const ImportBatch = Schema.Struct({
  ...rowFields(ImportBatchId),
  source: ImportSource,
  createdAt: EpochMillis,
  status: ImportStatus,
});
export type ImportBatch = typeof ImportBatch.Type;

export const ImportChangeKind = Schema.Literals(["added", "replaced"]);
export type ImportChangeKind = typeof ImportChangeKind.Type;

/** A record's rows by table name, as a svett file holds them. */
export const RowsByTable = Schema.Record(Schema.String, Schema.Array(Schema.Unknown));
export type RowsByTable = typeof RowsByTable.Type;

/** Row IDs by table name. */
export const RowIdsByTable = Schema.Record(Schema.String, Schema.Array(Uuid));
export type RowIdsByTable = typeof RowIdsByTable.Type;

/**
 * One record an import added or replaced, kept so Undo can take the import back. Undo works
 * from the rows listed here, so it can take back a row whose parent the import never had.
 * Rows from a file pass their tables' schemas through `journalProblem` in transfer.ts.
 */
export const ImportChange = Schema.Struct({
  ...rowFields(ImportChangeId),
  importBatchId: ImportBatchId,
  change: ImportChangeKind,
  /** The table and ID of the record's top row, such as the activity of a workout. */
  itemTable: Schema.NonEmptyString,
  itemId: Uuid,
  title: Schema.String,
  itemAt: Schema.NullOr(EpochMillis),
  /** The rows the import wrote, live or marked deleted. */
  rowIds: Schema.fromJsonString(RowIdsByTable),
  /** The versions of those rows here before the import. Undo puts them back. */
  replaced: Schema.NullOr(Schema.fromJsonString(RowsByTable)),
  /** The fingerprint of the record's rows as the import left them. Any later edit changes it. */
  written: Fingerprint,
}).check(
  Schema.makeFilter((row) =>
    row.change === "replaced" && row.replaced === null
      ? "a replaced record keeps the rows it replaced"
      : undefined,
  ),
);
export type ImportChange = typeof ImportChange.Type;

export const ProposalOrigin = Schema.Literals(["coach", "assistant"]);
export type ProposalOrigin = typeof ProposalOrigin.Type;
export const ProposalStatus = Schema.Literals(["pending", "applied", "dismissed", "undone"]);
export type ProposalStatus = typeof ProposalStatus.Type;

export const Proposal = Schema.Struct({
  ...rowFields(ProposalId),
  origin: ProposalOrigin,
  kind: Schema.NonEmptyString,
  title: Schema.String,
  /** The change and its preview. Each proposal kind parses its own payload. */
  payload: Schema.fromJsonString(Schema.Unknown),
  status: ProposalStatus,
  createdAt: EpochMillis,
  coachMessageId: Schema.NullOr(CoachMessageId),
});
export type Proposal = typeof Proposal.Type;

export const CoachRole = Schema.Literals(["user", "assistant", "tool"]);
export type CoachRole = typeof CoachRole.Type;

export const CoachMessage = Schema.Struct({
  ...rowFields(CoachMessageId),
  conversationId: ConversationId,
  role: CoachRole,
  content: Schema.String,
  createdAt: EpochMillis,
});
export type CoachMessage = typeof CoachMessage.Type;

/**
 * The plates and bars you own in one unit, for the plate and warm-up calculators. Each unit
 * has one row, and a unit with none has a commercial gym's.
 */
export const Gear = Schema.Struct({
  ...rowFields(GearId),
  unit: WeightUnit,
  plates: Schema.fromJsonString(BarsAndPlates.fields.plates),
  bars: Schema.fromJsonString(BarsAndPlates.fields.bars),
});
export type Gear = typeof Gear.Type;
