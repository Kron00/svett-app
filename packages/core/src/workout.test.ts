import { describe, expect, it } from "vite-plus/test";

import {
  applyCommand,
  encodeWorkout,
  restoreWorkout,
  restRemainingSeconds,
  startWorkout,
  workoutDurationSeconds,
  type SetFields,
  type Workout,
  type WorkoutCommand,
} from "./workout.ts";

const T0 = Date.UTC(2026, 10, 13, 17, 0, 0);
const at = (seconds: number): number => T0 + seconds * 1000;

const log = (
  commands: ReadonlyArray<WorkoutCommand>,
  from: Workout = startWorkout("w1", T0),
): Workout => commands.reduce(applyCommand, from);

const restore = (text: string): Workout => {
  const workout = restoreWorkout(text);
  if (workout === undefined) throw new Error("the workout did not restore");
  return workout;
};

const beforeCrash: ReadonlyArray<WorkoutCommand> = [
  { _tag: "AddExercise", entryId: "e1", exerciseId: "bench-press", restSeconds: 120 },
  { _tag: "AddSet", entryId: "e1", setId: "s1", kind: "warmup" },
  { _tag: "UpdateSet", setId: "s1", fields: { weightKg: 60, reps: 10 } },
  { _tag: "CompleteSet", setId: "s1", at: at(60) },
  { _tag: "SkipRest", setId: "s1" },
  { _tag: "AddSet", entryId: "e1", setId: "s2", kind: "normal" },
  { _tag: "UpdateSet", setId: "s2", fields: { weightKg: 100, reps: 5, rpe: 9 } },
  { _tag: "SetRest", setId: "s2", restSeconds: 180 },
  { _tag: "CompleteSet", setId: "s2", at: at(300) },
  { _tag: "AdjustRest", setId: "s2", endsAt: at(510) },
];

const afterRelaunch: ReadonlyArray<WorkoutCommand> = [
  { _tag: "AddExercise", entryId: "e2", exerciseId: "barbell-row", restSeconds: 90 },
  { _tag: "AddSet", entryId: "e2", setId: "s3", kind: "normal" },
  { _tag: "CompleteSet", setId: "s3", at: at(600) },
  { _tag: "UncompleteSet", setId: "s3" },
  { _tag: "AddSet", entryId: "e2", setId: "s4", kind: "normal" },
  { _tag: "RemoveSet", setId: "s4" },
  { _tag: "MoveExercise", entryId: "e2", toIndex: 0 },
  { _tag: "AddSet", entryId: "e1", setId: "s5", kind: "normal" },
  { _tag: "CompleteSet", setId: "s5", at: at(700) },
];

const session = [...beforeCrash, ...afterRelaunch];

const benchWithTimer = log([
  { _tag: "AddExercise", entryId: "e1", exerciseId: "bench-press", restSeconds: 120 },
  { _tag: "AddSet", entryId: "e1", setId: "s1", kind: "normal" },
  { _tag: "AddSet", entryId: "e1", setId: "s2", kind: "normal" },
  { _tag: "CompleteSet", setId: "s1", at: at(0) },
]);

describe("crash recovery", () => {
  it("continues after a kill and relaunch exactly as if the app never died", () => {
    const killed = log(beforeCrash);
    const relaunched = restore(encodeWorkout(killed));

    expect(relaunched).toEqual(killed);
    expect(restRemainingSeconds(relaunched, at(400))).toBe(110);
    expect(log(afterRelaunch, relaunched)).toEqual(log(session));
  });

  it("converges when the whole command log is replayed on top of itself", () => {
    expect(log([...session, ...session])).toEqual(log(session));
    expect(restRemainingSeconds(log([...session, ...session]), at(700))).toBe(120);
  });

  it.each([
    ["empty text", ""],
    ["truncated JSON", encodeWorkout(log(session)).slice(0, 200)],
    ["plain text", "workout"],
    ["JSON null", "null"],
    ["the wrong shape", JSON.stringify({ id: "w1", exercises: [] })],
    ["negative reps", encodeWorkout(log(session)).replace('"reps":5', '"reps":-5')],
    ["an unknown phase", encodeWorkout(log(session)).replace('"_tag":"Active"', '"_tag":"Paused"')],
  ])("restores %s to undefined", (_, text) => {
    expect(restoreWorkout(text)).toBeUndefined();
  });
});

describe("rest timer", () => {
  it.each([
    [0, 120],
    [90, 30],
    [90.5, 30],
    [119.2, 1],
    [120, 0],
    [600, 0],
  ])("reads the wall clock after the app was dead, %s s in leaves %s s", (seconds, left) => {
    const relaunched = restore(encodeWorkout(benchWithTimer));
    expect(restRemainingSeconds(relaunched, at(seconds))).toBe(left);
  });

  it("rests 180 s after a set with its own rest, then the exercise's 120 s after the next", () => {
    const heavy = applyCommand(benchWithTimer, { _tag: "UncompleteSet", setId: "s1" });
    const overridden = log(
      [
        { _tag: "SetRest", setId: "s1", restSeconds: 180 },
        { _tag: "CompleteSet", setId: "s1", at: at(10) },
      ],
      heavy,
    );
    expect(restRemainingSeconds(overridden, at(10))).toBe(180);

    const next = applyCommand(overridden, { _tag: "CompleteSet", setId: "s2", at: at(300) });
    expect(restRemainingSeconds(next, at(300))).toBe(120);
  });

  it("goes back to the exercise's rest when a set's own rest is cleared", () => {
    const workout = log(
      [
        { _tag: "UncompleteSet", setId: "s1" },
        { _tag: "SetRest", setId: "s1", restSeconds: 180 },
        { _tag: "SetRest", setId: "s1", restSeconds: null },
        { _tag: "CompleteSet", setId: "s1", at: at(10) },
      ],
      benchWithTimer,
    );
    expect(restRemainingSeconds(workout, at(10))).toBe(120);
  });

  it.each<[string, number, ReadonlyArray<WorkoutCommand>]>([
    ["the exercise's rest is off", 0, []],
    ["the set's own rest is off", 120, [{ _tag: "SetRest", setId: "s1", restSeconds: 0 }]],
  ])("starts no timer when %s", (_, exerciseRest, extra) => {
    const workout = log([
      { _tag: "AddExercise", entryId: "e1", exerciseId: "plank", restSeconds: exerciseRest },
      { _tag: "AddSet", entryId: "e1", setId: "s1", kind: "normal" },
      ...extra,
      { _tag: "CompleteSet", setId: "s1", at: at(0) },
    ]);
    expect(restRemainingSeconds(workout, at(0))).toBeNull();
  });

  it("keeps the first completion and its timer when a set is completed again", () => {
    const again = applyCommand(benchWithTimer, { _tag: "CompleteSet", setId: "s1", at: at(50) });
    expect(again).toEqual(benchWithTimer);
    expect(restRemainingSeconds(again, at(50))).toBe(70);
  });

  it.each([
    ["adds 30 s", at(150), at(150), 150],
    ["takes 30 s off", at(90), at(90), 90],
    ["stops at the moment the set was done", at(-60), at(0), 0],
  ])("moves the deadline when the lifter %s", (_, endsAt, expectedEnd, left) => {
    const adjusted = applyCommand(benchWithTimer, { _tag: "AdjustRest", setId: "s1", endsAt });
    expect(adjusted.phase).toEqual({ _tag: "Active", rest: { setId: "s1", endsAt: expectedEnd } });
    expect(restRemainingSeconds(adjusted, at(0))).toBe(left);
  });

  it.each<WorkoutCommand>([
    { _tag: "SkipRest", setId: "s1" },
    { _tag: "UncompleteSet", setId: "s1" },
    { _tag: "RemoveSet", setId: "s1" },
    { _tag: "RemoveExercise", entryId: "e1" },
  ])("ends the timer on $_tag of the resting set", (command) => {
    expect(restRemainingSeconds(applyCommand(benchWithTimer, command), at(0))).toBeNull();
  });

  it.each<WorkoutCommand>([
    { _tag: "SkipRest", setId: "s2" },
    { _tag: "UncompleteSet", setId: "s2" },
    { _tag: "RemoveSet", setId: "s2" },
    { _tag: "AdjustRest", setId: "s2", endsAt: at(999) },
  ])("keeps the timer on $_tag of another set", (command) => {
    expect(restRemainingSeconds(applyCommand(benchWithTimer, command), at(0))).toBe(120);
  });
});

describe("logging sets", () => {
  it.each<[string, SetFields, SetFields]>([
    ["lifting", { weightKg: 100, reps: 5, rpe: 8 }, { weightKg: 100, reps: 5 }],
    ["cardio", { seconds: 600, meters: 2000 }, { seconds: 600, meters: 2000 }],
  ])("prefills a new %s set from the previous set", (_, fields, prefilled) => {
    const workout = log([
      { _tag: "AddExercise", entryId: "e1", exerciseId: "any", restSeconds: 120 },
      { _tag: "AddSet", entryId: "e1", setId: "s1", kind: "normal" },
      { _tag: "UpdateSet", setId: "s1", fields },
      { _tag: "SetRest", setId: "s1", restSeconds: 180 },
      { _tag: "CompleteSet", setId: "s1", at: at(0) },
      { _tag: "AddSet", entryId: "e1", setId: "s2", kind: "drop" },
    ]);
    expect(workout.exercises[0]?.sets).toEqual([
      { id: "s1", kind: "normal", ...fields, restSeconds: 180, completedAt: at(0) },
      { id: "s2", kind: "drop", ...prefilled, completedAt: null },
    ]);
  });

  it("starts an exercise's first set empty", () => {
    const workout = log([
      { _tag: "AddExercise", entryId: "e1", exerciseId: "squat", restSeconds: 180 },
      { _tag: "AddSet", entryId: "e1", setId: "s1", kind: "warmup" },
    ]);
    expect(workout.exercises[0]?.sets).toEqual([{ id: "s1", kind: "warmup", completedAt: null }]);
  });

  it("changes the set kind and clears a field set to null", () => {
    const workout = applyCommand(log(session), {
      _tag: "UpdateSet",
      setId: "s2",
      fields: { kind: "failure", rpe: null },
    });
    expect(workout.exercises[1]?.sets[1]).toEqual({
      id: "s2",
      kind: "failure",
      weightKg: 100,
      reps: 5,
      restSeconds: 180,
      completedAt: at(300),
    });
  });

  it("moves exercises, clamping the index to the list", () => {
    const three = log([
      { _tag: "AddExercise", entryId: "e1", exerciseId: "squat", restSeconds: 180 },
      { _tag: "AddExercise", entryId: "e2", exerciseId: "bench-press", restSeconds: 120 },
      { _tag: "AddExercise", entryId: "e3", exerciseId: "deadlift", restSeconds: 180 },
      { _tag: "MoveExercise", entryId: "e1", toIndex: 99 },
    ]);
    expect(three.exercises.map((exercise) => exercise.id)).toEqual(["e2", "e3", "e1"]);
    const moved = applyCommand(three, { _tag: "MoveExercise", entryId: "e3", toIndex: 0 });
    expect(moved.exercises.map((exercise) => exercise.id)).toEqual(["e3", "e2", "e1"]);
  });

  it.each<WorkoutCommand>([
    { _tag: "AddExercise", entryId: "e1", exerciseId: "squat", restSeconds: 60 },
    { _tag: "RemoveExercise", entryId: "missing" },
    { _tag: "MoveExercise", entryId: "missing", toIndex: 0 },
    { _tag: "AddSet", entryId: "missing", setId: "s9", kind: "normal" },
    { _tag: "AddSet", entryId: "e2", setId: "s1", kind: "normal" },
    { _tag: "RemoveSet", setId: "missing" },
    { _tag: "UpdateSet", setId: "missing", fields: { reps: 5 } },
    { _tag: "CompleteSet", setId: "missing", at: at(800) },
    { _tag: "UncompleteSet", setId: "missing" },
    { _tag: "SetRest", setId: "missing", restSeconds: 60 },
    { _tag: "AdjustRest", setId: "missing", endsAt: at(800) },
    { _tag: "SkipRest", setId: "missing" },
  ])("ignores $_tag with an unknown or taken id", (command) => {
    expect(applyCommand(log(session), command)).toEqual(log(session));
  });

  it.each<WorkoutCommand>([
    { _tag: "UpdateSet", setId: "s3", fields: { reps: -1 } },
    { _tag: "UpdateSet", setId: "s3", fields: { reps: 2.5 } },
    { _tag: "UpdateSet", setId: "s3", fields: { rpe: 11 } },
    { _tag: "UpdateSet", setId: "s3", fields: { weightKg: Number.NaN } },
    { _tag: "UpdateSet", setId: "s3", fields: { meters: Number.POSITIVE_INFINITY } },
    { _tag: "SetRest", setId: "s3", restSeconds: -30 },
    { _tag: "CompleteSet", setId: "s3", at: Number.NaN },
  ])("ignores $_tag with an out-of-range value, so the workout always saves", (command) => {
    const workout = applyCommand(log(session), command);
    expect(workout).toEqual(log(session));
    expect(restore(encodeWorkout(workout))).toEqual(workout);
  });
});

describe("ending a workout", () => {
  it("counts the whole session, not the time since the last edit", () => {
    const finished = log([...session, { _tag: "Finish", at: at(3600) }]);
    expect(workoutDurationSeconds(log(session), at(1800))).toBe(1800);
    expect(workoutDurationSeconds(finished, at(5 * 3600))).toBe(3600);
    expect(workoutDurationSeconds(restore(encodeWorkout(finished)), at(9 * 3600))).toBe(3600);
  });

  it.each(["Finish", "Discard"] as const)("ignores every command after %s", (tag) => {
    const ended = applyCommand(log(session), { _tag: tag, at: at(3600) });
    expect(ended.phase).toEqual({
      _tag: tag === "Finish" ? "Finished" : "Discarded",
      endedAt: at(3600),
    });
    expect(restRemainingSeconds(ended, at(700))).toBeNull();

    const later: ReadonlyArray<WorkoutCommand> = [
      { _tag: "AddSet", entryId: "e1", setId: "s9", kind: "normal" },
      { _tag: "CompleteSet", setId: "s3", at: at(4000) },
      { _tag: "RemoveExercise", entryId: "e1" },
      { _tag: "Finish", at: at(9000) },
      { _tag: "Discard", at: at(9000) },
    ];
    expect(log(later, ended)).toEqual(ended);
  });
});
