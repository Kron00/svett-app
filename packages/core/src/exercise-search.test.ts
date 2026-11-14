import { describe, expect, it } from "vite-plus/test";

import { exerciseLibrary } from "./exercise-library.ts";
import {
  exerciseFilterFromParams,
  exerciseFilterParams,
  foldText,
  NO_FILTER,
  searchExercises,
} from "./exercise-search.ts";
import { type Equipment, ExerciseId, type Muscle } from "./schema.ts";

let next = 0;
const exercise = (
  name: string,
  equipment: Equipment = "barbell",
  primaryMuscles: ReadonlyArray<Muscle> = ["chest"],
) => ({
  id: ExerciseId.make(`00000000-0000-7000-8000-${String(++next).padStart(12, "0")}`),
  name,
  equipment,
  primaryMuscles,
});

const names = (found: ReadonlyArray<{ readonly name: string }>) => found.map((e) => e.name);
const search = (
  exercises: ReadonlyArray<ReturnType<typeof exercise>>,
  text: string,
  filters: { muscle?: Muscle; equipment?: Equipment } = {},
) =>
  names(
    searchExercises(exercises, {
      text,
      muscle: filters.muscle ?? null,
      equipment: filters.equipment ?? null,
    }),
  );

describe("foldText", () => {
  it("ignores case, accents and punctuation", () => {
    expect(foldText("  Développé  Couché - Barre ")).toBe("developpe couche barre");
    expect(foldText("Hip-Thrust (Smith)")).toBe("hip thrust smith");
  });

  it("spells out letters that have no accent to strip", () => {
    expect(foldText("Søt Ærlig Straße")).toBe("sot aerlig strasse");
  });
});

describe("searchExercises", () => {
  it("finds an exercise in the bundled library", () => {
    const library = exerciseLibrary();
    expect(search(library, "bench press").slice(0, 3)).toEqual([
      "Bench Press - With Bands",
      "Bench Press with Chains",
      "Bench Press - Powerlifting",
    ]);
    expect(search(library, "barbell squat")[0]).toBe("Barbell Squat");
    expect(search(library, "chin up")).toContain("Chin-Up");
  });

  it("ranks the whole name, then its start, then a later word, then words anywhere", () => {
    const exercises = [
      exercise("Incline Bench Press"),
      exercise("Press Bench"),
      exercise("Bench Press Machine"),
      exercise("Bench Press"),
      exercise("Benchpress Holds"),
    ];
    expect(search(exercises, "bench press")).toEqual([
      "Bench Press",
      "Bench Press Machine",
      "Incline Bench Press",
      "Press Bench",
      "Benchpress Holds",
    ]);
  });

  it("puts the shorter name first among equal matches, then sorts by name", () => {
    const exercises = [exercise("Squat Jump Long"), exercise("Squat Hold"), exercise("Squat Bar")];
    expect(search(exercises, "squat")).toEqual(["Squat Bar", "Squat Hold", "Squat Jump Long"]);
  });

  it("matches with or without the spaces and hyphens a name uses", () => {
    const exercises = [exercise("Pull-Up"), exercise("Pullups"), exercise("Push Up")];
    expect(search(exercises, "pullup")).toEqual(["Pull-Up", "Pullups"]);
    expect(search(exercises, "pull up")).toEqual(["Pull-Up", "Pullups"]);
    expect(search(exercises, "PUSH-UP")).toEqual(["Push Up"]);
  });

  it("matches a query typed with accents or without them", () => {
    const exercises = [exercise("Développé couché"), exercise("Squat")];
    expect(search(exercises, "developpe")).toEqual(["Développé couché"]);
    expect(search(exercises, "DÉVELOPPÉ")).toEqual(["Développé couché"]);
  });

  it("finds nothing for words that are not in any name", () => {
    expect(search([exercise("Bench Press")], "bench curl")).toEqual([]);
  });

  it("filters by primary muscle and equipment, together with the text", () => {
    const exercises = [
      exercise("Dumbbell Press", "dumbbell", ["chest"]),
      exercise("Barbell Press", "barbell", ["chest"]),
      exercise("Military Press", "barbell", ["shoulders"]),
      exercise("Close-Grip Press", "barbell", ["triceps", "chest"]),
      exercise("Fly", "cable", ["chest"]),
    ];
    expect(search(exercises, "", { muscle: "chest" })).toEqual([
      "Barbell Press",
      "Close-Grip Press",
      "Dumbbell Press",
      "Fly",
    ]);
    expect(search(exercises, "press", { muscle: "chest", equipment: "barbell" })).toEqual([
      "Barbell Press",
      "Close-Grip Press",
    ]);
    expect(search(exercises, "", { equipment: "barbell" })).toEqual([
      "Barbell Press",
      "Close-Grip Press",
      "Military Press",
    ]);
    expect(search(exercises, "", { muscle: "lats" })).toEqual([]);
  });

  it("lists every exercise by name when there is no text or filter", () => {
    const exercises = [exercise("b"), exercise("C"), exercise("a")];
    expect(names(searchExercises(exercises, NO_FILTER))).toEqual(["a", "b", "C"]);
  });

  it("keeps a whole library search fast enough to run on every keystroke", () => {
    const library = exerciseLibrary();
    const start = performance.now();
    for (const text of ["b", "be", "ben", "benc", "bench", "bench p", "bench press"]) {
      searchExercises(library, { ...NO_FILTER, text });
    }
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("exercise filter links", () => {
  it("reads the text, muscle and equipment from a link", () => {
    expect(exerciseFilterFromParams({ q: "bench", muscle: "chest", equipment: "barbell" })).toEqual(
      { text: "bench", muscle: "chest", equipment: "barbell" },
    );
  });

  it("drops a value svett does not know and keeps the rest", () => {
    expect(exerciseFilterFromParams({ q: "row", muscle: "wings", equipment: 3 })).toEqual({
      text: "row",
      muscle: null,
      equipment: null,
    });
    expect(exerciseFilterFromParams(undefined)).toEqual(NO_FILTER);
  });

  it("writes back only the parts that are set", () => {
    expect(exerciseFilterParams(NO_FILTER)).toEqual({
      q: undefined,
      muscle: undefined,
      equipment: undefined,
    });
    const filter = { text: "row", muscle: "lats", equipment: "cable" } as const;
    expect(exerciseFilterFromParams(exerciseFilterParams(filter))).toEqual(filter);
  });
});
