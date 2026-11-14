import { describe, expect, it } from "vite-plus/test";

import { DurationSeconds } from "./duration.ts";
import { libraryExerciseId } from "./exercise-library.ts";
import type { RoutineDetail } from "./repositories/routines.ts";
import {
  addExercises,
  addSet,
  copyTitle,
  EMPTY_TARGET,
  endPosition,
  exerciseNamesSummary,
  moveExercise,
  moveItem,
  newRoutineForm,
  removeExercise,
  removeSet,
  replaceSet,
  routineForm,
  routineFromForm,
  routineSections,
  setTargetEntry,
  setTargetFromEntry,
  setTargetText,
  workoutFromRoutine,
} from "./routine-plan.ts";
import {
  EpochMillis,
  type Folder,
  FolderId,
  type Routine,
  RoutineExerciseId,
  RoutineId,
  RoutineSetId,
} from "./schema.ts";

const uuid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = EpochMillis.make(0);

const folder = (n: number, name: string, position: number): Folder => ({
  id: FolderId.make(uuid(n)),
  updatedAt: at,
  deletedAt: null,
  name,
  position,
});

const routine = (
  n: number,
  title: string,
  position: number,
  folderId: FolderId | null,
): Routine => ({
  id: RoutineId.make(uuid(n)),
  updatedAt: at,
  deletedAt: null,
  folderId,
  title,
  notes: "",
  position,
});

const bench = libraryExerciseId("Barbell_Bench_Press_-_Medium_Grip");
const raise = libraryExerciseId("Side_Lateral_Raise");
const plank = libraryExerciseId("Plank");

describe("routine order", () => {
  it("puts a new row after the last one", () => {
    expect(endPosition([])).toBe(0);
    expect(endPosition([{ position: 0 }, { position: 4 }, { position: 2 }])).toBe(5);
  });

  it("moves one item and leaves the rest in order", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveItem(["a", "b"], 1, 2)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], -1, 0)).toEqual(["a", "b"]);
  });

  it("names a copy after the routine and skips names already taken", () => {
    expect(copyTitle("Push", ["Push"])).toBe("Push copy");
    expect(copyTitle("Push", ["Push", "Push copy", "Push copy 2"])).toBe("Push copy 3");
  });
});

describe("routineSections", () => {
  const program = folder(1, "Program", 1);
  const extras = folder(2, "Extras", 0);

  it("lists routines in no folder first, then each folder in its order", () => {
    const sections = routineSections(
      [program, extras],
      [
        routine(10, "Pull", 1, program.id),
        routine(11, "Push", 0, program.id),
        routine(12, "Stretch", 0, null),
        routine(13, "Core", 0, extras.id),
      ],
    );
    expect(
      sections.map((section) => [
        section.folder?.name ?? null,
        section.routines.map((r) => r.title),
      ]),
    ).toEqual([
      [null, ["Stretch"]],
      ["Extras", ["Core"]],
      ["Program", ["Push", "Pull"]],
    ]);
  });

  it("shows no empty loose section once folders exist, and keeps empty folders", () => {
    expect(routineSections([program], []).map((section) => section.folder?.name)).toEqual([
      "Program",
    ]);
    expect(routineSections([], [])).toEqual([{ folder: null, routines: [] }]);
  });

  it("counts a routine whose folder is missing as in no folder", () => {
    const orphan = routine(20, "Legs", 0, FolderId.make(uuid(99)));
    expect(routineSections([program], [orphan])[0]).toEqual({ folder: null, routines: [orphan] });
  });
});

describe("routine text", () => {
  it("lists up to three exercise names and counts the rest", () => {
    expect(exerciseNamesSummary([])).toBe("No exercises");
    expect(exerciseNamesSummary(["Squat", "Bench Press"])).toBe("Squat, Bench Press");
    expect(exerciseNamesSummary(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });

  it("shows a set's target and reads it out in words", () => {
    const target = { ...EMPTY_TARGET, weightKg: 62.5, repsMin: 8, repsMax: 12 };
    expect(setTargetText(target)).toEqual({
      text: "62.5 kg × 8-12 reps",
      label: "62.5 kg, 8 to 12 reps",
    });
    expect(setTargetText({ ...EMPTY_TARGET, repsMin: 1, repsMax: 1 }).text).toBe("1 rep");
    expect(setTargetText({ ...EMPTY_TARGET, repsMin: 5, repsMax: null })).toEqual({
      text: "5+ reps",
      label: "5 or more reps",
    });
    expect(setTargetText({ ...EMPTY_TARGET, durationS: DurationSeconds.make(45) })).toEqual({
      text: "0:45",
      label: "45 seconds",
    });
    expect(setTargetText(EMPTY_TARGET)).toEqual({ text: "No target", label: "No target" });
  });
});

describe("workoutFromRoutine", () => {
  it("starts the routine's exercises in order with every set filled in from its target", () => {
    const routineId = RoutineId.make(uuid(1));
    const exercise = (n: number, exerciseId: typeof bench, notes: string) => ({
      id: RoutineExerciseId.make(uuid(n)),
      updatedAt: at,
      deletedAt: null,
      routineId,
      exerciseId,
      position: n,
      supersetGroup: null,
      restS: DurationSeconds.make(90),
      notes,
    });
    const set = (n: number, target: Partial<typeof EMPTY_TARGET>) => ({
      ...EMPTY_TARGET,
      ...target,
      id: RoutineSetId.make(uuid(100 + n)),
      updatedAt: at,
      deletedAt: null,
      routineExerciseId: RoutineExerciseId.make(uuid(1)),
      position: n,
    });
    const detail: RoutineDetail = {
      routine: routine(1, "Push", 0, null),
      exercises: [
        {
          exercise: exercise(1, bench, "Pause on the chest"),
          sets: [
            set(0, { setType: "warm_up", weightKg: 40, repsMin: 10, repsMax: 10 }),
            set(1, { weightKg: 80, repsMin: 5, repsMax: 8 }),
          ],
        },
        {
          exercise: exercise(2, plank, ""),
          sets: [set(2, { durationS: DurationSeconds.make(60) })],
        },
      ],
    };

    expect(workoutFromRoutine(detail)).toEqual({
      title: "Push",
      routineId,
      exercises: [
        {
          exerciseId: bench,
          supersetGroup: null,
          notes: "Pause on the chest",
          sets: [
            {
              setType: "warm_up",
              weightKg: 40,
              reps: 10,
              durationS: null,
              distanceM: null,
              targetRepsMin: 10,
              targetRepsMax: 10,
            },
            {
              setType: "normal",
              weightKg: 80,
              reps: null,
              durationS: null,
              distanceM: null,
              targetRepsMin: 5,
              targetRepsMax: 8,
            },
          ],
        },
        {
          exerciseId: plank,
          supersetGroup: null,
          notes: "",
          sets: [
            {
              setType: "normal",
              weightKg: null,
              reps: null,
              durationS: 60,
              distanceM: null,
              targetRepsMin: null,
              targetRepsMax: null,
            },
          ],
        },
      ],
    });
  });
});

describe("routine form", () => {
  it("builds a routine from added exercises and their sets", () => {
    let form = addExercises(newRoutineForm(" Push day "), [bench, raise]);
    form = replaceSet(form, 0, 0, { ...EMPTY_TARGET, weightKg: 60, repsMin: 8, repsMax: 12 });
    form = addSet(addSet(form, 0), 0);
    form = moveExercise(form, 1, 0);

    const result = routineFromForm(form);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routine.title).toBe("Push day");
    expect(result.routine.exercises.map((exercise) => exercise.exerciseId)).toEqual([raise, bench]);
    expect(result.routine.exercises[1]?.sets).toEqual(
      Array.from({ length: 3 }, () => ({ ...EMPTY_TARGET, weightKg: 60, repsMin: 8, repsMax: 12 })),
    );
    expect(result.routine.exercises[0]?.sets).toEqual([EMPTY_TARGET]);
  });

  it("keeps each exercise's key while exercises move and are removed", () => {
    const form = addExercises(newRoutineForm(), [bench, raise, plank]);
    expect(form.exercises.map((exercise) => exercise.key)).toEqual([0, 1, 2]);
    const changed = removeExercise(moveExercise(form, 2, 0), 1);
    expect(changed.exercises.map((exercise) => [exercise.key, exercise.exerciseId])).toEqual([
      [2, plank],
      [1, raise],
    ]);
    expect(addExercises(changed, [bench]).exercises.at(-1)?.key).toBe(3);
  });

  it("removes one set", () => {
    const form = addSet(
      replaceSet(addExercises(newRoutineForm("Push"), [bench]), 0, 0, {
        ...EMPTY_TARGET,
        repsMin: 5,
        repsMax: 5,
      }),
      0,
    );
    const changed = replaceSet(form, 0, 1, { ...EMPTY_TARGET, repsMin: 3, repsMax: 3 });
    expect(removeSet(changed, 0, 0).exercises[0]?.sets.map((set) => set.repsMin)).toEqual([3]);
  });

  it("asks for a name and at least one exercise", () => {
    expect(routineFromForm(addExercises(newRoutineForm("  "), [bench]))).toEqual({
      ok: false,
      error: "Give the routine a name.",
    });
    expect(routineFromForm(newRoutineForm("Push"))).toEqual({
      ok: false,
      error: "Add at least one exercise.",
    });
  });

  it("opens a saved routine for editing and saves it back unchanged", () => {
    const detail: RoutineDetail = {
      routine: { ...routine(1, "Legs", 2, FolderId.make(uuid(5))), notes: "Heavy" },
      exercises: [
        {
          exercise: {
            id: RoutineExerciseId.make(uuid(2)),
            updatedAt: at,
            deletedAt: null,
            routineId: RoutineId.make(uuid(1)),
            exerciseId: bench,
            position: 0,
            supersetGroup: 1,
            restS: DurationSeconds.make(120),
            notes: "Slow",
          },
          sets: [
            {
              ...EMPTY_TARGET,
              distanceM: 20,
              id: RoutineSetId.make(uuid(3)),
              updatedAt: at,
              deletedAt: null,
              routineExerciseId: RoutineExerciseId.make(uuid(2)),
              position: 0,
            },
          ],
        },
      ],
    };
    expect(routineFromForm(routineForm(detail))).toEqual({
      ok: true,
      routine: {
        title: "Legs",
        notes: "Heavy",
        folderId: uuid(5),
        exercises: [
          {
            exerciseId: bench,
            supersetGroup: 1,
            restS: 120,
            notes: "Slow",
            sets: [{ ...EMPTY_TARGET, distanceM: 20 }],
          },
        ],
      },
    });
  });
});

describe("set target entry", () => {
  it("reads one rep count as an exact target and two as a range", () => {
    const entry = { setType: "normal" as const, weight: "60", repsFrom: "8", repsTo: "" };
    expect(setTargetFromEntry(entry, EMPTY_TARGET)).toEqual({
      ...EMPTY_TARGET,
      weightKg: 60,
      repsMin: 8,
      repsMax: 8,
    });
    expect(setTargetFromEntry({ ...entry, repsTo: "12" }, EMPTY_TARGET)).toMatchObject({
      repsMin: 8,
      repsMax: 12,
    });
    expect(setTargetFromEntry({ ...entry, repsFrom: "", repsTo: "6" }, EMPTY_TARGET)).toMatchObject(
      {
        repsMin: 6,
        repsMax: 6,
      },
    );
  });

  it("turns a range typed high to low round and clears empty fields", () => {
    expect(
      setTargetFromEntry(
        { setType: "drop", weight: "", repsFrom: "12", repsTo: "8" },
        { ...EMPTY_TARGET, weightKg: 50, durationS: DurationSeconds.make(30) },
      ),
    ).toEqual({
      ...EMPTY_TARGET,
      setType: "drop",
      weightKg: null,
      repsMin: 8,
      repsMax: 12,
      durationS: 30,
    });
  });

  it("fills the fields from a saved target and gives the same target back", () => {
    const exact = { ...EMPTY_TARGET, weightKg: 82.5, repsMin: 5, repsMax: 5 };
    expect(setTargetEntry(exact)).toEqual({
      setType: "normal",
      weight: "82.5",
      repsFrom: "5",
      repsTo: "",
    });
    expect(setTargetFromEntry(setTargetEntry(exact), exact)).toEqual(exact);
    const range = { ...EMPTY_TARGET, repsMin: 8, repsMax: 12 };
    expect(setTargetFromEntry(setTargetEntry(range), range)).toEqual(range);
  });
});
