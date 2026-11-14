import {
  ActivityId,
  type Exercise,
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

/** No line naming what a tool read is longer than this many characters. */
export const MAX_SOURCE = 120;

/** Arguments longer than this are refused before they are read. Every tool's input fits easily. */
export const MAX_ARGUMENTS = 1_000;

const MAX_ERROR = 300;

const clip = (text: string, maximum: number) =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;

/** Bounds a result on every path, so nothing the model or the data holds can make it long. */
const bounded = (result: ToolResult): ToolResult => ({
  output:
    result.output.length <= MAX_TOOL_OUTPUT
      ? result.output
      : JSON.stringify({
          error: "the answer is too long, ask for a shorter range or a lower limit",
        }),
  source: clip(result.source, MAX_SOURCE),
});

const refusal = (name: string, message: string): ToolResult =>
  bounded({
    output: JSON.stringify({ error: clip(message, MAX_ERROR) }),
    source: `${clip(name, 40)} (not read: ${clip(message, MAX_SOURCE)})`,
  });

/**
 * Text the user typed or imported, such as a workout's title or notes. The model gets it under
 * this key, and its instructions say such text is data and never instructions.
 */
const UserText = Schema.Struct({ userWritten: Schema.String });
const userText = (text: string) => ({ userWritten: text });

/** A library exercise's name is svett's own. Any other was written by the user or an import. */
const ExerciseName = Schema.Union([Schema.String, UserText]);
const exerciseLabel = (exercise: Exercise) =>
  exercise.source === "library" ? exercise.name : userText(exercise.name);

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
        if (argumentsJson.length > MAX_ARGUMENTS) {
          return yield* new ToolInputError({ message: "the arguments are too long" });
        }
        const input = yield* decode(argumentsJson).pipe(
          Effect.mapError((issue) => new ToolInputError({ message: issue.message })),
        );
        const output = yield* spec.run(input, context);
        const encoded = yield* encode(output).pipe(Effect.orDie);
        return bounded({ output: JSON.stringify(encoded), source: spec.source(input, output) });
      }).pipe(
        Effect.catchTag("ToolInputError", (error) =>
          Effect.succeed(refusal(spec.name, error.message)),
        ),
        // A database failure is a bug or a broken file, and the user has to see it.
        Effect.orDie,
      ),
  };
};

// Only a pattern with the u flag goes into the JSON schema the model reads.
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)).annotate({
  description: "A day as YYYY-MM-DD, in the phone's time zone",
});
const Limit = (maximum: number) =>
  Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }))).annotate({
    description: `How many to return, at most ${maximum}`,
  });
const Range = { from: Day, to: Day };

const Uuid = Schema.String.check(Schema.isUUID());

const DAY = 86_400_000;
/** The longest range a tool reads, about ten years. */
const MAX_RANGE_DAYS = 3_660;

/** The times a [from, to] day range covers, the last day included. */
const timeRange = (range: { readonly from: string; readonly to: string }, context: ToolContext) =>
  Effect.gen(function* () {
    const start = dayStart(range.from, context.offsetMinutes);
    const end = dayStart(range.to, context.offsetMinutes);
    if (start === null || end === null) {
      return yield* new ToolInputError({ message: "from and to must be real days as YYYY-MM-DD" });
    }
    if (end < start) return yield* new ToolInputError({ message: "to comes before from" });
    if (end - start >= MAX_RANGE_DAYS * DAY) {
      return yield* new ToolInputError({ message: "a range covers at most ten years" });
    }
    return { start, end: end + DAY };
  });

const findExercise = (id: ExerciseId) =>
  Effect.flatMap(Effect.service(ExerciseRepository), (exercises) =>
    Effect.flatMap(exercises.get(id), (found) =>
      Option.isNone(found)
        ? Effect.fail(new ToolInputError({ message: `no exercise has the id ${id}` }))
        : Effect.succeed(found.value),
    ),
  ).pipe(Effect.catchTag("SqlError", Effect.die));

const exerciseName = (id: ExerciseId) => Effect.map(findExercise(id), exerciseLabel);

const plainName = (name: typeof ExerciseName.Type) =>
  typeof name === "string" ? name : name.userWritten;

const SetOut = Schema.Struct({
  day: Schema.String,
  workout: UserText,
  type: Schema.String,
  weightKg: Schema.NullOr(Schema.Number),
  reps: Schema.NullOr(Schema.Number),
  seconds: Schema.NullOr(Schema.Number),
});

const setOut = (set: LoggedSet, context: ToolContext) => ({
  day: localDay(set.startedAt, context.offsetMinutes),
  workout: userText(set.title),
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
        name: ExerciseName,
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
          name: exerciseLabel(exercise),
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
        title: UserText,
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
          title: userText(workout.title),
          kind: workout.kind,
          minutes: Math.round(workout.durationS / 60),
          exercises: workout.exercises,
          workingSets: workout.workingSets,
        })),
      };
    }).pipe(Effect.catchTag("SqlError", Effect.die)),
  source: ({ from, to }, { total }) => `Workouts ${from} to ${to} (${total})`,
});

/** A long workout comes in parts, each small enough to stay well under MAX_TOOL_OUTPUT. */
const MAX_EXERCISES = 8;
const MAX_SETS = 12;
const MAX_NOTES = 500;

const Index = (maximum: number, description: string) =>
  Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }))).annotate({
    description,
  });

const getWorkout = defineTool({
  name: "get_workout",
  description: `Reads one workout with its exercises and sets. Take the id from list_workouts. One answer holds at most ${MAX_EXERCISES} exercises and ${MAX_SETS} sets of each. When truncated is true, call again with exerciseStart set to nextExerciseStart for the next exercises, or with an exercise's index as exerciseStart and its nextSetStart as setStart for the rest of its sets.`,
  input: Schema.Struct({
    workoutId: Uuid.annotate({ description: "The workout id from list_workouts" }),
    exerciseStart: Index(999, "The index of the first exercise to return. 0 when left out."),
    setStart: Index(
      9_999,
      "The index of the first set to return. When it is set, only the exercise at exerciseStart comes back.",
    ),
  }),
  output: Schema.Struct({
    day: Schema.String,
    title: UserText,
    kind: Schema.String,
    minutes: Schema.Number,
    notes: UserText,
    notesTruncated: Schema.Boolean,
    totalExercises: Schema.Number,
    /** True when this answer leaves out any exercise or set of the workout. */
    truncated: Schema.Boolean,
    nextExerciseStart: Schema.NullOr(Schema.Number),
    exercises: Schema.Array(
      Schema.Struct({
        index: Schema.Number,
        name: ExerciseName,
        totalSets: Schema.Number,
        nextSetStart: Schema.NullOr(Schema.Number),
        sets: Schema.Array(
          Schema.Struct({
            index: Schema.Number,
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
  run: ({ workoutId, exerciseStart = 0, setStart = 0 }, context) =>
    Effect.gen(function* () {
      const found = yield* (yield* ActivityRepository).get(ActivityId.make(workoutId));
      if (Option.isNone(found)) {
        return yield* new ToolInputError({ message: `no workout has the id ${workoutId}` });
      }
      const { activity, exercises } = found.value;
      if (exerciseStart > 0 && exerciseStart >= exercises.length) {
        return yield* new ToolInputError({
          message: `the workout has ${exercises.length} exercises, so exerciseStart is at most ${Math.max(exercises.length - 1, 0)}`,
        });
      }
      const page = exercises.slice(
        exerciseStart,
        exerciseStart + (setStart > 0 ? 1 : MAX_EXERCISES),
      );
      const first = page[0];
      if (setStart > 0 && first !== undefined && setStart >= first.sets.length) {
        return yield* new ToolInputError({
          message: `exercise ${exerciseStart} has ${first.sets.length} sets, so setStart is at most ${first.sets.length - 1}`,
        });
      }
      const named = yield* Effect.forEach(page, ({ exercise, sets }, offset) =>
        Effect.map(exerciseName(exercise.exerciseId), (name) => {
          const next = setStart + MAX_SETS;
          return {
            index: exerciseStart + offset,
            name,
            totalSets: sets.length,
            nextSetStart: next < sets.length ? next : null,
            sets: sets.slice(setStart, next).map((set, at) => ({
              index: setStart + at,
              type: set.setType,
              weightKg: set.weightKg,
              reps: set.reps,
              seconds: set.durationS,
              metres: set.distanceM,
              rpe: set.rpe,
            })),
          };
        }),
      );
      const end = exerciseStart + page.length;
      const nextExerciseStart = end < exercises.length ? end : null;
      const notesTruncated = activity.notes.length > MAX_NOTES;
      return {
        day: localDay(activity.startedAt, context.offsetMinutes),
        title: userText(activity.title),
        kind: activity.kind,
        minutes: Math.round(activity.durationS / 60),
        notes: userText(activity.notes.slice(0, MAX_NOTES)),
        notesTruncated,
        totalExercises: exercises.length,
        truncated:
          exerciseStart > 0 ||
          setStart > 0 ||
          nextExerciseStart !== null ||
          named.some((exercise) => exercise.nextSetStart !== null),
        nextExerciseStart,
        exercises: named,
      };
    }).pipe(Effect.catchTag("SqlError", Effect.die)),
  source: (_, { title, day }) => `Workout "${title.userWritten}" on ${day}`,
});

const ExerciseRange = {
  exerciseId: Uuid.annotate({ description: "The exercise id from search_exercises" }),
  ...Range,
};

const exerciseSets = (
  input: { readonly exerciseId: string; readonly from: string; readonly to: string },
  context: ToolContext,
) =>
  Effect.gen(function* () {
    const id = ExerciseId.make(input.exerciseId);
    const exercise = yield* findExercise(id);
    const { start, end } = yield* timeRange(input, context);
    const sets = yield* (yield* TrainingReads).setsOfExercise(id, start, end);
    return { exercise, sets };
  }).pipe(Effect.catchTag("SqlError", Effect.die));

const bestSets = defineTool({
  name: "best_sets",
  description:
    "The user's best working sets of one exercise between two days: heaviest first, then most reps. Warm-ups never count.",
  input: Schema.Struct({ ...ExerciseRange, limit: Limit(5) }),
  output: Schema.Struct({
    exercise: ExerciseName,
    setsLogged: Schema.Number,
    best: Schema.Array(SetOut),
  }),
  run: (input, context) =>
    Effect.map(exerciseSets(input, context), ({ exercise, sets }) => ({
      exercise: exerciseLabel(exercise),
      setsLogged: sets.length,
      best: rankBestSets(sets, input.limit ?? 3).map((set) => setOut(set, context)),
    })),
  source: ({ from, to }, { exercise }) => `Best sets of ${plainName(exercise)}, ${from} to ${to}`,
});

const exerciseHistory = defineTool({
  name: "exercise_history",
  description:
    "One exercise's history between two days, one entry per workout, newest first: the top set, working sets, total reps and volume.",
  input: Schema.Struct({ ...ExerciseRange, limit: Limit(20) }),
  output: Schema.Struct({
    exercise: ExerciseName,
    workouts: Schema.Array(
      Schema.Struct({
        day: Schema.String,
        workout: UserText,
        workingSets: Schema.Number,
        topSet: Schema.NullOr(SetOut),
        totalReps: Schema.Number,
        volumeKg: Schema.Number,
      }),
    ),
  }),
  run: (input, context) =>
    Effect.map(exerciseSets(input, context), ({ exercise, sets }) => ({
      exercise: exerciseLabel(exercise),
      workouts: exerciseSessions(sets)
        .slice(0, input.limit ?? 10)
        .map((session) => ({
          day: localDay(session.startedAt, context.offsetMinutes),
          workout: userText(session.title),
          workingSets: session.workingSets,
          topSet: session.topSet === null ? null : setOut(session.topSet, context),
          totalReps: session.totalReps,
          volumeKg: Math.round(session.volumeKg * 10) / 10,
        })),
    })),
  source: ({ from, to }, { exercise }) => `History of ${plainName(exercise)}, ${from} to ${to}`,
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
const MAX_ROUTINE_EXERCISES = 20;

const listRoutines = defineTool({
  name: "list_routines",
  description: "Lists the user's saved routines with their folder and exercises.",
  input: Schema.Struct({}),
  output: Schema.Struct({
    routines: Schema.Array(
      Schema.Struct({
        title: UserText,
        folder: Schema.NullOr(UserText),
        exercises: Schema.Array(Schema.Struct({ name: ExerciseName, sets: Schema.Number })),
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
            const folder = routine.folderId === null ? undefined : folders.get(routine.folderId);
            return {
              title: userText(routine.title),
              folder: folder === undefined ? null : userText(folder),
              exercises: yield* Effect.forEach(
                exercises.slice(0, MAX_ROUTINE_EXERCISES),
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

/** Runs the tool the model named. A name svett has no tool for gets an error the model reads. */
export const runToolCall = (name: string, argumentsJson: string, context: ToolContext) => {
  const tool = READ_TOOLS.find((each) => each.name === name);
  return tool === undefined
    ? Effect.succeed(refusal(name, `svett has no tool named ${name}`))
    : tool.execute(argumentsJson, context);
};
