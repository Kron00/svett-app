import { describe, expect, it } from "vite-plus/test";

import { muscleSplit, wholePercentages } from "./muscle-split.ts";
import type { SetType } from "./schema.ts";

const sets = (...types: ReadonlyArray<SetType>) => types.map((setType) => ({ setType }));

describe("muscleSplit", () => {
  it("counts each working set once for its exercise's main muscle", () => {
    // Bench: 1 warm-up and 3 working sets for chest. Pushdown: 2 sets for triceps.
    const split = muscleSplit([
      { primaryMuscles: ["chest"], sets: sets("warm_up", "normal", "normal", "failure") },
      { primaryMuscles: ["triceps"], sets: sets("normal", "drop") },
    ]);
    expect(split).toEqual([
      { muscle: "chest", sets: 3, percent: 60 },
      { muscle: "triceps", sets: 2, percent: 40 },
    ]);
  });

  it("shares a set equally between several main muscles", () => {
    // Deadlift: 2 sets over lower back and hamstrings, 1 each. Curls: 2 sets for hamstrings.
    const split = muscleSplit([
      { primaryMuscles: ["lower_back", "hamstrings"], sets: sets("normal", "normal") },
      { primaryMuscles: ["hamstrings"], sets: sets("normal", "normal") },
    ]);
    expect(split).toEqual([
      { muscle: "hamstrings", sets: 3, percent: 75 },
      { muscle: "lower_back", sets: 1, percent: 25 },
    ]);
  });

  it("orders ties by muscle and leaves out exercises with no working sets", () => {
    const split = muscleSplit([
      { primaryMuscles: ["triceps"], sets: sets("normal") },
      { primaryMuscles: ["biceps"], sets: sets("normal") },
      { primaryMuscles: ["chest"], sets: sets("warm_up") },
      { primaryMuscles: [], sets: sets("normal") },
    ]);
    expect(split.map((share) => share.muscle)).toEqual(["biceps", "triceps"]);
  });

  it("is empty for a workout with no sets", () => {
    expect(muscleSplit([])).toEqual([]);
  });
});

describe("wholePercentages", () => {
  it("adds up to 100 when thirds would round to 99", () => {
    expect(wholePercentages([1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("gives leftover points to the largest remainders", () => {
    // 2/7 = 28.57, 2/7 = 28.57, 3/7 = 42.86: floors 28, 28, 42 leave 2 points.
    expect(wholePercentages([2, 2, 3])).toEqual([29, 28, 43]);
  });

  it("is all zero when nothing was counted", () => {
    expect(wholePercentages([0, 0])).toEqual([0, 0]);
  });
});
