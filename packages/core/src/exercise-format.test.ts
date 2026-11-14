import { describe, expect, it } from "vite-plus/test";

import {
  CATEGORY_OPTIONS,
  EMPTY_EXERCISE_FORM,
  EQUIPMENT_OPTIONS,
  exerciseForm,
  exerciseFormFromParams,
  exerciseFromForm,
  exerciseSummary,
  MUSCLE_OPTIONS,
} from "./exercise-format.ts";
import { Equipment, ExerciseCategory, Muscle } from "./schema.ts";

describe("exercise labels", () => {
  it("offers every muscle, equipment and category once, by label, with Other last", () => {
    expect(MUSCLE_OPTIONS.map((option) => option.value).toSorted()).toEqual(
      [...Muscle.literals].toSorted(),
    );
    expect(EQUIPMENT_OPTIONS).toHaveLength(Equipment.literals.length);
    expect(CATEGORY_OPTIONS).toHaveLength(ExerciseCategory.literals.length);
    expect(MUSCLE_OPTIONS.slice(0, 3).map((option) => option.label)).toEqual([
      "Abdominals",
      "Abductors",
      "Adductors",
    ]);
    expect(MUSCLE_OPTIONS.at(-1)?.label).toBe("Other");
    expect(EQUIPMENT_OPTIONS.at(-1)?.label).toBe("Other");
    expect(EQUIPMENT_OPTIONS.map((option) => option.label)).toContain("EZ bar");
  });

  it("sums up an exercise by its main muscles and equipment", () => {
    expect(exerciseSummary({ primaryMuscles: ["chest", "triceps"], equipment: "barbell" })).toBe(
      "Chest, Triceps · Barbell",
    );
    expect(exerciseSummary({ primaryMuscles: ["lower_back"], equipment: "none" })).toBe(
      "Lower back · No equipment",
    );
    expect(exerciseSummary({ primaryMuscles: [], equipment: "cable" })).toBe("Cable");
  });
});

describe("exerciseFromForm", () => {
  const form = {
    ...EMPTY_EXERCISE_FORM,
    name: "Landmine press",
    primaryMuscle: "shoulders",
  } as const;

  it("trims the name and collapses its inner spaces", () => {
    expect(exerciseFromForm({ ...form, name: "  Landmine \t  press " })).toMatchObject({
      ok: true,
      fields: { name: "Landmine press" },
    });
  });

  it("asks for a name, a short enough name and a main muscle", () => {
    expect(exerciseFromForm({ ...form, name: "   " })).toEqual({
      ok: false,
      problem: "Give the exercise a name.",
    });
    expect(exerciseFromForm({ ...form, name: "x".repeat(81) })).toEqual({
      ok: false,
      problem: "Keep the name to 80 characters.",
    });
    expect(exerciseFromForm({ ...form, name: "x".repeat(80) }).ok).toBe(true);
    expect(exerciseFromForm({ ...form, primaryMuscle: null })).toEqual({
      ok: false,
      problem: "Choose the main muscle.",
    });
  });

  it("keeps the main muscle and repeated muscles out of the other muscles", () => {
    expect(
      exerciseFromForm({
        ...form,
        equipment: "barbell",
        category: "powerlifting",
        secondaryMuscles: ["triceps", "shoulders", "chest", "triceps"],
      }),
    ).toEqual({
      ok: true,
      fields: {
        name: "Landmine press",
        category: "powerlifting",
        equipment: "barbell",
        primaryMuscles: ["shoulders"],
        secondaryMuscles: ["triceps", "chest"],
      },
    });
  });

  it("turns a saved exercise back into the form, and the form into the same fields", () => {
    const fields = {
      name: "Landmine press",
      category: "strength",
      equipment: "barbell",
      primaryMuscles: ["shoulders"],
      secondaryMuscles: ["triceps"],
    } as const;
    expect(exerciseFromForm(exerciseForm(fields))).toEqual({ ok: true, fields });
  });

  it("keeps a library exercise's extra main muscles among the other muscles", () => {
    expect(
      exerciseForm({
        name: "Clean",
        category: "olympic_weightlifting",
        equipment: "barbell",
        primaryMuscles: ["hamstrings", "glutes"],
        secondaryMuscles: ["glutes", "traps"],
      }),
    ).toMatchObject({ primaryMuscle: "hamstrings", secondaryMuscles: ["glutes", "traps"] });
  });
});

describe("exerciseFormFromParams", () => {
  it("fills a new exercise from a link", () => {
    expect(
      exerciseFormFromParams({
        name: "Landmine press",
        muscle: "shoulders",
        equipment: "barbell",
        category: "powerlifting",
      }),
    ).toEqual({
      name: "Landmine press",
      category: "powerlifting",
      equipment: "barbell",
      primaryMuscle: "shoulders",
      secondaryMuscles: [],
    });
  });

  it("leaves a value svett does not know at its default", () => {
    expect(exerciseFormFromParams({ muscle: "wings", equipment: "rope", category: 4 })).toEqual(
      EMPTY_EXERCISE_FORM,
    );
    expect(exerciseFormFromParams(undefined)).toEqual(EMPTY_EXERCISE_FORM);
  });
});
