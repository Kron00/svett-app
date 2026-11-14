import { describe, expect, it } from "vite-plus/test";

import {
  describeMuscleSets,
  type ExerciseMuscles,
  formatSetCount,
  muscleSets,
  weeklyMuscleSets,
} from "./muscle-volume.ts";
import { startOfWeek } from "./progress-dates.ts";
import type { ExerciseId } from "./schema.ts";
import { BENCH, DIPS, PLANK, SQUAT, workoutSets } from "./test-sets.ts";

const MUSCLES = new Map<ExerciseId, ExerciseMuscles>([
  [BENCH, { primaryMuscles: ["chest"], secondaryMuscles: ["shoulders", "triceps"] }],
  [DIPS, { primaryMuscles: ["triceps"], secondaryMuscles: ["chest", "shoulders"] }],
  [SQUAT, { primaryMuscles: ["quadriceps"], secondaryMuscles: ["glutes", "hamstrings"] }],
]);
const musclesOf = (id: ExerciseId) => MUSCLES.get(id);

const monday = workoutSets(31, new Date(2026, 0, 5, 18), [
  { exercise: BENCH, type: "warm_up", kg: 40, reps: 10 },
  { exercise: BENCH, kg: 80, reps: 5 },
  { exercise: BENCH, kg: 80, reps: 5 },
  { exercise: BENCH, kg: 80, reps: 5 },
  { exercise: BENCH, type: "failure", kg: 80, reps: 4 },
  { exercise: DIPS, reps: 10 },
  { exercise: DIPS, reps: 10 },
  { exercise: DIPS, type: "drop", reps: 8 },
]);
const sundayNight = workoutSets(32, new Date(2026, 0, 11, 23, 30), [
  { exercise: SQUAT, kg: 100, reps: 5 },
  { exercise: SQUAT, kg: 100, reps: 5 },
  { exercise: PLANK, seconds: 60 },
]);
const nextMonday = workoutSets(33, new Date(2026, 0, 12, 0, 0), [
  { exercise: BENCH, kg: 80, reps: 5 },
]);
const thirdWeek = workoutSets(34, new Date(2026, 0, 21, 7), [
  { exercise: DIPS, reps: 12 },
  { exercise: DIPS, reps: 12 },
]);
const history = [...monday, ...sundayNight, ...nextMonday, ...thirdWeek];

describe("muscleSets", () => {
  it("matches the week counted by hand", () => {
    // Bench: 4 working sets, the warm-up left out. Dips: 3 sets, the drop set included.
    // Chest 4 + 3 × ½ = 5.5. Triceps 3 + 4 × ½ = 5. Shoulders (4 + 3) × ½ = 3.5.
    // Squat: 2 sets. Quadriceps 2, glutes and hamstrings 1 each. The plank has no muscles here.
    const week = [...monday, ...sundayNight];
    expect(muscleSets(week, musclesOf)).toEqual([
      { muscle: "chest", sets: 5.5, primarySets: 4, secondarySets: 3 },
      { muscle: "triceps", sets: 5, primarySets: 3, secondarySets: 4 },
      { muscle: "shoulders", sets: 3.5, primarySets: 0, secondarySets: 7 },
      { muscle: "quadriceps", sets: 2, primarySets: 2, secondarySets: 0 },
      { muscle: "glutes", sets: 1, primarySets: 0, secondarySets: 2 },
      { muscle: "hamstrings", sets: 1, primarySets: 0, secondarySets: 2 },
    ]);
  });

  it("counts a muscle listed as both primary and secondary once, as primary", () => {
    const doubled = new Map<ExerciseId, ExerciseMuscles>([
      [BENCH, { primaryMuscles: ["chest"], secondaryMuscles: ["chest", "triceps"] }],
    ]);
    expect(muscleSets(nextMonday, (id) => doubled.get(id))).toEqual([
      { muscle: "chest", sets: 1, primarySets: 1, secondarySets: 0 },
      { muscle: "triceps", sets: 0.5, primarySets: 0, secondarySets: 1 },
    ]);
  });
});

describe("weeklyMuscleSets", () => {
  it("counts each Monday-to-Sunday week, with 0 for a week without sets", () => {
    const thirdMonday = startOfWeek(new Date(2026, 0, 19).getTime());
    expect(weeklyMuscleSets(history, musclesOf, "chest", thirdMonday, 4)).toEqual([
      { weekStart: new Date(2025, 11, 29).getTime(), sets: 0 },
      { weekStart: new Date(2026, 0, 5).getTime(), sets: 5.5 },
      { weekStart: new Date(2026, 0, 12).getTime(), sets: 1 },
      { weekStart: thirdMonday, sets: 1 },
    ]);
  });
});

describe("set count text", () => {
  it("shows halves and what they are made of", () => {
    expect(formatSetCount(36.5)).toBe("36.5");
    expect(formatSetCount(12)).toBe("12");
    expect(
      describeMuscleSets({ muscle: "chest", sets: 5.5, primarySets: 4, secondarySets: 3 }),
    ).toBe("4 primary, 3 secondary at ½");
    expect(
      describeMuscleSets({ muscle: "glutes", sets: 1, primarySets: 0, secondarySets: 2 }),
    ).toBe("2 secondary at ½");
  });
});
