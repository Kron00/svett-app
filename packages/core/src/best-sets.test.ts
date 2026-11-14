import { describe, expect, it } from "vite-plus/test";

import { exerciseSessions, rankBestSets } from "./best-sets.ts";
import type { LoggedSet } from "./repositories/training.ts";
import { type ActivityId, EpochMillis, type SetType } from "./schema.ts";

const set = (
  workout: number,
  position: number,
  setType: SetType,
  weightKg: number | null,
  reps: number | null,
  durationS: number | null = null,
): LoggedSet => ({
  activityId: `00000000-0000-7000-8000-00000000000${workout}` as ActivityId,
  title: `Workout ${workout}`,
  startedAt: EpochMillis.make(workout * 86_400_000),
  position,
  setType,
  weightKg,
  reps,
  durationS,
  distanceM: null,
  rpe: null,
});

describe("rankBestSets", () => {
  it("ranks the heaviest working set first, then more reps, then the earlier one", () => {
    const sets = [
      set(1, 0, "warm_up", 200, 1),
      set(1, 1, "normal", 100, 5),
      set(2, 0, "normal", 100, 6),
      set(3, 0, "failure", 102.5, 3),
      set(3, 1, "normal", 100, 6),
    ];
    expect(rankBestSets(sets, 3)).toEqual([sets[3], sets[2], sets[4]]);
  });

  it("counts a weight only from a set of at least one rep, as the heaviest weight record does", () => {
    const sets = [
      set(1, 0, "failure", 150, 0),
      set(1, 1, "normal", 160, null, 30),
      set(1, 2, "normal", 140, 5),
    ];
    expect(rankBestSets(sets, 3)).toEqual([sets[2]]);
  });

  it("ranks sets with no weight by reps", () => {
    const sets = [
      set(1, 0, "normal", null, 8),
      set(1, 1, "normal", null, 12),
      set(2, 0, "warm_up", null, 20),
    ];
    expect(rankBestSets(sets, 1)).toEqual([sets[1]]);
  });

  it("finds nothing among warm-ups alone", () => {
    expect(rankBestSets([set(1, 0, "warm_up", 60, 5)], 3)).toEqual([]);
  });
});

describe("exerciseSessions", () => {
  it("gives each workout its top set, working sets, reps and volume, newest first", () => {
    const sessions = exerciseSessions([
      set(1, 0, "warm_up", 50, 5),
      set(1, 1, "normal", 100, 5),
      set(1, 2, "normal", 100, 4),
      set(2, 0, "normal", 105, 3),
    ]);
    expect(
      sessions.map(({ title, workingSets, totalReps, volumeKg, topSet }) => [
        title,
        workingSets,
        totalReps,
        volumeKg,
        topSet?.weightKg,
      ]),
    ).toEqual([
      ["Workout 2", 1, 3, 315, 105],
      ["Workout 1", 2, 9, 900, 100],
    ]);
  });
});
