import { Schema } from "effect";

import {
  Equipment,
  type Exercise,
  ExerciseCategory,
  type ExerciseCategory as Category,
  Muscle,
  type Source,
} from "./schema.ts";
import { linkParam, linkParams } from "./link-params.ts";

export const MUSCLE_LABEL: Readonly<Record<Muscle, string>> = {
  abdominals: "Abdominals",
  abductors: "Abductors",
  adductors: "Adductors",
  biceps: "Biceps",
  calves: "Calves",
  cardio: "Cardio",
  chest: "Chest",
  forearms: "Forearms",
  full_body: "Full body",
  glutes: "Glutes",
  hamstrings: "Hamstrings",
  lats: "Lats",
  lower_back: "Lower back",
  neck: "Neck",
  quadriceps: "Quadriceps",
  shoulders: "Shoulders",
  traps: "Traps",
  triceps: "Triceps",
  upper_back: "Upper back",
  other: "Other",
};

export const EQUIPMENT_LABEL: Readonly<Record<Equipment, string>> = {
  none: "None",
  barbell: "Barbell",
  dumbbell: "Dumbbell",
  kettlebell: "Kettlebell",
  machine: "Machine",
  cable: "Cable",
  plate: "Plate",
  band: "Band",
  ez_bar: "EZ bar",
  medicine_ball: "Medicine ball",
  exercise_ball: "Exercise ball",
  foam_roller: "Foam roller",
  suspension: "Suspension",
  other: "Other",
};

export const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  strength: "Strength",
  powerlifting: "Powerlifting",
  olympic_weightlifting: "Olympic weightlifting",
  strongman: "Strongman",
  plyometrics: "Plyometrics",
  stretching: "Stretching",
  cardio: "Cardio",
};

const byLabel = <K extends string>(keys: ReadonlyArray<K>, labels: Readonly<Record<K, string>>) =>
  [...keys]
    .sort((a, b) => (a === "other" ? 1 : b === "other" ? -1 : labels[a] < labels[b] ? -1 : 1))
    .map((value) => ({ value, label: labels[value] }));

/** Picker options sorted by label, with Other last. */
export const MUSCLE_OPTIONS = byLabel(Muscle.literals, MUSCLE_LABEL);
export const EQUIPMENT_OPTIONS = byLabel(Equipment.literals, EQUIPMENT_LABEL);
export const CATEGORY_OPTIONS = byLabel(ExerciseCategory.literals, CATEGORY_LABEL);

export const muscleList = (muscles: ReadonlyArray<Muscle>): string =>
  muscles.map((muscle) => MUSCLE_LABEL[muscle]).join(", ");

/** One line under an exercise's name in a list, such as "Chest, Triceps · Barbell". */
export const exerciseSummary = (
  exercise: Pick<Exercise, "primaryMuscles" | "equipment">,
): string => {
  const muscles = muscleList(exercise.primaryMuscles);
  const equipment =
    exercise.equipment === "none" ? "No equipment" : EQUIPMENT_LABEL[exercise.equipment];
  return muscles === "" ? equipment : `${muscles} · ${equipment}`;
};

export const SOURCE_LABEL: Readonly<Record<Source, string>> = {
  svett: "Custom",
  library: "svett library",
  hevy: "Imported from Hevy",
  apple_health: "Imported from Apple Health",
  gpx: "Imported from a GPX file",
};

/** What the new and edit exercise screens hold while the user fills them in. */
export type ExerciseForm = {
  readonly name: string;
  readonly category: Category;
  readonly equipment: Equipment;
  readonly primaryMuscle: Muscle | null;
  readonly secondaryMuscles: ReadonlyArray<Muscle>;
};

export const EMPTY_EXERCISE_FORM: ExerciseForm = {
  name: "",
  category: "strength",
  equipment: "none",
  primaryMuscle: null,
  secondaryMuscles: [],
};

export const EXERCISE_NAME_MAX_LENGTH = 80;

export type ExerciseFields = Pick<
  Exercise,
  "name" | "category" | "equipment" | "primaryMuscles" | "secondaryMuscles"
>;

export type ExerciseFormResult =
  | { readonly ok: true; readonly fields: ExerciseFields }
  | { readonly ok: false; readonly problem: string };

/**
 * The fields to save, or what is missing. The name is trimmed with its inner spaces
 * collapsed, and the main muscle is not repeated among the other muscles.
 */
export const exerciseFromForm = (form: ExerciseForm): ExerciseFormResult => {
  const name = form.name.trim().replaceAll(/\s+/g, " ");
  if (name === "") return { ok: false, problem: "Give the exercise a name." };
  if (name.length > EXERCISE_NAME_MAX_LENGTH) {
    return { ok: false, problem: `Keep the name to ${EXERCISE_NAME_MAX_LENGTH} characters.` };
  }
  if (form.primaryMuscle === null) return { ok: false, problem: "Choose the main muscle." };
  const primary = form.primaryMuscle;
  return {
    ok: true,
    fields: {
      name,
      category: form.category,
      equipment: form.equipment,
      primaryMuscles: [primary],
      secondaryMuscles: [...new Set(form.secondaryMuscles)].filter((muscle) => muscle !== primary),
    },
  };
};

/** The form for editing an exercise that already exists. */
export const exerciseForm = (exercise: ExerciseFields): ExerciseForm => ({
  name: exercise.name,
  category: exercise.category,
  equipment: exercise.equipment,
  primaryMuscle: exercise.primaryMuscles[0] ?? null,
  secondaryMuscles: [
    ...exercise.primaryMuscles.slice(1),
    ...exercise.secondaryMuscles.filter((muscle) => !exercise.primaryMuscles.includes(muscle)),
  ],
});

/**
 * A new exercise form filled from a link such as
 * svett://exercises/new?name=Landmine%20press&muscle=shoulders&equipment=barbell.
 * A value svett does not know is left at its default.
 */
export const exerciseFormFromParams = (params: unknown): ExerciseForm => {
  const record = linkParams(params);
  return {
    name: linkParam(Schema.String, record["name"]) ?? EMPTY_EXERCISE_FORM.name,
    category: linkParam(ExerciseCategory, record["category"]) ?? EMPTY_EXERCISE_FORM.category,
    equipment: linkParam(Equipment, record["equipment"]) ?? EMPTY_EXERCISE_FORM.equipment,
    primaryMuscle: linkParam(Muscle, record["muscle"]),
    secondaryMuscles: [],
  };
};
