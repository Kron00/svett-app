import {
  ActivityId,
  ActivityRepository,
  dayStart,
  ExerciseId,
  ExerciseRepository,
  exerciseSessions,
  type FunctionTool,
  localDay,
  type LoggedSet,
  MEASUREMENT_UNIT,
  MeasurementKind,
  MeasurementRepository,
  rankBestSets,
  RoutineRepository,
  TrainingReads,
} from "@svett/core";
import { Data, Effect, Option, Schema } from "effect";

/** What every tool knows besides its input. */
export interface ToolContext {
  /** The phone's offset from UTC in minutes, which turns days into times. */
  readonly offsetMinutes: number;
}

/** Repositories the read tools use. */
export type ToolServices =
  | ActivityRepository
  | ExerciseRepository
  | MeasurementRepository
  | RoutineRepository
  | TrainingReads;

/** A tool's input was wrong or named something that is not there. The model sees the message. */
export class ToolInputError extends Data.TaggedError("ToolInputError")<{
  readonly message: string;
}> {}

interface ToolSpec<I, O> {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  readonly run: (input: I, context: ToolContext) => Effect.Effect<O, ToolInputError, ToolServices>;
  /** Names the data the tool read, for the line under the coach's answer. */
  readonly source: (input: I, output: O) => string;
}

export interface ToolResult {
  /** The JSON text the model gets back. */
  readonly output: string;
  /** Names the data the tool read. */
  readonly source: string;
}

export interface CoachTool {
  readonly name: string;
  readonly definition: FunctionTool;
  readonly execute: (
    argumentsJson: string,
    context: ToolContext,
  ) => Effect.Effect<ToolResult, never, ToolServices>;
}

/** No tool answer is longer than this many characters. Each tool's limits keep well under it. */
export const MAX_TOOL_OUTPUT = 12_000;

const NO_PARAMETERS = { type: "object", properties: {}, additionalProperties: false };

const parameters = (input: Schema.Top) => {
  const schema = Schema.toJsonSchemaDocument(input, { onExcessProperty: "error" }).schema;
  // An empty struct compiles to "anything but null", and a tool's parameters must be an object.
  return typeof schema === "object" && "properties" in schema ? schema : NO_PARAMETERS;
};

const defineTool = <I, O>(spec: ToolSpec<I, O>): CoachTool => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(spec.input), {
    onExcessProperty: "error",
  });
  const encode = Schema.encodeEffect(spec.output);
  const refused = (message: string): ToolResult => ({
    output: JSON.stringify({ error: message }),
    source: `${spec.name} (not read: ${message})`,
  });
  return {
    name: spec.name,
    definition: {
      type: "function",
      name: spec.name,
      description: spec.description,
      parameters: parameters(spec.input),
    },
    execute: (argumentsJson, context) =>
      Effect.gen(function* () {
        const input = yield* decode(argumentsJson).pipe(
          Effect.mapError((issue) => new ToolInputError({ message: issue.message })),
        );
        const output = yield* spec.run(input, context);
        const encoded = yield* encode(output).pipe(Effect.orDie);
        const text = JSON.stringify(encoded);
        if (text.length > MAX_TOOL_OUTPUT) {
          return refused("the answer is too long, ask for a shorter range or a lower limit");
        }
        return { output: text, source: spec.source(input, output) };
      }).pipe(
        Effect.catchTag("ToolInputError", (error) => Effect.succeed(refused(error.message))),
        // A database failure is a bug or a broken file, and the user has to see it.
        Effect.orDie,
      ),
  };
};

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
  description: "A day as YYYY-MM-DD, in the phone's time zone",
});
const Limit = (maximum: number) =>
  Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }))).annotate({
    description: `How many to return, at most ${maximum}`,
  });
const Range = { from: Day, to: Day };

const DAY = 86_400_000;

/** The times a [from, to] day range covers, the last day included. */
const timeRange = (range: { readonly from: string; readonly to: string }, context: ToolContext) =>
  Effect.gen(function* () {
    const start = dayStart(range.from, context.offsetMinutes);
    const end = dayStart(range.to, context.offsetMinutes);
    if (start === null || end === null) {
      return yield* new ToolInputError({ message: "from and to must be real days as YYYY-MM-DD" });
    }
    if (end < start) return yield* new ToolInputError({ message: "to comes before from" });
    return { start, end: end + DAY };
  });

const exerciseName = (id: ExerciseId) =>
  Effect.flatMap(Effect.service(ExerciseRepository), (exercises) =>
    Effect.flatMap(exercises.get(id), (found) =>
      Option.isNone(found)
        ? Effect.fail(new ToolInputError({ message: `no exercise has the id ${id}` }))
        : Effect.succeed(found.value.name),
    ),
  ).pipe(Effect.catchTag("SqlError", Effect.die));

const SetOut = Schema.Struct({
  day: Schema.String,
  workout: Schema.String,
  type: Schema.String,
  weightKg: Schema.NullOr(Schema.Number),
  reps: Schema.NullOr(Schema.Number),
  seconds: Schema.NullOr(Schema.Number),
});

const setOut = (set: LoggedSet, context: ToolContext) => ({
  day: localDay(set.startedAt, context.offsetMinutes),
  workout: set.title,
  type: set.setType,
  weightKg: set.weightKg,
  reps: set.reps,
  seconds: set.durationS,
});

const searchExercises = defineTool({
  name: "search_exercises",
  description:
    "Finds exercises by name. Exercises the user has logged come first, with how many workouts they appear in. Use it to get an exercise id.",
  input: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)).annotate({
      description: "Words in the exercise name, such as squat or bench press",
    }),
    limit: Limit(10),
  }),
  output: Schema.Struct({
    exercises: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        equipment: Schema.String,
        primaryMuscles: Schema.Array(Schema.String),
        timesLogged: Schema.Number,
      }),
    ),
  }),
  run: ({ query, limit = 5 }) =>
    Effect.gen(function* () {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const logged = yield* (yield* TrainingReads).timesLogged;
      const all = yield* (yield* ExerciseRepository).list;
      const matches = all
        .filter((exercise) => words.every((word) => exercise.name.toLowerCase().includes(word)))
        .map((exercise) => ({ exercise, times: logged.get(exercise.id) ?? 0 }))
        .sort(
          (a, b) =>
            b.times - a.times ||
            a.exercise.name.length - b.exercise.name.length ||
            a.exercise.name.localeCompare(b.exercise.name),
        );
      return {
        exercises: matches.slice(0, limit).map(({ exercise, times }) => ({
          id: exercise.id,
          name: exercise.name,
          equipment: exercise.equipment,
          primaryMuscles: [...exercise.primaryMuscles],
          timesLogged: times,
        })),
      };
    }).pipe(Effect.catchTag("SqlError", Effect.die)),
  source: ({ query }, { exercises }) => `Exercise search "${query}" (${exercises.length} found)`,
});

const listWorkouts = defineTool({
  name: "list_workouts",
  description:
    "Lists the user's workouts between two days, newest first, with how many sets each held.",
  input: Schema.Struct({ ...Range, limit: Limit(20) }),
  output: Schema.Struct({
    total: Schema.Number,
    workouts: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        day: Schema.String,
        title: Schema.String,
        kind: Schema.String,
        minutes: Schema.Number,
        exercises: Schema.Number,
        workingSets: Schema.Number,
      }),
    ),
  }),
  run: (input, context) =>
    Effect.gen(function* () {
      const { start, end } = yield* timeRange(input, context);
      const reads = yield* TrainingReads;
      const workouts = yield* reads.workoutsBetween(start, end, input.limit ?? 20);
      return {
        total: yield* reads.countWorkoutsBetween(start, end),
        workouts: workouts.map((workout) => ({
          id: workout.id,
          day: localDay(workout.startedAt, context.offsetMinutes),
          title: workout.title,
          kind: workout.kind,
          minutes: Math.round(workout.durationS / 60),
          exercises: workout.exercises,
          workingSets: workout.workingSets,
        })),
      };
    }).pipe(Effect.catchTag("SqlError", Effect.die)),
  source: ({ from, to }, { total }) => `Workouts ${from} to ${to} (${total})`,
});

const MAX_EXERCISES = 20;
const MAX_SETS = 15;

const getWorkout = defineTool({
  name: "get_workout",
  description: "Reads one workout with its exercises and sets. Take the id from list_workouts.",
  input: Schema.Struct({ workoutId: Schema.String }),
  output: Schema.Struct({
    day: Schema.String,
    title: Schema.String,
    kind: Schema.String,
    minutes: Schema.Number,
    notes: Schema.String,
    exercises: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        sets: Schema.Array(
          Schema.Struct({
            type: Schema.String,
            weightKg: Schema.NullOr(Schema.Number),
            reps: Schema.NullOr(Schema.Number),
            seconds: Schema.NullOr(Schema.Number),
            metres: Schema.NullOr(Schema.Number),
            rpe: Schema.NullOr(Schema.Number),
          }),
        ),
      }),
    ),
  }),
  run: ({ workoutId }, context) =>
    Effect.gen(function* () {
      const notFound = new ToolInputError({ message: `no workout has the id ${workoutId}` });
      const id = yield* Schema.decodeUnknownEffect(ActivityId)(workoutId).pipe(
        Effect.mapError(() => notFound),
      );
      const found = yield* (yield* ActivityRepository).get(id);
      if (Option.isNone(found)) return yield* notFound;
      const { activity, exercises } = found.value;
      const named = yield* Effect.forEach(exercises.slice(0, MAX_EXERCISES), ({ exercise, sets }) =>
        Effect.map(exerciseName(exercise.exerciseId), (name) => ({
          name,
          sets: sets.slice(0, MAX_SETS).map((set) => ({
            type: set.setType,
            weightKg: set.weightKg,
            reps: set.reps,
            seconds: set.durationS,
            metres: set.distanceM,
            rpe: set.rpe,
          })),
        })),
      );
      return {
        day: localDay(activity.startedAt, context.offsetMinutes),
        title: activity.title,
        kind: activity.kind,
        minutes: Math.round(activity.durationS / 60),
        notes: activity.notes.slice(0, 500),
        exercises: named,
      };
    }).pipe(Effect.catchTag("SqlError", Effect.die)),
  source: (_, { title, day }) => `Workout "${title}" on ${day}`,
});

const ExerciseRange = {
  exerciseId: Schema.String.annotate({ description: "The exercise id from search_exercises" }),
  ...Range,
};

const exerciseSets = (
  input: { readonly exerciseId: string; readonly from: string; readonly to: string },
  context: ToolContext,
) =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(ExerciseId)(input.exerciseId).pipe(
      Effect.mapError(
        () => new ToolInputError({ message: `no exercise has the id ${input.exerciseId}` }),
      ),
    );
    const name = yield* exerciseName(id);
    const { start, end } = yield* timeRange(input, context);
    const sets = yield* (yield* TrainingReads).setsOfExercise(id, start, end);
    return { name, sets };
  }).pipe(Effect.catchTag("SqlError", Effect.die));

const bestSets = defineTool({
  name: "best_sets",
  description:
    "The user's best working sets of one exercise between two days: heaviest first, then most reps. Warm-ups never count.",
  input: Schema.Struct({ ...ExerciseRange, limit: Limit(5) }),
  output: Schema.Struct({
    exercise: Schema.String,
    setsLogged: Schema.Number,
    best: Schema.Array(SetOut),
  }),
  run: (input, context) =>
    Effect.map(exerciseSets(input, context), ({ name, sets }) => ({
      exercise: name,
      setsLogged: sets.length,
      best: rankBestSets(sets, input.limit ?? 3).map((set) => setOut(set, context)),
    })),
  source: ({ from, to }, { exercise }) => `Best sets of ${exercise}, ${from} to ${to}`,
});

const exerciseHistory = defineTool({
  name: "exercise_history",
  description:
    "One exercise's history between two days, one entry per workout, newest first: the top set, working sets, total reps and volume.",
  input: Schema.Struct({ ...ExerciseRange, limit: Limit(20) }),
  output: Schema.Struct({
    exercise: Schema.String,
    workouts: Schema.Array(
      Schema.Struct({
        day: Schema.String,
        workout: Schema.String,
        workingSets: Schema.Number,
        topSet: Schema.NullOr(SetOut),
        totalReps: Schema.Number,
        volumeKg: Schema.Number,
      }),
    ),
  }),
  run: (input, context) =>
    Effect.map(exerciseSets(input, context), ({ name, sets }) => ({
      exercise: name,
      workouts: exerciseSessions(sets)
        .slice(0, input.limit ?? 10)
        .map((session) => ({
          day: localDay(session.startedAt, context.offsetMinutes),
          workout: session.title,
          workingSets: session.workingSets,
          topSet: session.topSet === null ? null : setOut(session.topSet, context),
          totalReps: session.totalReps,
          volumeKg: Math.round(session.volumeKg * 10) / 10,
        })),
    })),
  source: ({ from, to }, { exercise }) => `History of ${exercise}, ${from} to ${to}`,
});

const bodyMeasurements = defineTool({
  name: "body_measurements",
  description:
    "The user's body measurements between two days, newest first, such as body weight, body fat or waist.",
  input: Schema.Struct({
    ...Range,
    kind: Schema.optionalKey(MeasurementKind).annotate({ description: "Only this measurement" }),
    limit: Limit(30),
  }),
  output: Schema.Struct({
    total: Schema.Number,
    measurements: Schema.Array(
      Schema.Struct({
        day: Schema.String,
        kind: Schema.String,
        value: Schema.Number,
        unit: Schema.String,
      }),
    ),
  }),
  run: (input, context) =>
    Effect.gen(function* () {
      const { start, end } = yield* timeRange(input, context);
      const all = yield* (yield* MeasurementRepository).list(input.kind);
      const inRange = all
        .filter((measurement) => measurement.measuredAt >= start && measurement.measuredAt < end)
        .toReversed();
      return {
        total: inRange.length,
        measurements: inRange.slice(0, input.limit ?? 30).map((measurement) => ({
          day: localDay(measurement.measuredAt, context.offsetMinutes),
          kind: measurement.kind,
          value: measurement.value,
          unit: MEASUREMENT_UNIT[measurement.kind],
        })),
      };
    }).pipe(Effect.catchTag("SqlError", Effect.die)),
  source: ({ from, to, kind }) =>
    `${kind === undefined ? "Body measurements" : `Measurements of ${kind.replaceAll("_", " ")}`}, ${from} to ${to}`,
});

const MAX_ROUTINES = 30;

const listRoutines = defineTool({
  name: "list_routines",
  description: "Lists the user's saved routines with their folder and exercises.",
  input: Schema.Struct({}),
  output: Schema.Struct({
    routines: Schema.Array(
      Schema.Struct({
        title: Schema.String,
        folder: Schema.NullOr(Schema.String),
        exercises: Schema.Array(Schema.Struct({ name: Schema.String, sets: Schema.Number })),
      }),
    ),
  }),
  run: () =>
    Effect.gen(function* () {
      const routines = yield* RoutineRepository;
      const folders = new Map(
        (yield* routines.listFolders).map((folder) => [folder.id, folder.name]),
      );
      const list = (yield* routines.listRoutines).slice(0, MAX_ROUTINES);
      return {
        routines: yield* Effect.forEach(list, (routine) =>
          Effect.gen(function* () {
            const detail = yield* routines.getRoutine(routine.id);
            const exercises = Option.isNone(detail) ? [] : detail.value.exercises;
            return {
              title: routine.title,
              folder: routine.folderId === null ? null : (folders.get(routine.folderId) ?? null),
              exercises: yield* Effect.forEach(
                exercises.slice(0, MAX_EXERCISES),
                ({ exercise, sets }) =>
                  Effect.map(exerciseName(exercise.exerciseId), (name) => ({
                    name,
                    sets: sets.length,
                  })),
              ),
            };
          }),
        ),
      };
    }).pipe(Effect.catchTag("SqlError", Effect.die)),
  source: (_, { routines }) => `Routines (${routines.length})`,
});

/** Every read tool, in the order the model sees them. */
export const READ_TOOLS: ReadonlyArray<CoachTool> = [
  searchExercises,
  listWorkouts,
  getWorkout,
  bestSets,
  exerciseHistory,
  bodyMeasurements,
  listRoutines,
];

/** The namespace that holds svett's tools in a request. */
export const TOOL_NAMESPACE = "svett";
