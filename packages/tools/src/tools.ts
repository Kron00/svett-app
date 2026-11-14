import {
  ActivityId,
  type CoachMessageId,
  DurationSeconds,
  createProposal,
  type Exercise,
  ActivityRepository,
  dayStart,
  ExerciseId,
  ExerciseRepository,
  exerciseLibrary,
  exerciseSessions,
  type FunctionTool,
  localDay,
  type LoggedSet,
  MEASUREMENT_UNIT,
  MeasurementKind,
  MeasurementRepository,
  PROPOSAL_LIMITS,
  type ProposalPlan,
  ProposalRepository,
  rankBestSets,
  RoutineRepository,
  SetType,
  TrainingReads,
  unknownExercises,
} from "@svett/core";
import { Data, Effect, Option, Schema } from "effect";

/** What every tool knows besides its input. */
export interface ToolContext {
  /** The phone's offset from UTC in minutes, which turns days into times. */
  readonly offsetMinutes: number;
  /** The user's question a tool call answers. A proposal stays linked to it. */
  readonly questionId?: CoachMessageId;
}

/** Repositories the tools use. Only the proposal tools write, and only to proposal. */
export type ToolServices =
  | ActivityRepository
  | ExerciseRepository
  | MeasurementRepository
  | ProposalRepository
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
  /** A tool that proposes a change. Its result names the proposal, or why there is none. */
  readonly proposes?: (output: O) => string;
  /** Arguments longer than this are refused. MAX_ARGUMENTS when left out. */
  readonly maxArguments?: number;
}

export interface ToolResult {
  /** The JSON text the model gets back. */
  readonly output: string;
  /** Names the data the tool read, or for a proposal tool, what it proposed. */
  readonly source: string;
  /** The proposal a proposal tool stored. */
  readonly proposalId?: string;
  /** Why a proposal tool stored nothing. The chat shows it. */
  readonly problem?: string;
}

export interface CoachTool {
  readonly name: string;
  readonly definition: FunctionTool;
  readonly execute: (
    argumentsJson: string,
    context: ToolContext,
  ) => Effect.Effect<ToolResult, never, ToolServices>;
}

/**
 * No tool answer is longer than this many characters. The paged tools fill each answer up to it,
 * and the other tools' limits keep well under it.
 */
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

const refusal = (name: string, message: string, proposes = false): ToolResult => {
  const result = bounded({
    output: JSON.stringify({ error: clip(message, MAX_ERROR) }),
    source: `${clip(name, 40)} (${proposes ? "nothing proposed" : "not read"}: ${clip(message, MAX_SOURCE)})`,
  });
  return proposes ? { ...result, problem: clip(message, MAX_ERROR) } : result;
};

/**
 * Text the user typed or imported, such as a workout's title or notes. The model gets it under
 * this key, and its instructions say such text is data and never instructions.
 */
const UserText = Schema.Struct({ userWritten: Schema.String });

/** A title or name longer than this is cut, so one row can never fill an answer. */
const MAX_NAME = 120;

const userText = (text: string, maximum = MAX_NAME) => ({ userWritten: clip(text, maximum) });

/**
 * A name is svett's own only when it is the bundled library's name for that ID. A row can keep
 * source "library" through an edited export and import with a name the user wrote.
 */
const ExerciseName = Schema.Union([Schema.String, UserText]);
let libraryNames: ReadonlyMap<string, string> | undefined;
const exerciseLabel = (exercise: Exercise) => {
  libraryNames ??= new Map(exerciseLibrary().map((entry) => [entry.id, entry.name]));
  return libraryNames.get(exercise.id) === exercise.name ? exercise.name : userText(exercise.name);
};

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
        if (argumentsJson.length > (spec.maxArguments ?? MAX_ARGUMENTS)) {
          return yield* new ToolInputError({ message: "the arguments are too long" });
        }
        const input = yield* decode(argumentsJson).pipe(
          Effect.mapError((issue) => new ToolInputError({ message: issue.message })),
        );
        const output = yield* spec.run(input, context);
        const encoded = yield* encode(output).pipe(Effect.orDie);
        const result = bounded({
          output: JSON.stringify(encoded),
          source: spec.source(input, output),
        });
        return spec.proposes === undefined
          ? result
          : { ...result, proposalId: spec.proposes(output) };
      }).pipe(
        Effect.catchTag("ToolInputError", (error) =>
          Effect.succeed(refusal(spec.name, error.message, spec.proposes !== undefined)),
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

/**
 * How many items of each group go in one answer. It takes groups in order and their items in
 * order while `size` of the answer stays within MAX_TOOL_OUTPUT, and a group cut short ends the
 * answer. The first item of the first group always goes in, so following the cursors moves on.
 *
 * @param offered how many items each group could show, in order
 * @param size the length of the answer that shows `counts[i]` items of group i
 */
const fillPage = (
  offered: ReadonlyArray<number>,
  size: (counts: ReadonlyArray<number>) => number,
): ReadonlyArray<number> => {
  const counts: number[] = [];
  for (const available of offered) {
    const fits = (count: number) => size([...counts, count]) <= MAX_TOOL_OUTPUT;
    let count = Math.min(available, 1);
    if (counts.length > 0 && !fits(count)) break;
    while (count < available && fits(count + 1)) count++;
    counts.push(count);
    if (count < available) break;
  }
  return counts;
};

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

/** The most one part of a long workout holds. fillPage keeps each part within MAX_TOOL_OUTPUT. */
const MAX_EXERCISES = 8;
const MAX_SETS = 12;
const MAX_NOTES = 500;

const Index = (maximum: number, description: string) =>
  Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }))).annotate({
    description,
  });

const getWorkout = defineTool({
  name: "get_workout",
  description: `Reads one workout with its exercises and sets. Take the id from list_workouts. One answer holds as many exercises and sets as fit, at most ${MAX_EXERCISES} exercises and ${MAX_SETS} sets of each. When truncated is true, call again with exerciseStart set to nextExerciseStart for the next exercises, and for an exercise whose nextSetStart is a number, call with its index as exerciseStart and its nextSetStart as setStart for the rest of its sets.`,
  input: Schema.Struct({
    workoutId: Uuid.annotate({ description: "The workout id from list_workouts" }),
    exerciseStart: Index(999, "The index of the first exercise to return. 0 when left out."),
    setStart: Index(
      9_999,
      "The index of the first set to return. When it is given, 0 included, only the exercise at exerciseStart comes back.",
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
  run: ({ workoutId, exerciseStart = 0, setStart }, context) =>
    Effect.gen(function* () {
      const found = yield* (yield* ActivityRepository).get(ActivityId.make(workoutId));
      if (Option.isNone(found)) {
        return yield* new ToolInputError({ message: `no workout has the id ${workoutId}` });
      }
      const { activity, exercises } = found.value;
      const single = setStart !== undefined;
      if ((exerciseStart > 0 || single) && exerciseStart >= exercises.length) {
        return yield* new ToolInputError({
          message: `the workout has ${exercises.length} exercises, so exerciseStart is at most ${Math.max(exercises.length - 1, 0)}`,
        });
      }
      const firstSet = setStart ?? 0;
      const target = exercises[exerciseStart];
      if (firstSet > 0 && target !== undefined && firstSet >= target.sets.length) {
        return yield* new ToolInputError({
          message: `exercise ${exerciseStart} has ${target.sets.length} sets, so setStart is at most ${target.sets.length - 1}`,
        });
      }
      const candidates = yield* Effect.forEach(
        exercises.slice(exerciseStart, exerciseStart + (single ? 1 : MAX_EXERCISES)),
        ({ exercise, sets }, offset) =>
          Effect.map(exerciseName(exercise.exerciseId), (name) => {
            const start = offset === 0 ? firstSet : 0;
            return {
              index: exerciseStart + offset,
              name,
              totalSets: sets.length,
              start,
              sets: sets.slice(start, start + MAX_SETS).map((set, at) => ({
                index: start + at,
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
      const answer = (counts: ReadonlyArray<number>) => {
        const shown = counts.map((count, at) => {
          const { start, sets, ...exercise } = candidates[at]!;
          const next = start + count;
          return {
            ...exercise,
            nextSetStart: next < exercise.totalSets ? next : null,
            sets: sets.slice(0, count),
          };
        });
        const end = exerciseStart + shown.length;
        const nextExerciseStart = end < exercises.length ? end : null;
        return {
          day: localDay(activity.startedAt, context.offsetMinutes),
          title: userText(activity.title),
          kind: activity.kind,
          minutes: Math.round(activity.durationS / 60),
          notes: userText(activity.notes, MAX_NOTES),
          notesTruncated: activity.notes.length > MAX_NOTES,
          totalExercises: exercises.length,
          truncated:
            exerciseStart > 0 ||
            firstSet > 0 ||
            nextExerciseStart !== null ||
            shown.some((exercise) => exercise.nextSetStart !== null),
          nextExerciseStart,
          exercises: shown,
        };
      };
      return answer(
        fillPage(
          candidates.map((exercise) => exercise.sets.length),
          (counts) => JSON.stringify(answer(counts)).length,
        ),
      );
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
  description: `Lists the user's saved routines with their folder and exercises. One answer holds as many routines and exercises as fit, at most ${MAX_ROUTINES} routines and ${MAX_ROUTINE_EXERCISES} exercises of each. When truncated is true, call again with routineStart set to nextRoutineStart for the next routines, and for a routine whose nextExerciseStart is a number, call with its index as routineStart and its nextExerciseStart as exerciseStart for the rest of its exercises.`,
  input: Schema.Struct({
    routineStart: Index(9_999, "The index of the first routine to return. 0 when left out."),
    exerciseStart: Index(
      999,
      "The index of the first exercise to return. When it is given, 0 included, only the routine at routineStart comes back.",
    ),
  }),
  output: Schema.Struct({
    totalRoutines: Schema.Number,
    /** True when this answer leaves out any routine or exercise. */
    truncated: Schema.Boolean,
    nextRoutineStart: Schema.NullOr(Schema.Number),
    routines: Schema.Array(
      Schema.Struct({
        index: Schema.Number,
        title: UserText,
        folder: Schema.NullOr(UserText),
        totalExercises: Schema.Number,
        nextExerciseStart: Schema.NullOr(Schema.Number),
        exercises: Schema.Array(
          Schema.Struct({ index: Schema.Number, name: ExerciseName, sets: Schema.Number }),
        ),
      }),
    ),
  }),
  run: ({ routineStart = 0, exerciseStart }) =>
    Effect.gen(function* () {
      const routines = yield* RoutineRepository;
      const folders = new Map(
        (yield* routines.listFolders).map((folder) => [folder.id, folder.name]),
      );
      const all = yield* routines.listRoutines;
      const single = exerciseStart !== undefined;
      if ((routineStart > 0 || single) && routineStart >= all.length) {
        return yield* new ToolInputError({
          message: `the user has ${all.length} routines, so routineStart is at most ${Math.max(all.length - 1, 0)}`,
        });
      }
      const firstExercise = exerciseStart ?? 0;
      const candidates = yield* Effect.forEach(
        all.slice(routineStart, routineStart + (single ? 1 : MAX_ROUTINES)),
        (routine, offset) =>
          Effect.gen(function* () {
            const detail = yield* routines.getRoutine(routine.id);
            const exercises = Option.isNone(detail) ? [] : detail.value.exercises;
            const start = offset === 0 ? firstExercise : 0;
            if (start > 0 && start >= exercises.length) {
              return yield* new ToolInputError({
                message: `routine ${routineStart} has ${exercises.length} exercises, so exerciseStart is at most ${Math.max(exercises.length - 1, 0)}`,
              });
            }
            const folder = routine.folderId === null ? undefined : folders.get(routine.folderId);
            return {
              index: routineStart + offset,
              title: userText(routine.title),
              folder: folder === undefined ? null : userText(folder),
              totalExercises: exercises.length,
              start,
              exercises: yield* Effect.forEach(
                exercises.slice(start, start + MAX_ROUTINE_EXERCISES),
                ({ exercise, sets }, at) =>
                  Effect.map(exerciseName(exercise.exerciseId), (name) => ({
                    index: start + at,
                    name,
                    sets: sets.length,
                  })),
              ),
            };
          }),
      );
      const answer = (counts: ReadonlyArray<number>) => {
        const shown = counts.map((count, at) => {
          const { start, exercises, ...routine } = candidates[at]!;
          const next = start + count;
          return {
            ...routine,
            nextExerciseStart: next < routine.totalExercises ? next : null,
            exercises: exercises.slice(0, count),
          };
        });
        const end = routineStart + shown.length;
        const nextRoutineStart = end < all.length ? end : null;
        return {
          totalRoutines: all.length,
          truncated:
            routineStart > 0 ||
            firstExercise > 0 ||
            nextRoutineStart !== null ||
            shown.some((routine) => routine.nextExerciseStart !== null),
          nextRoutineStart,
          routines: shown,
        };
      };
      return answer(
        fillPage(
          candidates.map((routine) => routine.exercises.length),
          (counts) => JSON.stringify(answer(counts)).length,
        ),
      );
    }).pipe(Effect.catchTag("SqlError", Effect.die)),
  source: (_, { totalRoutines, truncated, routines }) => {
    if (!truncated) return `Routines (${totalRoutines})`;
    const first = routines[0]?.index ?? 0;
    const shown = `Routines ${first + 1} to ${first + routines.length} of ${totalRoutines}`;
    return routines.some((routine) => routine.exercises.length < routine.totalExercises)
      ? `${shown}, some of their exercises left out`
      : shown;
  },
});

/** A proposal's arguments may be this long. A seven-routine program fits easily. */
const MAX_PROPOSAL_ARGUMENTS = 40_000;

const Between = (minimum: number, maximum: number, description: string, integer = true) =>
  Schema.optionalKey(
    (integer ? Schema.Int : Schema.Finite).check(Schema.isBetween({ minimum, maximum })),
  ).annotate({ description });

const Text = (maximum: number, description: string) =>
  Schema.String.check(Schema.isMaxLength(maximum)).annotate({ description });

const SetIn = Schema.Struct({
  type: Schema.optionalKey(SetType).annotate({
    description: "The set's type. normal when left out",
  }),
  weightKg: Between(0, 1_000, "The target weight in kilograms", false),
  repsMin: Between(
    1,
    100,
    "The target reps. For an exact count give only repsMin, for a range give repsMin and repsMax",
  ),
  repsMax: Between(1, 100, "The top of a rep range"),
  seconds: Between(1, 36_000, "A target time in seconds, for holds and cardio"),
  metres: Between(1, 100_000, "A target distance in metres", false),
});

const ExerciseIn = Schema.Struct({
  exerciseId: Uuid.annotate({ description: "The exercise id from search_exercises" }),
  sets: Schema.Array(SetIn)
    .check(
      Schema.isMinLength(1),
      Schema.isMaxLength(PROPOSAL_LIMITS.sets, {
        message: `an exercise holds at most ${PROPOSAL_LIMITS.sets} sets`,
      }),
    )
    .annotate({ description: "The sets in order" }),
  restSeconds: Between(0, 900, "Rest after each set, in seconds"),
  notes: Schema.optionalKey(Text(200, "A short cue for the user")),
});

const RoutineIn = Schema.Struct({
  title: Text(PROPOSAL_LIMITS.title, "The routine's name").check(Schema.isMinLength(1)),
  notes: Schema.optionalKey(Text(PROPOSAL_LIMITS.notes, "What the routine is for")),
  exercises: Schema.Array(ExerciseIn)
    .check(
      Schema.isMinLength(1),
      Schema.isMaxLength(PROPOSAL_LIMITS.exercises, {
        message: `a routine holds at most ${PROPOSAL_LIMITS.exercises} exercises`,
      }),
    )
    .annotate({ description: "The exercises in order" }),
});
type RoutineIn = typeof RoutineIn.Type;

const ProposalOut = Schema.Struct({ proposalId: Schema.String, shown: Schema.String });

/** The routine a tool's input plans, or the first set whose rep range runs backwards. */
const plannedRoutine = (routine: RoutineIn, where: string) =>
  Effect.gen(function* () {
    const exercises = [];
    for (const [index, exercise] of routine.exercises.entries()) {
      const sets = [];
      for (const [setIndex, set] of exercise.sets.entries()) {
        const repsMin = set.repsMin ?? set.repsMax ?? null;
        const repsMax = set.repsMax ?? set.repsMin ?? null;
        if (repsMin !== null && repsMax !== null && repsMin > repsMax) {
          return yield* new ToolInputError({
            message: `${where}exercise ${index} set ${setIndex} has repsMin above repsMax`,
          });
        }
        sets.push({
          setType: set.type ?? "normal",
          weightKg: set.weightKg ?? null,
          repsMin,
          repsMax,
          durationS: set.seconds === undefined ? null : DurationSeconds.make(set.seconds),
          distanceM: set.metres ?? null,
        });
      }
      exercises.push({
        exerciseId: ExerciseId.make(exercise.exerciseId),
        restS:
          exercise.restSeconds === undefined ? null : DurationSeconds.make(exercise.restSeconds),
        notes: exercise.notes ?? "",
        sets,
      });
    }
    return { title: routine.title, notes: routine.notes ?? "", exercises };
  });

/** Stores the plan as a proposal once every exercise it names is in the user's library. */
const propose = (plan: ProposalPlan, context: ToolContext) =>
  Effect.gen(function* () {
    const ids = (plan.kind === "routine" ? [plan.routine] : plan.routines).flatMap((routine) =>
      routine.exercises.map((exercise) => exercise.exerciseId),
    );
    const known = yield* (yield* ExerciseRepository).names(ids);
    const unknown = unknownExercises(plan, new Set(known.keys()));
    if (unknown.length > 0) {
      return yield* new ToolInputError({
        message: `no exercise has the id ${unknown.join(", ")}. Find exercise ids with search_exercises, then propose again`,
      });
    }
    const id = yield* createProposal(plan, context.questionId ?? null);
    return {
      proposalId: id,
      shown:
        "The user sees it as a preview with Apply. Nothing is saved until they tap Apply, so do not say it was saved.",
    };
  }).pipe(Effect.catchTag("SqlError", Effect.die), Effect.catchTag("InvalidRowError", Effect.die));

const proposeRoutine = defineTool({
  name: "propose_routine",
  description:
    "Proposes one new routine. The user sees it as a preview and decides whether to apply it, so nothing is saved by this call. Use exercise ids from search_exercises.",
  maxArguments: MAX_PROPOSAL_ARGUMENTS,
  input: RoutineIn,
  output: ProposalOut,
  run: (input, context) =>
    Effect.flatMap(plannedRoutine(input, ""), (routine) =>
      propose({ kind: "routine", routine }, context),
    ),
  source: ({ title }) => `Proposed the routine "${title}"`,
  proposes: ({ proposalId }) => proposalId,
});

const proposeProgram = defineTool({
  name: "propose_program",
  description: `Proposes a program: a new folder of ${PROPOSAL_LIMITS.routines} routines at most, such as one per training day. The user sees it as a preview and decides whether to apply it, so nothing is saved by this call. Use exercise ids from search_exercises.`,
  maxArguments: MAX_PROPOSAL_ARGUMENTS,
  input: Schema.Struct({
    folder: Text(PROPOSAL_LIMITS.folder, "The program's name, which names its folder").check(
      Schema.isMinLength(1),
    ),
    routines: Schema.Array(RoutineIn)
      .check(
        Schema.isMinLength(2),
        Schema.isMaxLength(PROPOSAL_LIMITS.routines, {
          message: `a program holds at most ${PROPOSAL_LIMITS.routines} routines`,
        }),
      )
      .annotate({ description: "The program's routines in order" }),
  }),
  output: ProposalOut,
  run: (input, context) =>
    Effect.gen(function* () {
      const routines = yield* Effect.forEach(input.routines, (routine, index) =>
        plannedRoutine(routine, `routine ${index} `),
      );
      return yield* propose({ kind: "program", folder: input.folder, routines }, context);
    }),
  source: ({ folder, routines }) =>
    `Proposed the program "${folder}" of ${routines.length} routines`,
  proposes: ({ proposalId }) => proposalId,
});

/** The tools that propose a change for the user to apply. They never change data themselves. */
export const PROPOSAL_TOOLS: ReadonlyArray<CoachTool> = [proposeRoutine, proposeProgram];

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

/** Every tool the coach offers, in the order the model sees them. */
export const COACH_TOOLS: ReadonlyArray<CoachTool> = [...READ_TOOLS, ...PROPOSAL_TOOLS];

/** Runs the tool the model named. A name svett has no tool for gets an error the model reads. */
export const runToolCall = (name: string, argumentsJson: string, context: ToolContext) => {
  const tool = COACH_TOOLS.find((each) => each.name === name);
  return tool === undefined
    ? Effect.succeed(refusal(name, `svett has no tool named ${name}`))
    : tool.execute(argumentsJson, context);
};
